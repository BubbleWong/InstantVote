import { createUuid } from "./uuid.js";
import { resultBarTransitions } from "./results-animation.js";

const app = document.querySelector("#app");
let activeSession = null;
let currentUser = null;
let saveTimer = null;
let refreshTimer = null;
let previousResults = null;
let renderedRoute = null;

const palette = ["blue", "coral", "violet", "mint", "amber", "rose"];
const symbols = ["✦", "♪", "◆", "●", "✺", "▲"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "Unable to complete that request");
    error.status = response.status;
    throw error;
  }
  return body;
}

function brand() {
  return `<a class="brand" href="/" data-link aria-label="InstantVote home">
    <span class="brand-mark"><i></i><i></i><i></i></span>
    <span>instant<span>vote</span></span>
  </a>`;
}

function profile() {
  if (!currentUser) return "";
  const initials = currentUser.username.slice(0, 2).toUpperCase();
  return `<div class="profile admin-profile">
    <a class="docs-link" href="/api-docs" data-link>API docs</a>
    <span class="avatar">${escapeHtml(initials)}</span>
    <span class="profile-copy"><strong>${escapeHtml(currentUser.username)}</strong><small>Account owner</small></span>
    <button class="logout-button" id="logout-button">Sign out</button>
  </div>`;
}

function navigate(pathname) {
  window.history.pushState({}, "", pathname);
  renderRoute();
}

function relativeTime(dateValue) {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(dateValue).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return "yesterday";
  return `${Math.floor(seconds / 86400)}d ago`;
}

function loading(label = "Loading…") {
  app.innerHTML = `<div class="loading-screen"><span class="brand-mark"><i></i><i></i><i></i></span><p>${escapeHtml(label)}</p></div>`;
}

function showError(error, backPath = "/") {
  app.innerHTML = `<div class="error-screen">
    ${brand()}
    <div class="error-card"><span class="error-symbol">!</span><h1>We hit a small snag</h1><p>${escapeHtml(error.message)}</p><button class="primary" id="error-back">Go back</button></div>
  </div>`;
  document.querySelector("#error-back")?.addEventListener("click", () => navigate(backPath));
  bindLinks();
}

function bindLinks() {
  document.querySelectorAll("[data-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(link.getAttribute("href"));
    });
  });
  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    const button = document.querySelector("#logout-button");
    button.disabled = true;
    button.textContent = "Signing out…";
    try { await api("/api/v1/login-sessions/current", { method: "DELETE" }); } catch {}
    currentUser = null;
    activeSession = null;
    navigate("/");
  });
}

async function requireAdmin() {
  if (currentUser) return true;
  try {
    const result = await api("/api/v1/login-sessions/current");
    currentUser = result.user;
    return true;
  } catch (error) {
    if (error.status === 401) {
      renderAuth();
      return false;
    }
    showError(error);
    return false;
  }
}

