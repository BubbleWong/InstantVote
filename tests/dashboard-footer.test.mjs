import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const specification = JSON.parse(await fs.readFile(new URL("../public/openapi.json", import.meta.url), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const populated of [false, true]) {
  test(`voting sessions footer displays attribution and links to API docs (${populated ? "populated" : "empty"} list)`, async (t) => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    t.after(() => {
      for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument]]) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });

    const location = new URL("http://localhost/");
    const app = { innerHTML: "" };
    const handlers = new Map();
    const footerLink = {
      getAttribute: () => "/api-docs",
      addEventListener: (type, listener) => handlers.set(type, listener),
    };
    globalThis.window = {
      location,
      addEventListener: () => {},
      history: { pushState: (_state, _unused, path) => { location.href = new URL(path, location).href; } },
    };
    globalThis.document = {
      querySelector: (selector) => selector === "#app" ? app : null,
      querySelectorAll: (selector) => selector === "[data-link]" && app.innerHTML.includes("footer-api-link") ? [footerLink] : [],
    };
    t.mock.method(globalThis, "fetch", async (path) => {
      const responses = {
        "/api/v1/login-sessions/current": { user: { id: "owner", username: "test_owner" } },
        "/api/v1/voting-sessions": populated ? [{ id: "session", question: "Choose a pet", optionsCount: 2, totalVotes: 3, live: true, updatedAt: "2026-09-02T12:00:00Z" }] : [],
        "/openapi.json": specification,
      };
      assert.ok(Object.hasOwn(responses, path));
      return { ok: true, status: 200, json: async () => responses[path] };
    });

    await import(`../public/app.js?dashboard-footer-test=${populated}`);
    await flush();
    const footer = app.innerHTML.match(/<footer class="dashboard-footer">[\s\S]*?<\/footer>/)?.[0];
    assert.ok(footer);
    const copyright = footer.match(/<p class="footer-copyright">[\s\S]*?<\/p>/)?.[0];
    assert.ok(copyright);
    assert.match(copyright, /<a href="https:\/\/bubbleh\.com" target="_blank" rel="noopener noreferrer">© 2026 bubbleh\.com<\/a>/);
    assert.match(copyright, /<span aria-hidden="true">\|<\/span>/);
    assert.match(copyright, /class="footer-github-link" href="https:\/\/github\.com\/BubbleWong\/InstantVote" target="_blank" rel="noopener noreferrer" aria-label="InstantVote on GitHub"/);
    assert.match(copyright, /<svg class="footer-github-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">/);
    assert.equal(footer.includes("BubbleWong 2026"), false);
    assert.equal(footer.includes("footer-site-link"), false);
    assert.equal(footer.includes("Capture Quest"), false);
    assert.match(copyright, /<\/svg>\s*<\/a>\s*<span aria-hidden="true">\|<\/span>\s*<a class="footer-api-link" href="\/api-docs" data-link>API Documents<\/a>/);
    assert.equal((copyright.match(/<span aria-hidden="true">\|<\/span>/g) || []).length, 2);
    assert.equal(footer.includes("secondary footer-api-link"), false);
    assert.ok(app.innerHTML.indexOf("<footer") > app.innerHTML.indexOf("</section>"));

    let prevented = false;
    handlers.get("click")({ preventDefault: () => { prevented = true; } });
    await flush();
    assert.equal(prevented, true);
    assert.equal(location.pathname, "/api-docs");
    assert.ok(app.innerHTML.includes('class="docs-shell"'));
  });
}
