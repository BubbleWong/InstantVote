import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createApp } from "../server.mjs";

const publicFile = (name) => fs.readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

test("every page serves one copyright with matching, content-versioned frontend assets", async (t) => {
  const app = createApp({ pool: { query: () => assert.fail("Serving the frontend must not require a database query") } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = await Promise.all(["index.html", "app.js", "styles.css"].map(publicFile));
  const version = crypto.createHash("sha256").update(files.join("\0")).digest("hex").slice(0, 16);
  const id = "10000000-0000-4000-8000-000000000001";

  for (const route of ["/", "/index.html", "/api-docs", "/history", `/session/${id}`, `/session/${id}?tab=view`, `/vote/${id}`, "/missing-page"]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-store", "HTML must refresh after a deployment");
    const html = await response.text();
    assert.equal((html.match(/<footer\b/g) || []).length, 1, route);
    assert.equal((html.match(/class="footer-copyright"/g) || []).length, 1, route);
    assert.equal((html.match(/© 2026 bubbleh\.com/g) || []).length, 1, route);
    assert.ok(html.includes(`src="/app.js?v=${version}"`), "The renderer must have a content-versioned URL");
    assert.ok(html.includes(`href="/styles.css?v=${version}"`), "The stylesheet must use the same version");
    assert.equal(html.includes('src="/app.js"'), false, "Do not reuse the legacy cached renderer URL");
  }

  for (const [index, name] of [[1, "app.js"], [2, "styles.css"]]) {
    const response = await fetch(`${base}/${name}?v=${version}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), files[index], "Versioned assets must resolve to the actual source file");
  }

  const head = await fetch(`${base}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(await head.text(), "");
  const unauthorized = await fetch(`${base}/api/v1/voting-sessions`);
  assert.equal(unauthorized.status, 401, "API routing must remain separate from the HTML shell");
});