function renderAuth(mode = "login", message = "") {
  const registering = mode === "register";
  app.innerHTML = `<div class="auth-shell">
    <div class="auth-brand">${brand()}</div>
    <main class="auth-layout">
      <section class="auth-story">
        <p class="eyebrow">YOUR WORKSPACE</p>
        <h1>Voting topics that bring everyone into the room.</h1>
        <p>Create live votes, share a QR code, and understand the room in seconds.</p>
        <div class="auth-preview"><span class="status live"><i></i>Live responses</span><strong>Fast to ask.<br />Easy to answer.</strong><div class="preview-bars"><i></i><i></i><i></i></div></div>
      </section>
      <section class="auth-card">
        <div class="auth-tabs"><button data-auth-mode="login" class="${registering ? "" : "active"}">Sign in</button><button data-auth-mode="register" class="${registering ? "active" : ""}">Sign up</button></div>
        <div class="auth-heading"><p class="eyebrow">${registering ? "CREATE AN ACCOUNT" : "WELCOME BACK"}</p><h2>${registering ? "Sign up for InstantVote" : "Sign in to InstantVote"}</h2><p>${registering ? "Choose a username and password to manage your voting sessions." : "Use your username to access your voting sessions."}</p></div>
        ${message ? `<div class="auth-message">${escapeHtml(message)}</div>` : ""}
        <form id="auth-form" class="auth-form">
          <label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="40" ${registering ? `pattern="[A-Za-z0-9_-]+" title="Use only letters, numbers, underscores, and hyphens"` : ""} placeholder="${registering ? "Choose a username" : "Your username"}" />${registering ? `<small>Letters, numbers, underscores, and hyphens only.</small>` : ""}</label>
          <label>Password<input name="password" type="password" autocomplete="${registering ? "new-password" : "current-password"}" required minlength="10" placeholder="At least 10 characters" /></label>
          <button class="primary auth-submit" type="submit">${registering ? "Create account" : "Sign in"}</button>
        </form>
        <p class="auth-footnote">Your account is for managing voting sessions. Guests vote anonymously with a device ID. <a href="/api-docs" data-link>View API docs</a>.</p>
      </section>
    </main>
  </div>`;
  bindLinks();
  document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => renderAuth(button.dataset.authMode)));
  document.querySelector("#auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = registering ? "Creating account…" : "Signing in…";
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api(registering ? "/api/v1/users" : "/api/v1/login-sessions", { method: "POST", body: JSON.stringify(data) });
      currentUser = registering ? result : result.user;
      window.history.replaceState({}, "", "/");
      renderDashboard();
    } catch (error) {
      renderAuth(mode, error.message);
    }
  });
}

async function renderDashboard() {
  loading("Opening your workspace…");
  if (!(await requireAdmin())) return;
  try {
    const sessions = await api("/api/v1/voting-sessions");
    const rows = sessions.length
      ? sessions.map((session, index) => `<article class="session-row" data-session="${escapeHtml(session.id)}" tabindex="0" role="link" aria-label="Edit ${escapeHtml(session.question)}">
          <div class="session-main"><div class="card-icon ${palette[index % palette.length]}">${symbols[index % symbols.length]}</div><div class="session-copy"><div class="session-meta"><span class="status ${session.live ? "live" : "closed"}"><i></i>${session.live ? "Live" : "Closed"}</span><span>${session.optionsCount} answer choices</span></div><h2>${escapeHtml(session.question)}</h2></div></div>
          <div class="row-metrics"><div class="row-metric audience-metric"><span class="people"><i></i><i></i><i></i></span><small>Audience</small></div><div class="row-metric"><strong>${session.totalVotes.toLocaleString()}</strong><small>Vote${session.totalVotes === 1 ? "" : "s"}</small></div><div class="row-metric activity-metric"><strong>${relativeTime(session.updatedAt)}</strong><small>Updated</small></div></div>
          <span class="card-actions"><button aria-label="View results for ${escapeHtml(session.question)}" data-view="${escapeHtml(session.id)}" class="eye-icon"></button><button aria-label="Edit ${escapeHtml(session.question)}" data-edit="${escapeHtml(session.id)}" class="pencil-icon">✎</button></span>
        </article>`).join("")
      : `<div class="empty-state"><div class="card-icon blue">✦</div><h2>Your first voting topic starts here</h2><p>Create a session, add a few choices, then share it with your audience.</p><button class="primary" id="empty-new">Create a session</button></div>`;

    app.innerHTML = `<div class="shell dashboard-shell"><header class="topbar">${brand()}${profile()}</header><section class="dashboard"><div class="page-heading"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>Voting sessions</h1><p>Create a voting topic, share it with the room, and watch the answers roll in.</p></div><button class="primary" id="new-session"><span>＋</span> New session</button></div><div class="session-list">${rows}</div></section></div>`;
    const createSession = async () => {
      const button = document.querySelector("#new-session") || document.querySelector("#empty-new");
      if (button) { button.disabled = true; button.textContent = "Creating…"; }
      try {
        const session = await api("/api/v1/voting-sessions", { method: "POST" });
        navigate(`/session/${session.id}`);
      } catch (error) { showError(error); }
    };
    document.querySelector("#new-session")?.addEventListener("click", createSession);
    document.querySelector("#empty-new")?.addEventListener("click", createSession);
    document.querySelectorAll("[data-session]").forEach((row) => {
      const open = () => navigate(`/session/${row.dataset.session}`);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(); });
    });
    document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); navigate(`/session/${button.dataset.edit}`); }));
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); navigate(`/session/${button.dataset.view}?tab=view`); }));
    bindLinks();
  } catch (error) {
    if (error.status === 401) { currentUser = null; renderAuth(); }
    else showError(error);
  }
}

