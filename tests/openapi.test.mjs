import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const specification = JSON.parse(await fs.readFile(new URL("../public/openapi.json", import.meta.url), "utf8"));
const serverSource = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");

function resolveLocalReference(reference) {
  return reference.slice(2).split("/").reduce((value, key) => value?.[key], specification);
}

function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((item) => walk(item, visit));
  if (!value || typeof value !== "object") return;
  visit(value);
  Object.values(value).forEach((item) => walk(item, visit));
}

test("OpenAPI specification describes the complete versioned REST surface", () => {
  assert.equal(specification.openapi, "3.1.0");
  assert.equal(specification.servers[0].url, "/api/v1");

  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  const operations = Object.entries(specification.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
  assert.equal(operations.length, 15);
  assert.equal(new Set(operations.map(({ operation }) => operation.operationId)).size, operations.length);
  assert.ok(operations.every(({ path }) => path.startsWith("/")));
  assert.ok(operations.every(({ operation }) => operation.responses && Object.keys(operation.responses).length));
  assert.ok(operations.filter(({ method }) => method === "get").every(({ operation }) => !operation.requestBody));

  const expectedPaths = [
    "/users",
    "/users/{userId}",
    "/login-sessions",
    "/login-sessions/current",
    "/voting-sessions",
    "/voting-sessions/{sessionId}",
    "/voting-sessions/{sessionId}/results",
    "/ballots/{sessionId}",
    "/ballots/{sessionId}/votes/{guestId}",
    "/guests/{guestId}/votes",
  ];
  assert.deepEqual(Object.keys(specification.paths), expectedPaths);
});

test("all local OpenAPI references resolve", () => {
  const unresolved = [];
  walk(specification, (value) => {
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      if (!resolveLocalReference(value.$ref)) unresolved.push(value.$ref);
    }
  });
  assert.deepEqual(unresolved, []);
});

test("every Koa API route is documented with its implemented method", () => {
  const implemented = [...serverSource.matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)]
    .map(([, method, route]) => `${method.toUpperCase()} ${route.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`)
    .sort();
  const documented = Object.entries(specification.paths).flatMap(([route, pathItem]) =>
    ["get", "post", "put", "patch", "delete"]
      .filter((method) => pathItem[method])
      .map((method) => `${method.toUpperCase()} ${route}`),
  ).sort();
  assert.deepEqual(documented, implemented);
});
