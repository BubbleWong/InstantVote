import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const specification = JSON.parse(await fs.readFile(new URL("../public/openapi.json", import.meta.url), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));
let moduleId = 0;

async function loadDocs(t, hash = "") {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const location = new URL(`http://localhost/api-docs${hash}`);
  const listeners = new Map();
  const elements = new Map();
  const scrolls = [];
  const renders = [];
  const app = {
    set innerHTML(markup) {
      renders.push(markup);
      elements.clear();
      for (const [, id] of markup.matchAll(/<article[^>]* id="([^"]+)"/g)) {
        elements.set(id, { scrollIntoView: (options) => scrolls.push({ id, options }) });
      }
    },
    get innerHTML() { return renders.at(-1); },
  };

  globalThis.window = { location, addEventListener: (type, listener) => listeners.set(type, listener) };
  globalThis.document = {
    querySelector: (selector) => selector === "#app" ? app : null,
    querySelectorAll: () => [],
    getElementById: (id) => elements.get(id) || null,
  };
  const requests = t.mock.method(globalThis, "fetch", async (path) => {
    assert.equal(path, "/openapi.json");
    return { ok: true, status: 200, json: async () => specification };
  });

  await import(`../public/app.js?docs-navigation-test=${++moduleId}`);
  await flush();
  return { app, location, listeners, elements, scrolls, renders, requests };
}

test("every API navigation bar links to its explanation", async (t) => {
  const { app, elements } = await loadDocs(t);
  const operations = Object.values(specification.paths).flatMap((path) => Object.values(path));
  for (const operation of operations) {
    assert.ok(app.innerHTML.includes(`href="#${operation.operationId}"`));
    assert.ok(elements.has(operation.operationId));
  }
});

test("endpoint jumps and fragment history preserve the rendered documentation", async (t) => {
  const { location, listeners, renders, requests } = await loadDocs(t);
  const renderCount = renders.length;

  for (const hash of ["#putGuestVote", "#getUser", "#putGuestVote", "", "#getUser"]) {
    location.hash = hash;
    listeners.get("popstate")();
    await flush();
    assert.equal(renders.length, renderCount, "fragment navigation must not remove the anchor target");
    assert.equal(requests.mock.callCount(), 1, "fragment navigation must not reload the specification");
  }
});

test("a bookmarked endpoint scrolls to its explanation after the docs load", async (t) => {
  const { scrolls } = await loadDocs(t, "#%6CistGuestVotes");
  assert.deepEqual(scrolls, [{ id: "listGuestVotes", options: { block: "start" } }]);
});

test("malformed endpoint fragments leave the docs usable", async (t) => {
  const { app, scrolls } = await loadDocs(t, "#%E0%A4%A");
  assert.ok(app.innerHTML.includes('class="docs-shell"'));
  assert.deepEqual(scrolls, []);
});

test("unknown endpoint fragments leave the docs usable", async (t) => {
  const { app, scrolls } = await loadDocs(t, "#not-an-operation");
  assert.ok(app.innerHTML.includes('class="docs-shell"'));
  assert.deepEqual(scrolls, []);
});

test("path and query history changes still render the requested route", async (t) => {
  const { app, location, listeners, requests } = await loadDocs(t);
  location.search = "?reference=1";
  listeners.get("popstate")();
  await flush();
  assert.equal(requests.mock.callCount(), 2);

  location.pathname = "/missing-page";
  listeners.get("popstate")();
  await flush();
  assert.ok(app.innerHTML.includes("Nothing to vote on here"));
});
