import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createApp } from "../server.mjs";
import { createPool, migrate } from "../db/client.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonRequest(body, cookie, headers = {}) {
  return {
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  };
}

test("persists authenticated sessions, changeable guest votes, history, and soft deletion", async (t) => {
  const schema = `instantvote_test_${crypto.randomBytes(6).toString("hex")}`;
  const pool = await createPool({ schema });
  await migrate(pool, schema);
  const app = createApp({ pool, sessionDays: 1 });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${base}${path}`, options);

  assert.equal((await request("/api/sessions")).status, 401);

  for (const username of ["has spaces", "has.dot", "has@symbol"]) {
    const rejected = await request("/api/auth/register", {
      method: "POST",
      ...jsonRequest({ username, password: "a-safe-test-password" }),
    });
    assert.equal(rejected.status, 400);
  }

  const registration = await request("/api/auth/register", {
    method: "POST",
    ...jsonRequest({ username: "test_admin-2", password: "a-safe-test-password" }),
  });
  assert.equal(registration.status, 201);
  let cookie = registration.headers.get("set-cookie").split(";", 1)[0];
  const account = await registration.json();
  assert.match(account.user.id, UUID_PATTERN);
  assert.equal(account.user.username, "test_admin-2");
  assert.equal(account.user.password, undefined);
  assert.equal(account.user.email, undefined);

  const userColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'`,
    [schema],
  );
  assert.equal(userColumns.rows.some((column) => column.column_name === "email"), false);

  const storedUser = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [account.user.id]);
  assert.match(storedUser.rows[0].password_hash, /^\$2[aby]\$/);
  const storedLogin = await pool.query(`SELECT token_hash FROM admin_sessions WHERE user_id = $1`, [account.user.id]);
  assert.equal(storedLogin.rows[0].token_hash.length, 64);
  assert.notEqual(storedLogin.rows[0].token_hash, cookie.split("=")[1]);

  assert.equal((await request("/api/auth/logout", { method: "POST", headers: { cookie } })).status, 204);
  const login = await request("/api/auth/login", {
    method: "POST",
    ...jsonRequest({ username: "test_admin-2", password: "a-safe-test-password" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await login.json()).user.email, undefined);

  const createdResponse = await request("/api/sessions", { method: "POST", ...jsonRequest({}, cookie) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.id, UUID_PATTERN);

  const detailResponse = await request(`/api/sessions/${created.id}`, { headers: { cookie } });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.options.length, 3);
  assert.match(detail.options[0].id, UUID_PATTERN);
  assert.match(detail.qrCode, /^data:image\/png;base64,/);
  assert.equal(detail.votingUrl, `${base}/vote/${created.id}`);

  const reorderedOptions = [detail.options[2], detail.options[0], detail.options[1]].map((option, index) => ({
    id: option.id,
    text: `Answer ${index + 1}`,
  }));
  const updateResponse = await request(`/api/sessions/${created.id}`, {
    method: "PATCH",
    ...jsonRequest({ question: "Which answer?", options: reorderedOptions, live: true }, cookie),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await request(`/api/sessions/${created.id}`, { headers: { cookie } }).then((response) => response.json());
  assert.deepEqual(updated.options.map((option) => option.id), reorderedOptions.map((option) => option.id));

  const secondSession = await request("/api/sessions", { method: "POST", ...jsonRequest({}, cookie) }).then((response) => response.json());
  const secondDetail = await request(`/api/sessions/${secondSession.id}`, { headers: { cookie } }).then((response) => response.json());
  const foreignAnswerResponse = await request(`/api/sessions/${secondSession.id}`, {
    method: "PATCH",
    ...jsonRequest({
      question: "Keep session answers isolated?",
      live: true,
      options: [reorderedOptions[0], secondDetail.options[0]],
    }, cookie),
  });
  assert.equal(foreignAnswerResponse.status, 400);

  const guestId = crypto.randomUUID();
  const vote = (optionId) => request(`/api/vote/${created.id}`, {
    method: "POST",
    ...jsonRequest({ optionId, guestId }),
  });
  assert.equal((await vote(reorderedOptions[0].id)).status, 200);
  assert.equal((await vote(reorderedOptions[1].id)).status, 200);

  const results = await request(`/api/sessions/${created.id}/results`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(results.totalVotes, 1);
  assert.equal(results.options[0].votes, 0);
  assert.equal(results.options[1].votes, 1);
  assert.equal(results.options[1].percentage, 100);

  const history = await request("/api/voting-history", { headers: { "x-guest-id": guestId } }).then((response) => response.json());
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, created.id);
  assert.equal(history[0].answerId, reorderedOptions[1].id);
  assert.equal(history[0].answerText, "Answer 2");

  const deletion = await request(`/api/sessions/${created.id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(deletion.status, 204);
  assert.equal((await request(`/api/vote/${created.id}`)).status, 404);
  const deletedRow = await pool.query(`SELECT deleted_at, is_open FROM vote_sessions WHERE id = $1`, [created.id]);
  assert.ok(deletedRow.rows[0].deleted_at);
  assert.equal(deletedRow.rows[0].is_open, false);
  const deletedHistory = await request("/api/voting-history", { headers: { "x-guest-id": guestId } }).then((response) => response.json());
  assert.equal(deletedHistory[0].sessionAvailable, false);

  assert.equal((await request("/api/auth/logout", { method: "POST", headers: { cookie } })).status, 204);
  assert.equal((await request("/api/auth/me", { headers: { cookie } })).status, 401);
});
