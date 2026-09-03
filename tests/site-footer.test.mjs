import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const index = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const specification = JSON.parse(await fs.readFile(new URL("../public/openapi.json", import.meta.url), "utf8"));
const footer = index.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)?.[0];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sessionId = "10000000-0000-4000-8000-000000000001";
const guestId = "10000000-0000-4000-8000-000000000002";
const session = {
  id: sessionId,
  question: "Choose a pet",
  options: [
    { id: "10000000-0000-4000-8000-000000000003", text: "Cat", votes: 2, percentage: 67 },
    { id: "10000000-0000-4000-8000-000000000004", text: "Dog", votes: 1, percentage: 33 },
  ],
  optionsCount: 2,
  totalVotes: 3,
  live: true,
  updatedAt: "2026-09-02T12:00:00Z",
  votingUrl: `http://localhost/vote/${sessionId}`,
  qrCode: "data:image/png;base64,test",
};

test("shared footer preserves the copyright, GitHub icon, separators, and API link", () => {
  assert.ok(footer);
  assert.equal((index.match(/<footer\b/g) || []).length, 1);
  assert.match(index, /<main id="app"[^>]*>\s*<div class="loading-screen">[\s\S]*?<\/div>\s*<\/main>\s*<footer class="site-footer">/,
    "footer must live outside the replaceable route content, including during initial loading");
  assert.match(footer, /<a href="https:\/\/bubbleh\.com" target="_blank" rel="noopener noreferrer">© 2026 bubbleh\.com<\/a>/);
  assert.match(footer, /class="footer-github-link" href="https:\/\/github\.com\/BubbleWong\/InstantVote" target="_blank" rel="noopener noreferrer" aria-label="InstantVote on GitHub"/);
  assert.match(footer, /<svg class="footer-github-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">/);
  assert.match(footer, /<\/svg>\s*<\/a>\s*<span aria-hidden="true">\|<\/span>\s*<a class="footer-api-link" href="\/api-docs">API Documents<\/a>/);
  assert.equal((footer.match(/<span aria-hidden="true">\|<\/span>/g) || []).length, 2);
  for (const oldCopy of ["BubbleWong 2026", "footer-site-link", "Capture Quest", "secondary footer-api-link"]) {
    assert.equal(footer.includes(oldCopy), false);
  }
});

const pages = [
  { name: "sign in", route: "/", anonymous: true, expected: "Sign in to InstantVote" },
  { name: "sign up", route: "/", anonymous: true, register: true, expected: "Sign up for InstantVote" },
  { name: "empty sessions list", route: "/", empty: true, expected: "Your first voting topic starts here" },
  { name: "populated sessions list", route: "/", expected: "Choose a pet" },
  { name: "session editor", route: `/session/${sessionId}`, expected: "Shape your voting topic" },
  { name: "live results", route: `/session/${sessionId}?tab=view`, expected: "LIVE RESULTS" },
  { name: "open voting page", route: `/vote/${sessionId}`, expected: "MAKE YOUR PICK" },
  { name: "closed voting page", route: `/vote/${sessionId}`, closed: true, expected: "This session is no longer accepting votes." },
  { name: "empty guest history", route: "/history", empty: true, expected: "No votes on this device yet" },
  { name: "guest history", route: "/history", expected: "View vote →" },
  { name: "API reference", route: "/api-docs", expected: "InstantVote API" },
  { name: "missing page", route: "/does-not-exist", expected: "Nothing to vote on here" },
  { name: "failed ballot", route: `/vote/${sessionId}`, failed: true, expected: "We hit a small snag" },
];

for (const page of pages) {
  test(`shared footer remains available and navigates to API docs from ${page.name}`, async (t) => {
    const originals = new Map(["window", "document", "localStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    t.after(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });

    const location = new URL(page.route, "http://localhost");
    const app = { innerHTML: "" };
    const handlers = [];
    let registerClick;
    const footerLink = { addEventListener: (type, handler) => { assert.equal(type, "click"); handlers.push(handler); } };
    const registerButton = { dataset: { authMode: "register" }, addEventListener: (_type, handler) => { registerClick = handler; } };
    globalThis.window = {
      location,
      addEventListener: () => {},
      history: { pushState: (_state, _unused, path) => { location.href = new URL(path, location).href; } },
    };
    globalThis.document = {
      querySelector: (selector) => selector === "#app" ? app : selector === ".footer-api-link" ? footerLink : null,
      querySelectorAll: (selector) => selector === "[data-auth-mode]" ? [registerButton] : [],
    };
    globalThis.localStorage = { getItem: (key) => key === "instantvote_guest_id" ? guestId : null };
    t.mock.method(globalThis, "setTimeout", () => 0);
    t.mock.method(globalThis, "fetch", async (path) => {
      if (page.anonymous && path === "/api/v1/login-sessions/current") {
        return { ok: false, status: 401, json: async () => ({ error: "Sign in required" }) };
      }
      if (page.failed && path === `/api/v1/ballots/${sessionId}`) {
        return { ok: false, status: 404, json: async () => ({ error: "Session not found" }) };
      }
      const responses = {
        "/api/v1/login-sessions/current": { user: { id: "owner", username: "test_owner" } },
        "/api/v1/voting-sessions": page.empty ? [] : [session],
        [`/api/v1/voting-sessions/${sessionId}`]: session,
        [`/api/v1/voting-sessions/${sessionId}/results`]: session,
        [`/api/v1/ballots/${sessionId}`]: { ...session, live: !page.closed },
        [`/api/v1/guests/${guestId}/votes`]: page.empty ? [] : [{ sessionId, question: session.question, answerText: "Cat", live: true, sessionAvailable: true, votedAt: session.updatedAt }],
        "/openapi.json": specification,
      };
      assert.ok(Object.hasOwn(responses, path), `Unexpected API call: ${path}`);
      return { ok: true, status: 200, json: async () => responses[path] };
    });

    await import(`../public/app.js?site-footer-test=${encodeURIComponent(page.name)}`);
    await flush();
    if (page.register) registerClick();
    assert.ok(app.innerHTML.includes(page.expected), `${page.name} should render successfully`);
    assert.equal(app.innerHTML.includes("<footer"), false, "route rendering must not create a duplicate footer");
    assert.equal((`${app.innerHTML}${footer}`.match(/class="footer-copyright"/g) || []).length, 1,
      "the rendered page and shared shell must contain exactly one copyright section");
    assert.equal(handlers.length, 1, "persistent footer navigation should be bound only once");

    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      handlers[0]({ button: 0, [modifier]: true, preventDefault: () => assert.fail("Modified clicks should keep native navigation") });
    }
    handlers[0]({ button: 1, preventDefault: () => assert.fail("Middle-click should keep native navigation") });
    let prevented = false;
    handlers[0]({ button: 0, preventDefault: () => { prevented = true; } });
    await flush();
    assert.equal(prevented, true);
    assert.equal(location.pathname, "/api-docs");
    assert.ok(app.innerHTML.includes('class="docs-shell"'));
    assert.equal((`${app.innerHTML}${footer}`.match(/class="footer-copyright"/g) || []).length, 1,
      "switching pages must not add another copyright section");
    assert.equal(handlers.length, 1, "navigation must not bind duplicate footer handlers");
  });
}