function ownerHeader(session, tab) {
  return `<header class="topbar owner-topbar">${brand()}${profile()}</header><div class="session-nav"><div class="session-nav-inner"><a class="back-link" href="/" data-link><span>←</span> All sessions</a><div class="tabs" role="tablist" aria-label="Session workspace"><a href="/session/${escapeHtml(session.id)}" data-link class="tab ${tab === "edit" ? "active" : ""}" role="tab" aria-selected="${tab === "edit"}">Edit</a><a href="/session/${escapeHtml(session.id)}?tab=view" data-link class="tab ${tab === "view" ? "active" : ""}" role="tab" aria-selected="${tab === "view"}">View</a></div><div class="nav-status"><span class="status ${session.live ? "live" : "closed"}"><i></i>${session.live ? "Live" : "Closed"}</span></div></div></div>`;
}

function editMarkup(session) {
  const options = session.options.map((option, index) => `<div class="answer-row" data-option-row="${escapeHtml(option.id)}"><button type="button" class="drag-handle" data-drag-option="${escapeHtml(option.id)}" aria-label="Reorder answer choice ${index + 1}. Use the up and down arrow keys, or drag." title="Drag to reorder">⠿</button><span class="answer-letter ${palette[index % palette.length]}">${String.fromCharCode(65 + index)}</span><input class="answer-input" value="${escapeHtml(option.text)}" data-option-input="${escapeHtml(option.id)}" aria-label="Answer choice ${index + 1}" maxlength="200" /><button class="delete-answer" data-delete-option="${escapeHtml(option.id)}" aria-label="Delete answer choice ${index + 1}">×</button></div>`).join("");
  return `<div class="owner-shell">${ownerHeader(session, "edit")}<section class="editor-page"><div class="editor-heading"><div><p class="eyebrow">SESSION BUILDER</p><h1>Shape your voting topic</h1><p>Changes save automatically and appear on the voting page.</p></div><div class="save-wrap"><span class="save-state" id="save-state">All changes saved</span><button class="primary small" id="save-button">Save changes</button></div></div><div class="editor-grid"><div class="editor-card"><div class="field-group"><div class="label-row"><label for="question">Voting topic</label><span>Keep it clear and specific</span></div><textarea id="question" maxlength="500" rows="3">${escapeHtml(session.question)}</textarea></div><div class="field-group answers-group"><div class="label-row"><label>Answer choices</label><span>${session.options.length} options</span></div><div id="answer-list">${options}</div><button class="add-answer" id="add-answer"><span>＋</span> Add another choice</button></div><div class="session-availability"><div><strong>Voting is ${session.live ? "open" : "closed"}</strong><p>${session.live ? "Anyone with the link can answer." : "The voting page is paused."}</p></div><label class="switch"><input type="checkbox" id="live-toggle" ${session.live ? "checked" : ""} /><span></span></label></div><div class="delete-zone"><div><strong>Delete session</strong><p>Removes it from your workspace and closes its public voting link.</p></div><button class="danger-button" id="delete-session">Delete</button></div></div><aside class="share-card"><div class="share-heading"><span class="share-spark">⌁</span><div><p class="eyebrow">READY TO SHARE</p><h2>Invite people to vote</h2></div></div><div class="qr-frame"><img src="${session.qrCode}" alt="QR code for the public voting page" /><span class="qr-logo"><i></i><i></i><i></i></span></div><p class="scan-note">Scan the QR code or share the link below. Votes appear instantly in your View tab.</p><label for="vote-url">Voting link</label><div class="url-field"><textarea id="vote-url" readonly rows="3">${escapeHtml(session.votingUrl)}</textarea><button id="copy-url" aria-label="Copy voting link">Copy</button></div><a class="preview-link" href="/vote/${escapeHtml(session.id)}" target="_blank">Open voting page <span>↗</span></a><div class="share-count"><span class="mini-avatars"><i></i><i></i><i></i></span><strong>${session.totalVotes.toLocaleString()} people have voted</strong></div></aside></div></section></div>`;
}

