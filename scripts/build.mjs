import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const requiredFiles = [
  "server.mjs",
  "db/config.mjs",
  "db/client.mjs",
  "db/migrations/001_initial.sql",
  "db/migrations/002_username_only_accounts.sql",
  "public/index.html",
  "public/app.js",
  "public/openapi.json",
  "public/results-animation.js",
  "public/uuid.js",
  "public/styles.css",
];

for (const file of requiredFiles) {
  const stats = await fs.stat(path.join(root, file));
  if (!stats.isFile() || stats.size === 0) throw new Error(`${file} is missing or empty`);
}

JSON.parse(await fs.readFile(path.join(root, "public/openapi.json"), "utf8"));

for (const file of ["server.mjs", "db/config.mjs", "db/client.mjs", "scripts/migrate.mjs", "public/app.js", "public/results-animation.js", "public/uuid.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("InstantVote build verified.");
