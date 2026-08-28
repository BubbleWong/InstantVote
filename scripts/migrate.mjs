import { createPool, migrate } from "../db/client.mjs";

const pool = await createPool();
try {
  await migrate(pool);
  console.log("InstantVote database schema is ready.");
} finally {
  await pool.end();
}
