import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNode(nodes) {
  const [firstNode = ""] = String(nodes || "").split(",").map((node) => node.trim()).filter(Boolean);
  const separator = firstNode.lastIndexOf(":");
  if (separator < 0) return { host: firstNode, port: 5432 };
  return { host: firstNode.slice(0, separator), port: Number(firstNode.slice(separator + 1) || 5432) };
}

async function captureQuestPostgres() {
  const configuredPath = process.env.CAPTURE_QUEST_CONFIG_PATH;
  const runtimePath = configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(root, "..", "Capture-Quest", "server", "runtimeConfig.js");
  if (!fs.existsSync(runtimePath)) return {};
  const imported = await import(pathToFileURL(runtimePath).href);
  return imported.config?.postgres || {};
}

export async function databaseConfig(overrides = {}) {
  const capture = await captureQuestPostgres();
  const node = parseNode(process.env.POSTGRES_NODES || capture.nodes);
  const schema = String(overrides.schema || process.env.POSTGRES_SCHEMA || "instantvote");
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("POSTGRES_SCHEMA must be a safe lowercase SQL identifier");
  const config = {
    host: overrides.host || node.host,
    port: overrides.port || node.port,
    user: overrides.user || process.env.POSTGRES_USER || capture.user,
    password: overrides.password || process.env.POSTGRES_PASSWORD || capture.password,
    database: overrides.database || process.env.POSTGRES_DATABASE || capture.database,
    ssl: overrides.ssl ?? parseBoolean(process.env.POSTGRES_SSL, Boolean(capture.ssl)),
    schema,
  };
  if (!config.host || !config.user || !config.database) {
    throw new Error("PostgreSQL is not configured. Set POSTGRES_NODES, POSTGRES_USER, and POSTGRES_DATABASE.");
  }
  return config;
}