async function saveSession({ immediate = false } = {}) {
  clearTimeout(saveTimer);
  const sessionId = activeSession.id;
  const payload = { question: activeSession.question, options: activeSession.options.map((option) => ({ ...option })), live: activeSession.live };
  const perform = async () => {
    const state = document.querySelector("#save-state");
    if (state) state.textContent = "Saving…";
    try {
      await api(`/api/v1/voting-sessions/${sessionId}`, { method: "PUT", body: JSON.stringify(payload) });
      if (state) { state.textContent = "All changes saved"; state.classList.remove("error"); }
    } catch (error) {
      if (state) { state.textContent = error.message; state.classList.add("error"); }
    }
  };
  if (immediate) await perform(); else saveTimer = setTimeout(perform, 550);
}

function bindEditor() {
  bindLinks();
  const question = document.querySelector("#question");
  question?.addEventListener("input", () => { activeSession.question = question.value; saveSession(); });
  document.querySelectorAll("[data-option-input]").forEach((input) => input.addEventListener("input", () => { const option = activeSession.options.find((item) => item.id === input.dataset.optionInput); if (option) option.text = input.value; saveSession(); }));
  const answerList = document.querySelector("#answer-list");
  const commitAnswerOrder = (focusId) => {
    const ids = [...answerList.querySelectorAll("[data-option-row]")].map((row) => row.dataset.optionRow);
    const currentIds = activeSession.options.map((option) => option.id);
    if (ids.every((id, index) => id === currentIds[index])) return;
    activeSession.options = ids.map((id) => activeSession.options.find((option) => option.id === id));
    renderEditorFromState();
    saveSession();
    if (focusId) requestAnimationFrame(() => [...document.querySelectorAll("[data-drag-option]")].find((handle) => handle.dataset.dragOption === focusId)?.focus());
  };
  document.querySelectorAll("[data-drag-option]").forEach((handle) => {
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const id = handle.dataset.dragOption;
      const index = activeSession.options.findIndex((option) => option.id === id);
      const nextIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (index < 0 || nextIndex < 0 || nextIndex >= activeSession.options.length) return;
      const reordered = [...activeSession.options];
      [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
      activeSession.options = reordered;
      renderEditorFromState(); saveSession();
      requestAnimationFrame(() => [...document.querySelectorAll("[data-drag-option]")].find((item) => item.dataset.dragOption === id)?.focus());
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const row = handle.closest("[data-option-row]");
      if (!row) return;
      event.preventDefault(); handle.focus(); row.classList.add("dragging"); handle.classList.add("grabbing");
      const startY = event.clientY; let moved = false;
      const move = (pointerEvent) => {
        if (Math.abs(pointerEvent.clientY - startY) < 5 && !moved) return;
        moved = true; pointerEvent.preventDefault();
        const target = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest("[data-option-row]");
        if (!target || target === row || target.parentElement !== answerList) return;
        const bounds = target.getBoundingClientRect();
        answerList.insertBefore(row, pointerEvent.clientY > bounds.top + bounds.height / 2 ? target.nextElementSibling : target);
      };
      const finish = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish);
        row.classList.remove("dragging"); handle.classList.remove("grabbing"); if (moved) commitAnswerOrder(handle.dataset.dragOption);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
    });
  });
  document.querySelector("#live-toggle")?.addEventListener("change", (event) => { activeSession.live = event.target.checked; saveSession({ immediate: true }); renderEditorFromState(); });
  document.querySelector("#save-button")?.addEventListener("click", () => saveSession({ immediate: true }));
  document.querySelector("#add-answer")?.addEventListener("click", () => { activeSession.options.push({ id: createUuid(), text: `Choice ${activeSession.options.length + 1}` }); renderEditorFromState(); saveSession(); });
  document.querySelectorAll("[data-delete-option]").forEach((button) => button.addEventListener("click", () => {
    if (activeSession.options.length <= 2) { const state = document.querySelector("#save-state"); if (state) { state.textContent = "Keep at least two choices"; state.classList.add("error"); } return; }
    activeSession.options = activeSession.options.filter((option) => option.id !== button.dataset.deleteOption); renderEditorFromState(); saveSession();
  }));
  document.querySelector("#copy-url")?.addEventListener("click", async (event) => {
    const field = document.querySelector("#vote-url");
    try { await navigator.clipboard.writeText(field.value); } catch { field.select(); document.execCommand("copy"); }
    event.currentTarget.textContent = "Copied!"; setTimeout(() => { if (event.currentTarget) event.currentTarget.textContent = "Copy"; }, 1400);
  });
  document.querySelector("#delete-session")?.addEventListener("click", async () => {
    if (!window.confirm("Delete this voting session? Its public link will stop working.")) return;
    const button = document.querySelector("#delete-session"); button.disabled = true; button.textContent = "Deleting…";
    try { await api(`/api/v1/voting-sessions/${activeSession.id}`, { method: "DELETE" }); activeSession = null; navigate("/"); }
    catch (error) { button.disabled = false; button.textContent = "Delete"; const state = document.querySelector("#save-state"); if (state) { state.textContent = error.message; state.classList.add("error"); } }
  });
}

