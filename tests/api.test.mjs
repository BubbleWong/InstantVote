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

test("serves the documented REST API and persists its resources", async (t) => {
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

  const specificationResponse = await request("/openapi.json");
  assert.equal(specificationResponse.status, 200);
  assert.equal((await specificationResponse.json()).openapi, "3.1.0");
  assert.equal((await request("/api-docs")).status, 200);

  const unknownApi = await request("/api/v1/not-a-resource");
  assert.equal(unknownApi.status, 404);
  assert.match(unknownApi.headers.get("content-type"), /application\/json/);
  assert.equal((await unknownApi.json()).error, "API resource not found");
  assert.equal((await request("/api/sessions")).status, 404);
  assert.equal((await request("/api/v1/voting-sessions")).status, 401);

  for (const username of ["has spaces", "has.dot", "has@symbol"]) {
    const rejected = await request("/api/v1/users", {
      method: "POST",
      ...jsonRequest({ username, password: "a-safe-test-password" }),
    });
    assert.equal(rejected.status, 400);
  }

  const registration = await request("/api/v1/users", {
    method: "POST",
    ...jsonRequest({ username: "test_admin-2", password: "a-safe-test-password" }),
  });
  assert.equal(registration.status, 201);
  let cookie = registration.headers.get("set-cookie").split(";", 1)[0];
  const account = await registration.json();
  assert.match(account.id, UUID_PATTERN);
  assert.equal(registration.headers.get("location"), `/api/v1/users/${account.id}`);
  assert.equal(account.username, "test_admin-2");
  assert.equal(account.password, undefined);

  const userResponse = await request(`/api/v1/users/${account.id}`, { headers: { cookie } });
  assert.equal(userResponse.status, 200);
  assert.equal((await userResponse.json()).username, "test_admin-2");

  const currentRegistrationSession = await request("/api/v1/login-sessions/current", { headers: { cookie } });
  assert.equal(currentRegistrationSession.status, 200);
  assert.match((await currentRegistrationSession.json()).id, UUID_PATTERN);

  const userColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'`,
    [schema],
  );
  assert.equal(userColumns.rows.some((column) => column.column_name === "email"), false);
  const storedUser = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [account.id]);
  assert.match(storedUser.rows[0].password_hash, /^\$2[aby]\$/);

  assert.equal((await request("/api/v1/login-sessions/current", { method: "DELETE", headers: { cookie } })).status, 204);
  const login = await request("/api/v1/login-sessions", {
    method: "POST",
    ...jsonRequest({ username: "test_admin-2", password: "a-safe-test-password" }),
  });
  assert.equal(login.status, 201);
  assert.equal(login.headers.get("location"), "/api/v1/login-sessions/current");
  cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const loginBody = await login.json();
  assert.match(loginBody.id, UUID_PATTERN);
  assert.equal(loginBody.user.username, "test_admin-2");

  const createdResponse = await request("/api/v1/voting-sessions", { method: "POST", headers: { cookie } });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.id, UUID_PATTERN);
  assert.equal(createdResponse.headers.get("location"), `/api/v1/voting-sessions/${created.id}`);

  const collection = await request("/api/v1/voting-sessions", { headers: { cookie } }).then((response) => response.json());
  assert.equal(collection.length, 1);
  assert.equal(collection[0].id, created.id);

  const detailResponse = await request(`/api/v1/voting-sessions/${created.id}`, { headers: { cookie } });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.options.length, 3);
  assert.equal(detail.optionsCount, 3);
  assert.match(detail.options[0].id, UUID_PATTERN);
  assert.match(detail.qrCode, /^data:image\/png;base64,/);
  assert.equal(detail.votingUrl, `${base}/vote/${created.id}`);

  const reorderedOptions = [detail.options[2], detail.options[0], detail.options[1]].map((option, index) => ({
    id: option.id,
    text: `Answer ${index + 1}`,
  }));
  const updateResponse = await request(`/api/v1/voting-sessions/${created.id}`, {
    method: "PUT",
    ...jsonRequest({ question: "Which answer?", options: reorderedOptions, live: true }, cookie),
  });
  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json();
  assert.match(updateBody.createdAt, /T/);
  assert.match(updateBody.updatedAt, /T/);
  const updated = await request(`/api/v1/voting-sessions/${created.id}`, { headers: { cookie } }).then((response) => response.json());
  assert.deepEqual(updated.options.map((option) => option.id), reorderedOptions.map((option) => option.id));

  const secondSession = await request("/api/v1/voting-sessions", { method: "POST", headers: { cookie } }).then((response) => response.json());
  const secondDetail = await request(`/api/v1/voting-sessions/${secondSession.id}`, { headers: { cookie } }).then((response) => response.json());
  const foreignAnswerResponse = await request(`/api/v1/voting-sessions/${secondSession.id}`, {
    method: "PUT",
    ...jsonRequest({
      question: "Keep session answers isolated?",
      live: true,
      options: [reorderedOptions[0], secondDetail.options[0]],
    }, cookie),
  });
  assert.equal(foreignAnswerResponse.status, 400);

  const ballot = await request(`/api/v1/ballots/${created.id}`).then((response) => response.json());
  assert.equal(ballot.id, created.id);
  assert.equal(ballot.options.length, 3);

  const guestId = crypto.randomUUID();
  const votePath = `/api/v1/ballots/${created.id}/votes/${guestId}`;
  assert.equal((await request(votePath)).status, 404);
  const firstVote = await request(votePath, { method: "PUT", ...jsonRequest({ answerId: reorderedOptions[0].id }) });
  assert.equal(firstVote.status, 201);
  assert.equal(firstVote.headers.get("location"), votePath);
  const firstVoteBody = await firstVote.json();
  assert.match(firstVoteBody.id, UUID_PATTERN);
  const changedVote = await request(votePath, { method: "PUT", ...jsonRequest({ answerId: reorderedOptions[1].id }) });
  assert.equal(changedVote.status, 200);
  assert.equal((await changedVote.json()).id, firstVoteBody.id);

  const storedVote = await request(votePath).then((response) => response.json());
  assert.equal(storedVote.answerId, reorderedOptions[1].id);
  const results = await request(`/api/v1/voting-sessions/${created.id}/results`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(results.totalVotes, 1);
  assert.equal(results.options[0].votes, 0);
  assert.equal(results.options[1].votes, 1);
  assert.equal(results.options[1].percentage, 100);

  const history = await request(`/api/v1/guests/${guestId}/votes`).then((response) => response.json());
  assert.equal(history.length, 1);
  assert.equal(history[0].voteId, firstVoteBody.id);
  assert.equal(history[0].sessionId, created.id);
  assert.equal(history[0].answerId, reorderedOptions[1].id);
  assert.equal(history[0].answerText, "Answer 2");

  const deletion = await request(`/api/v1/voting-sessions/${created.id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(deletion.status, 204);
  assert.equal((await request(`/api/v1/ballots/${created.id}`)).status, 404);
  const deletedRow = await pool.query(`SELECT deleted_at, is_open FROM vote_sessions WHERE id = $1`, [created.id]);
  assert.ok(deletedRow.rows[0].deleted_at);
  assert.equal(deletedRow.rows[0].is_open, false);
  const deletedHistory = await request(`/api/v1/guests/${guestId}/votes`).then((response) => response.json());
  assert.equal(deletedHistory[0].sessionAvailable, false);

  assert.equal((await request("/api/v1/login-sessions/current", { method: "DELETE", headers: { cookie } })).status, 204);
  assert.equal((await request("/api/v1/login-sessions/current", { headers: { cookie } })).status, 401);
});
