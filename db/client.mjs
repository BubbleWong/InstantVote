import { Pool } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseConfig } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function createPool(overrides = {}) {
  const config = await databaseConfig(overrides);
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: `-c search_path=${config.schema},public`,
  });
  await pool.query("SELECT 1");
  pool.instantVoteSchema = config.schema;
  return pool;
}

export async function migrate(pool, schema = pool.instantVoteSchema || "instantvote") {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Unsafe schema name");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const migrationDirectory = path.join(root, "db", "migrations");
  const files = (await fs.readdir(migrationDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  const client = await pool.connect();
  try {
    for (const file of files) {
      const version = path.basename(file, ".sql");
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const applied = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
      if (!applied.rows[0]) {
        const sql = await fs.readFile(path.join(migrationDirectory, file), "utf8");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
      }
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