function renderEditorFromState() { app.innerHTML = editMarkup(activeSession); bindEditor(); }

async function renderEditor(id) {
  loading("Preparing your session…");
  if (!(await requireAdmin())) return;
  try { activeSession = await api(`/api/v1/voting-sessions/${encodeURIComponent(id)}`); renderEditorFromState(); }
  catch (error) { if (error.status === 401) { currentUser = null; renderAuth(); } else showError(error); }
}

function resultsMarkup(session, results) {
  const transitions = resultBarTransitions(previousResults, results);
  const bars = results.options.map((option, index) => {
    const transition = transitions.get(option.id);
    return `<div class="result-item"><div class="result-label"><span class="answer-letter ${palette[index % palette.length]}">${String.fromCharCode(65 + index)}</span><strong>${escapeHtml(option.text)}</strong><span>${option.votes.toLocaleString()} vote${option.votes === 1 ? "" : "s"}</span><b>${option.percentage}%</b></div><div class="result-track"><i class="${palette[index % palette.length]} ${transition.animate ? "animate" : ""}" style="--result-start:${transition.startPercentage}%;--result-width:${option.percentage}%"></i></div></div>`;
  }).join("");
  return `<div class="owner-shell">${ownerHeader(session, "view")}<section class="results-page"><div class="results-heading"><div><p class="eyebrow">LIVE RESULTS</p><h1>${escapeHtml(results.question)}</h1><p>Results update automatically as people make or change their choice.</p></div></div><div class="results-grid"><div class="results-card"><div class="results-card-head"><div><span class="pulse-dot"></span><strong>${results.live ? "Collecting responses" : "Voting closed"}</strong></div><span>Updated ${relativeTime(results.updatedAt)}</span></div><div class="results-list">${bars}</div></div><aside class="vote-total-card"><span class="total-icon">●●●</span><strong>${results.totalVotes.toLocaleString()}</strong><h2>${results.totalVotes === 1 ? "person has" : "people have"} voted</h2><p>Each guest is counted once, even if they change their answer.</p><a href="/vote/${escapeHtml(session.id)}" target="_blank" class="preview-link">Open voting page <span>↗</span></a></aside></div></section></div>`;
}

