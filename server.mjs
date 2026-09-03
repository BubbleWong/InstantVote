import Koa from "koa";
import Router from "@koa/router";
import { bodyParser } from "@koa/bodyparser";
import serve from "koa-static";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, migrate } from "./db/client.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_COOKIE = "instantvote_admin_session";
const PASSWORD_ROUNDS = 12;

async function renderFrontend(ctx) {
  const [html, script, styles] = await Promise.all(
    ["index.html", "app.js", "styles.css"].map((file) => fs.readFile(path.join(root, "public", file), "utf8")),
  );
  // A fresh shell must not reuse a cached renderer that still inserts its own footer.
  const version = crypto.createHash("sha256").update([html, script, styles].join("\0")).digest("hex").slice(0, 16);
  ctx.type = "html";
  ctx.set("Cache-Control", "no-store");
  ctx.body = html.replace(/(href|src)="\/(styles\.css|app\.js)"/g, `$1="/$2?v=${version}"`);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requestOrigin(ctx) {
  const forwardedProtocol = ctx.get("x-forwarded-proto").split(",")[0].trim();
  const forwardedHost = ctx.get("x-forwarded-host").split(",")[0].trim();
  const protocol = forwardedProtocol || ctx.protocol || "http";
  const host = forwardedHost || ctx.get("host") || ctx.host;
  return `${protocol}://${host}`;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validateUuid(value, label) {
  const normalized = String(value || "");
  if (!UUID_PATTERN.test(normalized)) throw httpError(400, `${label} must be a valid UUID`);
  return normalized.toLowerCase();
}

function validateJsonObject(body, { allowed, required = allowed }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object");
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw httpError(400, `Unknown request field: ${unknown[0]}`);
  const missing = required.filter((key) => !Object.hasOwn(body, key));
  if (missing.length) throw httpError(400, `Missing required field: ${missing[0]}`);
}

function cleanCredentials(body) {
  return {
    username: String(body?.username || ""),
    password: String(body?.password || ""),
  };
}

function validateRegistration({ username, password }) {
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username)) {
    throw httpError(400, "Username must be 3–40 characters using only letters, numbers, underscores, or hyphens");
  }
  if (password.length < 10 || password.length > 200) {
    throw httpError(400, "Password must be between 10 and 200 characters");
  }
}

async function issueAdminSession(ctx, pool, userId, sessionDays) {
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + sessionDays * 86400000);
  const result = await pool.query(
    `INSERT INTO admin_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)
     RETURNING created_at, expires_at`,
    [id, userId, tokenHash(token), expiresAt],
  );
  ctx.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.secure || process.env.NODE_ENV === "production",
    overwrite: true,
    maxAge: sessionDays * 86400000,
    path: "/",
  });
  return { id, createdAt: result.rows[0].created_at, expiresAt: result.rows[0].expires_at };
}

async function currentAdmin(ctx, pool) {
  const token = ctx.cookies.get(SESSION_COOKIE);
  if (!token) return null;
  const result = await pool.query(
    `
      SELECT u.id, u.username, s.id AS session_id,
             s.created_at AS session_created_at, s.expires_at AS session_expires_at
      FROM admin_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [tokenHash(token)],
  );
  const user = result.rows[0];
  if (!user) return null;
  await pool.query(`UPDATE admin_sessions SET last_used_at = NOW() WHERE id = $1`, [user.session_id]);
  return {
    id: user.id,
    username: user.username,
    sessionId: user.session_id,
    sessionCreatedAt: user.session_created_at,
    sessionExpiresAt: user.session_expires_at,
  };
}

function answerPayload(options) {
  if (!Array.isArray(options) || options.length < 2) {
    throw httpError(400, "At least two answer choices are required");
  }
  if (options.length > 20) throw httpError(400, "A session can have at most 20 answer choices");
  const parsed = options.map((option, index) => {
    validateJsonObject(option, { allowed: ["id", "text"], required: ["text"] });
    if (Object.hasOwn(option, "id") && !UUID_PATTERN.test(String(option.id))) throw httpError(400, "Answer ID must be a valid UUID");
    return {
      id: Object.hasOwn(option, "id") ? String(option.id).toLowerCase() : crypto.randomUUID(),
      text: String(option.text || "").trim(),
      sortOrder: index,
    };
  });
  if (parsed.some((option) => !option.text || option.text.length > 200)) {
    throw httpError(400, "Each answer choice must be between 1 and 200 characters");
  }
  if (new Set(parsed.map((option) => option.id)).size !== parsed.length) {
    throw httpError(400, "Answer choices must be unique");
  }
  return parsed;
}

async function ownedSession(pool, id, userId) {
  const result = await pool.query(
    `SELECT id, user_id, question, is_open, created_at, updated_at
     FROM vote_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [validateUuid(id, "Session ID"), userId],
  );
  if (!result.rows[0]) throw httpError(404, "Voting session not found");
  return result.rows[0];
}