async function renderResults(id, { quiet = false } = {}) {
  if (!quiet) loading("Tallying the results…");
  if (!(await requireAdmin())) return;
  try {
    const [session, results] = await Promise.all([activeSession?.id === id ? activeSession : api(`/api/v1/voting-sessions/${encodeURIComponent(id)}`), api(`/api/v1/voting-sessions/${encodeURIComponent(id)}/results`)]);
    activeSession = session; app.innerHTML = resultsMarkup(session, results); previousResults = results;
    bindLinks(); clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (window.location.pathname === `/session/${id}` && new URLSearchParams(window.location.search).get("tab") === "view") renderResults(id, { quiet: true }); }, 5000);
  } catch (error) { if (error.status === 401) { currentUser = null; renderAuth(); } else showError(error); }
}

function guestId() {
  const key = "instantvote_guest_id";
  let id = localStorage.getItem(key);
  if (!uuidPattern.test(id || "")) { id = createUuid(); localStorage.setItem(key, id); }
  return id;
}

function voteMarkup(session, selected) {
  const answers = session.options.map((option, index) => `<button class="vote-choice ${selected === option.id ? "selected" : ""}" data-vote="${escapeHtml(option.id)}" ${session.live ? "" : "disabled"} aria-pressed="${selected === option.id}"><span class="choice-letter ${palette[index % palette.length]}">${String.fromCharCode(65 + index)}</span><strong>${escapeHtml(option.text)}</strong><span class="choice-check">✓</span></button>`).join("");
  return `<div class="vote-shell"><header class="vote-topbar">${brand()}<div class="vote-header-actions"><a class="history-link" href="/history" data-link>My voting history</a><span class="status ${session.live ? "live" : "closed"}"><i></i>${session.live ? "Live vote" : "Voting closed"}</span></div></header><main class="voting-page"><div class="voting-card"><div class="voting-intro"><p class="eyebrow">MAKE YOUR PICK</p><span class="question-count">1 voting topic</span></div><h1>${escapeHtml(session.question)}</h1><p class="voting-help">Choose one answer. You can change your mind at any time.</p><div class="vote-options">${answers}</div><div class="vote-message ${selected ? "visible" : ""}" id="vote-message"><span>✓</span><p><strong>Your vote is in.</strong> Change it anytime by choosing another answer.</p></div>${session.live ? "" : `<div class="closed-message">This session is no longer accepting votes.</div>`}</div><p class="powered-by">Powered by <strong>instant<span>vote</span></strong></p></main></div>`;
}

async function renderVoting(id) {
  loading("Joining the vote…");
  try {
    const session = await api(`/api/v1/ballots/${encodeURIComponent(id)}`);
    const selectionKey = `instantvote-selection-${session.id}`;
    let selected = localStorage.getItem(selectionKey);
    if (!session.options.some((option) => option.id === selected)) selected = null;
    app.innerHTML = voteMarkup(session, selected); bindLinks();
    document.querySelectorAll("[data-vote]").forEach((button) => button.addEventListener("click", async () => {
      if (button.disabled) return;
      document.querySelectorAll("[data-vote]").forEach((choice) => { choice.disabled = true; choice.classList.add("waiting"); });
      try {
        const voterId = guestId();
        await api(`/api/v1/ballots/${session.id}/votes/${voterId}`, { method: "PUT", body: JSON.stringify({ answerId: button.dataset.vote }) });
        localStorage.setItem(selectionKey, button.dataset.vote);
        document.querySelectorAll("[data-vote]").forEach((choice) => { const isSelected = choice.dataset.vote === button.dataset.vote; choice.classList.toggle("selected", isSelected); choice.setAttribute("aria-pressed", String(isSelected)); choice.disabled = false; choice.classList.remove("waiting"); });
        document.querySelector("#vote-message")?.classList.add("visible");
      } catch (error) {
        document.querySelectorAll("[data-vote]").forEach((choice) => { choice.disabled = false; choice.classList.remove("waiting"); });
        const message = document.querySelector("#vote-message"); if (message) { message.innerHTML = `<span>!</span><p><strong>Vote not saved.</strong> ${escapeHtml(error.message)}</p>`; message.classList.add("visible", "error"); }
      }
    }));
  } catch (error) { showError(error); }
}

async function renderHistory() {
  loading("Finding your votes…");
  try {
    const id = guestId();
    const history = await api(`/api/v1/guests/${id}/votes`);
    const rows = history.length ? history.map((item, index) => `<article class="history-item"><span class="answer-letter ${palette[index % palette.length]}">${String.fromCharCode(65 + (index % 26))}</span><div class="history-copy"><span>${item.live ? "Open session" : item.sessionAvailable ? "Voting closed" : "Session removed"}</span><h2>${escapeHtml(item.question)}</h2><p>You chose <strong>${escapeHtml(item.answerText)}</strong> · ${new Date(item.votedAt).toLocaleString()}</p></div>${item.sessionAvailable ? `<a href="/vote/${escapeHtml(item.sessionId)}" data-link>View vote →</a>` : ""}</article>`).join("") : `<div class="history-empty"><div class="card-icon blue">✓</div><h2>No votes on this device yet</h2><p>After you vote on a topic, it will appear here automatically.</p></div>`;
    app.innerHTML = `<div class="vote-shell"><header class="vote-topbar">${brand()}<span class="guest-badge">Guest ${escapeHtml(id.slice(-8))}</span></header><main class="history-page"><a href="/" data-link class="back-link"><span>←</span> Back</a><div class="history-heading"><p class="eyebrow">THIS DEVICE</p><h1>My voting history</h1><p>Your guest ID stays in this browser. Clearing browser storage removes access to this history.</p></div><div class="history-list">${rows}</div></main></div>`;
    bindLinks();
  } catch (error) { showError(error); }
}

function scrollToApiExplanation() {
  let id;
  try { id = decodeURIComponent(window.location.hash.slice(1)); }
  catch { return; }
  if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
}