async function publicSession(pool, id) {
  const result = await pool.query(
    `SELECT id, question, is_open, created_at, updated_at
     FROM vote_sessions WHERE id = $1 AND deleted_at IS NULL`,
    [validateUuid(id, "Session ID")],
  );
  if (!result.rows[0]) throw httpError(404, "Voting session not found");
  return result.rows[0];
}

async function sessionAnswers(pool, sessionId) {
  const result = await pool.query(
    `SELECT id, answer_text AS text FROM answers WHERE vote_session_id = $1 ORDER BY sort_order, created_at`,
    [sessionId],
  );
  return result.rows;
}

async function sessionVoteCount(pool, sessionId) {
  const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM votes WHERE vote_session_id = $1`, [sessionId]);
  return result.rows[0]?.count || 0;
}

export function createApp({ pool, sessionDays = Number(process.env.ADMIN_SESSION_DAYS || 30) } = {}) {
  if (!pool) throw new Error("createApp requires a PostgreSQL pool");
  const app = new Koa();
  const router = new Router({ prefix: "/api/v1" });
  const failedLogins = new Map();
  app.proxy = true;

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      ctx.status = Number(error.status || (error.code === "23505" ? 409 : 500));
      const duplicateMessage = error.constraint?.includes("username")
        ? "That username is already registered"
        : "That account already exists";
      ctx.body = { error: ctx.status === 500 ? "Something went wrong" : error.code === "23505" ? duplicateMessage : error.message };
      if (ctx.status === 500) console.error(error);
    }
  });

  app.use(async (ctx, next) => {
    if (ctx.path.startsWith("/api/")) ctx.set("Cache-Control", "no-store");
    await next();
  });

  app.use(bodyParser({ jsonLimit: "256kb" }));

  const requireAdmin = async (ctx, next) => {
    const user = await currentAdmin(ctx, pool);
    if (!user) throw httpError(401, "Sign in to continue");
    ctx.state.admin = user;
    await next();
  };

  router.post("/users", async (ctx) => {
    validateJsonObject(ctx.request.body, { allowed: ["username", "password"] });
    const credentials = cleanCredentials(ctx.request.body);
    validateRegistration(credentials);
    const passwordHash = await bcrypt.hash(credentials.password, PASSWORD_ROUNDS);
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)
       RETURNING id, username`,
      [id, credentials.username, passwordHash],
    );
    await issueAdminSession(ctx, pool, id, sessionDays);
    ctx.status = 201;
    ctx.set("Location", `/api/v1/users/${id}`);
    ctx.body = result.rows[0];
  });

  router.get("/users/:userId", requireAdmin, async (ctx) => {
    const userId = validateUuid(ctx.params.userId, "User ID");
    if (userId !== ctx.state.admin.id) throw httpError(404, "User not found");
    ctx.body = { id: ctx.state.admin.id, username: ctx.state.admin.username };
  });

  router.post("/login-sessions", async (ctx) => {
    validateJsonObject(ctx.request.body, { allowed: ["username", "password"] });
    const key = ctx.ip;
    const attempt = failedLogins.get(key);
    if (attempt?.blockedUntil > Date.now()) throw httpError(429, "Too many sign-in attempts. Try again shortly.");
    const username = String(ctx.request.body?.username || "").trim();
    const password = String(ctx.request.body?.password || "");
    const result = await pool.query(
      `SELECT id, username, password_hash FROM users
       WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username],
    );
    const user = result.rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!valid) {
      const count = (attempt?.count || 0) + 1;
      failedLogins.set(key, { count, blockedUntil: count >= 8 ? Date.now() + 15 * 60 * 1000 : 0 });
      throw httpError(401, "Incorrect username or password");
    }
    failedLogins.delete(key);
    const loginSession = await issueAdminSession(ctx, pool, user.id, sessionDays);
    ctx.status = 201;
    ctx.set("Location", "/api/v1/login-sessions/current");
    ctx.body = { ...loginSession, user: { id: user.id, username: user.username } };
  });

  router.get("/login-sessions/current", async (ctx) => {
    const user = await currentAdmin(ctx, pool);
    if (!user) throw httpError(401, "Not signed in");
    ctx.body = {
      id: user.sessionId,
      createdAt: user.sessionCreatedAt,
      expiresAt: user.sessionExpiresAt,
      user: { id: user.id, username: user.username },
    };
  });

  router.delete("/login-sessions/current", async (ctx) => {
    const token = ctx.cookies.get(SESSION_COOKIE);
    if (token) {
      await pool.query(`UPDATE admin_sessions SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash(token)]);
    }
    ctx.cookies.set(SESSION_COOKIE, null, { httpOnly: true, sameSite: "lax", overwrite: true, maxAge: 0, path: "/" });
    ctx.status = 204;
  });

  router.get("/voting-sessions", requireAdmin, async (ctx) => {
    const result = await pool.query(
      `
        SELECT s.id, s.question, s.is_open AS live, s.created_at, s.updated_at,
               COUNT(DISTINCT a.id)::INTEGER AS options_count,
               COUNT(DISTINCT v.id)::INTEGER AS total_votes
        FROM vote_sessions s
        LEFT JOIN answers a ON a.vote_session_id = s.id
        LEFT JOIN votes v ON v.vote_session_id = s.id
        WHERE s.user_id = $1 AND s.deleted_at IS NULL
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `,
      [ctx.state.admin.id],
    );
    ctx.body = result.rows.map((row) => ({
      id: row.id,
      question: row.question,
      optionsCount: row.options_count,
      totalVotes: row.total_votes,
      live: row.live,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });

  router.post("/voting-sessions", requireAdmin, async (ctx) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = crypto.randomUUID();
      const created = await client.query(
        `INSERT INTO vote_sessions (id, user_id, question) VALUES ($1, $2, $3)
         RETURNING id, question, is_open, created_at, updated_at`,
        [id, ctx.state.admin.id, "What should people vote on?"],
      );
      const defaults = ["First choice", "Second choice", "Third choice"];
      for (let index = 0; index < defaults.length; index += 1) {
        await client.query(
          `INSERT INTO answers (id, vote_session_id, answer_text, sort_order) VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), id, defaults[index], index],
        );
      }
      await client.query("COMMIT");
      ctx.status = 201;
      ctx.set("Location", `/api/v1/voting-sessions/${id}`);
      ctx.body = { id, question: created.rows[0].question, optionsCount: 3, totalVotes: 0, live: true, createdAt: created.rows[0].created_at, updatedAt: created.rows[0].updated_at };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  router.get("/voting-sessions/:sessionId", requireAdmin, async (ctx) => {
    const session = await ownedSession(pool, ctx.params.sessionId, ctx.state.admin.id);
    const [options, totalVotes] = await Promise.all([sessionAnswers(pool, session.id), sessionVoteCount(pool, session.id)]);
    const votingUrl = `${requestOrigin(ctx)}/vote/${session.id}`;
    ctx.body = {
      id: session.id,
      question: session.question,
      options,
      optionsCount: options.length,
      live: session.is_open,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      totalVotes,
      votingUrl,
      qrCode: await QRCode.toDataURL(votingUrl, { width: 420, margin: 2, color: { dark: "#10172AFF", light: "#FFFFFFFF" } }),
    };
  });

  router.put("/voting-sessions/:sessionId", requireAdmin, async (ctx) => {
    const session = await ownedSession(pool, ctx.params.sessionId, ctx.state.admin.id);
    validateJsonObject(ctx.request.body, { allowed: ["question", "options", "live"] });
    const question = String(ctx.request.body?.question || "").trim();
    if (!question || question.length > 500) throw httpError(400, "Voting topic must be between 1 and 500 characters");
    if (typeof ctx.request.body.live !== "boolean") throw httpError(400, "Live must be a boolean");
    const options = answerPayload(ctx.request.body?.options);
    const client = await pool.connect();
    let updatedSession;
    try {
      await client.query("BEGIN");
      const submittedIds = options.map((option) => option.id);
      const foreignAnswer = await client.query(
        `SELECT id FROM answers
         WHERE id = ANY($1::uuid[]) AND vote_session_id <> $2
         LIMIT 1`,
        [submittedIds, session.id],
      );
      if (foreignAnswer.rows[0]) throw httpError(400, "An answer choice does not belong to this voting session");
      const removedWithVotes = await client.query(
        `SELECT a.id FROM answers a
         WHERE a.vote_session_id = $1 AND NOT (a.id = ANY($2::uuid[]))
           AND EXISTS (SELECT 1 FROM votes v WHERE v.answer_id = a.id)
         LIMIT 1`,
        [session.id, submittedIds],
      );
      if (removedWithVotes.rows[0]) throw httpError(409, "An answer with votes cannot be removed");
      await client.query(`DELETE FROM answers WHERE vote_session_id = $1 AND NOT (id = ANY($2::uuid[]))`, [session.id, submittedIds]);
      await client.query(`UPDATE answers SET sort_order = sort_order + 1000 WHERE vote_session_id = $1`, [session.id]);
      for (const option of options) {
        await client.query(
          `
            INSERT INTO answers (id, vote_session_id, answer_text, sort_order)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id)
            DO UPDATE SET answer_text = EXCLUDED.answer_text, sort_order = EXCLUDED.sort_order, updated_at = NOW()
          `,
          [option.id, session.id, option.text, option.sortOrder],
        );
      }
      const updated = await client.query(
        `UPDATE vote_sessions SET question = $1, is_open = $2, updated_at = NOW() WHERE id = $3
         RETURNING created_at, updated_at`,
        [question, ctx.request.body.live, session.id],
      );
      updatedSession = updated.rows[0];
      await client.query("COMMIT");
      ctx.body = {
        id: session.id,
        question,
        optionsCount: options.length,
        totalVotes: await sessionVoteCount(pool, session.id),
        live: ctx.request.body.live,
        createdAt: updatedSession.created_at,
        updatedAt: updatedSession.updated_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  router.delete("/voting-sessions/:sessionId", requireAdmin, async (ctx) => {
    const result = await pool.query(
      `UPDATE vote_sessions SET deleted_at = NOW(), is_open = FALSE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [validateUuid(ctx.params.sessionId, "Session ID"), ctx.state.admin.id],
    );
    if (!result.rows[0]) throw httpError(404, "Voting session not found");
    ctx.status = 204;
  });

  router.get("/voting-sessions/:sessionId/results", requireAdmin, async (ctx) => {
    const session = await ownedSession(pool, ctx.params.sessionId, ctx.state.admin.id);
    const result = await pool.query(
      `
        SELECT a.id, a.answer_text AS text, a.sort_order, COUNT(v.id)::INTEGER AS votes
        FROM answers a
        LEFT JOIN votes v ON v.answer_id = a.id
        WHERE a.vote_session_id = $1
        GROUP BY a.id
        ORDER BY a.sort_order
      `,
      [session.id],
    );
    const totalVotes = result.rows.reduce((total, option) => total + option.votes, 0);
    ctx.body = {
      id: session.id,
      question: session.question,
      live: session.is_open,
      totalVotes,
      updatedAt: session.updated_at,
      options: result.rows.map((option) => ({ id: option.id, text: option.text, votes: option.votes, percentage: totalVotes ? Math.round((option.votes / totalVotes) * 100) : 0 })),
    };
  });

  router.get("/ballots/:sessionId", async (ctx) => {
    const session = await publicSession(pool, ctx.params.sessionId);
    ctx.body = { id: session.id, question: session.question, options: await sessionAnswers(pool, session.id), live: session.is_open };
  });

  router.get("/ballots/:sessionId/votes/:guestId", async (ctx) => {
    const session = await publicSession(pool, ctx.params.sessionId);
    const guestId = validateUuid(ctx.params.guestId, "Guest ID");
    const result = await pool.query(
      `SELECT id, answer_id, created_at, updated_at FROM votes
       WHERE vote_session_id = $1 AND guest_id = $2`,
      [session.id, guestId],
    );
    const vote = result.rows[0];
    if (!vote) throw httpError(404, "Vote not found");
    ctx.body = {
      id: vote.id,
      sessionId: session.id,
      guestId,
      answerId: vote.answer_id,
      createdAt: vote.created_at,
      updatedAt: vote.updated_at,
    };
  });

  router.put("/ballots/:sessionId/votes/:guestId", async (ctx) => {
    const session = await publicSession(pool, ctx.params.sessionId);
    if (!session.is_open) throw httpError(409, "This voting session is closed");
    validateJsonObject(ctx.request.body, { allowed: ["answerId"] });
    const answerId = validateUuid(ctx.request.body?.answerId, "Answer ID");
    const guestId = validateUuid(ctx.params.guestId, "Guest ID");
    const answer = await pool.query(`SELECT id FROM answers WHERE id = $1 AND vote_session_id = $2`, [answerId, session.id]);
    if (!answer.rows[0]) throw httpError(400, "That answer choice does not exist");
    const inserted = await pool.query(
      `
        INSERT INTO votes (id, vote_session_id, answer_id, guest_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (guest_id, vote_session_id)
        DO NOTHING
        RETURNING id, created_at, updated_at
      `,
      [crypto.randomUUID(), session.id, answerId, guestId],
    );
    const created = Boolean(inserted.rows[0]);
    const vote = created ? inserted.rows[0] : (await pool.query(
      `UPDATE votes
       SET answer_id = $1,
           updated_at = CASE WHEN answer_id <> $1 THEN NOW() ELSE updated_at END
       WHERE guest_id = $2 AND vote_session_id = $3
       RETURNING id, created_at, updated_at`,
      [answerId, guestId, session.id],
    )).rows[0];
    ctx.status = created ? 201 : 200;
    ctx.set("Location", `/api/v1/ballots/${session.id}/votes/${guestId}`);
    ctx.body = {
      id: vote.id,
      sessionId: session.id,
      guestId,
      answerId,
      totalVotes: await sessionVoteCount(pool, session.id),
      createdAt: vote.created_at,
      updatedAt: vote.updated_at,
    };
  });

  router.get("/guests/:guestId/votes", async (ctx) => {
    const guestId = validateUuid(ctx.params.guestId, "Guest ID");
    const result = await pool.query(
      `
        SELECT v.id AS vote_id, v.updated_at, s.id AS session_id, s.question, s.is_open,
               s.deleted_at, a.id AS answer_id, a.answer_text
        FROM votes v
        JOIN vote_sessions s ON s.id = v.vote_session_id
        JOIN answers a ON a.id = v.answer_id
        WHERE v.guest_id = $1
        ORDER BY v.updated_at DESC
      `,
      [guestId],
    );
    ctx.body = result.rows.map((row) => ({
      voteId: row.vote_id,
      sessionId: row.session_id,
      question: row.question,
      answerId: row.answer_id,
      answerText: row.answer_text,
      votedAt: row.updated_at,
      sessionAvailable: !row.deleted_at,
      live: row.is_open && !row.deleted_at,
    }));
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith("/api/")) {
      ctx.status = 404;
      ctx.body = { error: "API resource not found" };
      return;
    }
    await next();
  });
  app.use(async (ctx, next) => {
    if (["GET", "HEAD"].includes(ctx.method) && ["/", "/index.html"].includes(ctx.path)) {
      await renderFrontend(ctx);
      return;
    }
    await next();
  });
  app.use(serve(path.join(root, "public")));
  app.use(async (ctx) => {
    if (ctx.method !== "GET") {
      ctx.status = 404;
      return;
    }
    await renderFrontend(ctx);
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const pool = await createPool();
  await migrate(pool);
  const app = createApp({ pool });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`InstantVote is running at http://localhost:${port}`));
  const close = async () => {
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