async function renderApiDocs() {
  loading("Loading API reference…");
  try {
    const specification = await api("/openapi.json");
    const methods = ["get", "post", "put", "patch", "delete"];
    const operations = Object.entries(specification.paths).flatMap(([path, pathItem]) => methods
      .filter((method) => pathItem[method])
      .map((method) => ({ path, method, ...pathItem[method] })));
    const basePath = specification.servers?.[0]?.url || "/api/v1";
    const resolveReference = (reference) => reference?.startsWith("#/")
      ? reference.slice(2).split("/").reduce((value, key) => value?.[key], specification)
      : null;
    const navigation = operations.map((operation) => `<a href="#${escapeHtml(operation.operationId)}"><span class="docs-method ${operation.method}">${operation.method.toUpperCase()}</span><code>${escapeHtml(operation.path)}</code></a>`).join("");
    const endpointCards = operations.map((operation) => {
      const authenticated = Array.isArray(operation.security) && operation.security.length > 0;
      const requestSchema = operation.requestBody?.content?.["application/json"]?.schema?.$ref?.split("/").pop();
      const responses = Object.entries(operation.responses || {}).map(([status, response]) => {
        const resolvedResponse = response.$ref ? resolveReference(response.$ref) : response;
        return `<span><b>${escapeHtml(status)}</b> ${escapeHtml(resolvedResponse?.description || "Response")}</span>`;
      }).join("");
      return `<article class="docs-endpoint" id="${escapeHtml(operation.operationId)}" tabindex="-1">
        <div class="docs-endpoint-line"><span class="docs-method ${operation.method}">${operation.method.toUpperCase()}</span><code>${escapeHtml(basePath + operation.path)}</code><span class="docs-auth ${authenticated ? "required" : "public"}">${authenticated ? "Cookie auth" : "Public"}</span></div>
        <h2>${escapeHtml(operation.summary || operation.operationId)}</h2>
        <p>${escapeHtml(operation.description || "")}</p>
        ${requestSchema ? `<div class="docs-request"><strong>JSON body</strong><code>${escapeHtml(requestSchema)}</code></div>` : ""}
        <div class="docs-responses"><strong>Responses</strong><div>${responses}</div></div>
      </article>`;
    }).join("");

    app.innerHTML = `<div class="docs-shell">
      <header class="topbar docs-topbar">${brand()}<div><a class="docs-download" href="/openapi.json" target="_blank">OpenAPI JSON ↗</a><a class="secondary" href="/" data-link>Back to app</a></div></header>
      <main class="docs-page">
        <aside class="docs-sidebar"><p class="eyebrow">API REFERENCE</p><h2>${escapeHtml(specification.info.title)}</h2><p>Version ${escapeHtml(specification.info.version)}</p><div class="docs-base"><span>Base path</span><code>${escapeHtml(basePath)}</code></div><nav>${navigation}</nav></aside>
        <section class="docs-content">
          <div class="docs-hero"><p class="eyebrow">OPENAPI ${escapeHtml(specification.openapi)}</p><h1>InstantVote API</h1><p>${escapeHtml(specification.info.description)}</p><div class="docs-summary"><span><strong>${operations.length}</strong> operations</span><span><strong>JSON</strong> request bodies</span><span><strong>UUID</strong> resource IDs</span></div></div>
          <section class="docs-auth-card"><div class="docs-lock">●</div><div><h2>Authentication</h2><p>Owner endpoints use the secure <code>instantvote_admin_session</code> cookie created by the login-session resource. Ballots and guest vote history are public.</p></div></section>
          <div class="docs-endpoints">${endpointCards}</div>
        </section>
      </main>
    </div>`;
    bindLinks();
    scrollToApiExplanation();
  } catch (error) { showError(error); }
}

function renderNotFound() {
  app.innerHTML = `<div class="error-screen">${brand()}<div class="error-card"><span class="error-symbol">?</span><h1>Nothing to vote on here</h1><p>This link may be incomplete or the session may no longer exist.</p><button class="primary" id="error-back">Go home</button></div></div>`;
  document.querySelector("#error-back")?.addEventListener("click", () => navigate("/")); bindLinks();
}

function renderRoute() {
  clearTimeout(refreshTimer);
  renderedRoute = window.location.pathname + window.location.search;
  const route = window.location.pathname.replace(/\/$/, "") || "/";
  if (route === "/") return renderDashboard();
  if (route === "/api-docs") return renderApiDocs();
  if (route === "/history") return renderHistory();
  const sessionMatch = route.match(/^\/session\/([^/]+)$/);
  if (sessionMatch) { const tab = new URLSearchParams(window.location.search).get("tab"); return tab === "view" ? renderResults(decodeURIComponent(sessionMatch[1])) : renderEditor(decodeURIComponent(sessionMatch[1])); }
  const voteMatch = route.match(/^\/vote\/([^/]+)$/);
  if (voteMatch) return renderVoting(decodeURIComponent(voteMatch[1]));
  renderNotFound();
}

// The shared footer stays mounted while route content and live results update.
document.querySelector(".footer-api-link")?.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("/api-docs");
});

window.addEventListener("popstate", () => {
  // Native fragment navigation scrolls in-place; only rebuild for a different page or tab.
  if (renderedRoute !== window.location.pathname + window.location.search) renderRoute();
});
renderRoute();
