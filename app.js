/* ================= Puzzle Duel Calendar ================= */

const GAMES = [
  { key: "zip", label: "Zip" },
  { key: "pinpoint", label: "Pinpoint" },
  { key: "sudoku", label: "Mini Sudoku" },
  { key: "queens", label: "Queens" },
  { key: "patches", label: "Patches" },
];
const GAME_KEYS = GAMES.map((g) => g.key);
const MY_GREEN = "#057642";
const DEFAULT_FRIEND_COLOR = "#0a66c2";
const MIN_YEAR = 2026, MIN_MONTH = 6; // July 2026 (month is 0-indexed)
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SWATCH_COLORS = ["#0a66c2", "#e8722a", "#9b59b6", "#e74c3c", "#f1c40f", "#16a2b8", "#e84393", "#795548"];

const S = {
  localMode: false,
  token: localStorage.getItem("plt-token") || null,
  me: null,        // { key: 'editor'|'viewer', name, color }
  users: null,     // { editor: {name,color}, viewer: {name,color} }
  marks: {},       // { gameKey: { 'YYYY-MM-DD': 'editor'|'viewer' } }
  game: GAME_KEYS[0],
  view: null,      // { y, m }
};

const $ = (id) => document.getElementById(id);

/* ---------------- helpers ---------------- */

function pad(n) { return String(n).padStart(2, "0"); }
function dateKey(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function todayKey() { const t = new Date(); return dateKey(t.getFullYear(), t.getMonth(), t.getDate()); }

/* Marking deadline: a day stays editable until 12:01 PM (IST) the NEXT day, then locks. */
const TZ_OFFSET_MIN = 330; // IST (UTC+5:30) — the players' timezone
const LOCK_HOUR = 12, LOCK_MINUTE = 1;
function todayKeyTz() {
  const t = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  return dateKey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
function isLocked(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const deadlineUtcMs = Date.UTC(y, m - 1, d + 1, LOCK_HOUR, LOCK_MINUTE) - TZ_OFFSET_MIN * 60000;
  return Date.now() > deadlineUtcMs;
}
function canIEdit() {
  return S.me.key === "editor" || (S.me.key === "viewer" && !!S.users.viewer.canEdit);
}
function currentYM() { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; }
function ymCompare(a, b) { return a.y !== b.y ? a.y - b.y : a.m - b.m; }
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

function friendColor() {
  return (S.users && S.users.viewer.color) || DEFAULT_FRIEND_COLOR;
}

/* ---------------- Local (browser-only) backend ---------------- */
/* Used automatically when the site is served without the Netlify function
   (e.g. opened locally). Mirrors the serverless API using localStorage. */

const Local = {
  load() {
    return JSON.parse(localStorage.getItem("plt-data") || "null") ||
      { setup: false, users: null, sessions: {}, marks: {} };
  },
  save(d) { localStorage.setItem("plt-data", JSON.stringify(d)); },

  async status() { return { setup: this.load().setup }; },

  async setup(b) {
    const d = this.load();
    if (d.setup) throw new Error("Already set up");
    validateSetup(b);
    d.users = {
      editor: { name: b.ownerName.trim(), passHash: await sha256(b.ownerPass), color: MY_GREEN },
      viewer: { name: b.friendName.trim(), passHash: await sha256(b.friendPass), color: null },
    };
    d.setup = true;
    d.marks = {};
    this.save(d);
    return { ok: true };
  },

  async login(b) {
    const d = this.load();
    if (!d.setup) throw new Error("Not set up yet");
    const hash = await sha256(b.pass || "");
    const key = ["editor", "viewer"].find(
      (k) => d.users[k].name.toLowerCase() === (b.name || "").trim().toLowerCase() && d.users[k].passHash === hash
    );
    if (!key) throw new Error("Wrong name or password");
    const token = crypto.randomUUID();
    d.sessions[token] = key;
    this.save(d);
    return { token, ...publicState(d, key) };
  },

  _auth(d) {
    const key = d.sessions[S.token];
    if (!key) throw new Error("Session expired — log in again");
    return key;
  },

  async state() { const d = this.load(); return publicState(d, this._auth(d)); },

  async mark(b) {
    const d = this.load();
    const key = this._auth(d);
    if (key !== "editor" && !d.users.viewer.canEdit) throw new Error("View-only account");
    validateMark(b, key);
    d.marks[b.game] = d.marks[b.game] || {};
    if (b.value === null) delete d.marks[b.game][b.date];
    else d.marks[b.game][b.date] = b.value;
    this.save(d);
    return publicState(d, key);
  },

  async access(b) {
    const d = this.load();
    const key = this._auth(d);
    if (key !== "editor") throw new Error("Only the editor can change access");
    d.users.viewer.canEdit = !!b.canEdit;
    this.save(d);
    return publicState(d, key);
  },

  async password(b) {
    const d = this.load();
    const key = this._auth(d);
    if (key !== "editor") throw new Error("Only the editor can change passwords");
    validatePassword(b);
    d.users[b.target].passHash = await sha256(b.newPass);
    for (const [t, k] of Object.entries(d.sessions))
      if (k === b.target && t !== S.token) delete d.sessions[t];
    this.save(d);
    return { ok: true };
  },

  async color(b) {
    const d = this.load();
    const key = this._auth(d);
    if (key !== "viewer") throw new Error("Only your friend picks their color");
    validateColor(b.color);
    d.users.viewer.color = b.color;
    this.save(d);
    return publicState(d, key);
  },

  async logout() {
    const d = this.load();
    delete d.sessions[S.token];
    this.save(d);
    return { ok: true };
  },
};

/* Shared validation + response shape (same rules as the serverless function) */
function validateSetup(b) {
  for (const f of ["ownerName", "ownerPass", "friendName", "friendPass"])
    if (!b[f] || !String(b[f]).trim()) throw new Error("All fields are required");
  if (b.ownerName.trim().toLowerCase() === b.friendName.trim().toLowerCase())
    throw new Error("Names must be different");
}
function validateMark(b, meKey) {
  if (!GAME_KEYS.includes(b.game)) throw new Error("Unknown game");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw new Error("Bad date");
  if (b.date < "2026-07-01") throw new Error("Calendar starts July 2026");
  if (b.date > todayKeyTz()) throw new Error("Can't mark future days");
  // the lock binds the friend; the owner-editor can always correct locked days
  if (isLocked(b.date) && meKey !== "editor") throw new Error("This day is locked (deadline was 12:01 PM next day)");
  if (![null, "editor", "viewer","draw"].includes(b.value)) throw new Error("Bad value");
}
function validatePassword(b) {
  if (!["editor", "viewer"].includes(b.target)) throw new Error("Bad target");
  if (!b.newPass || !String(b.newPass).trim()) throw new Error("Password can't be empty");
}
function validateColor(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c || "")) throw new Error("Bad color");
}
function publicState(d, meKey) {
  return {
    me: { key: meKey, name: d.users[meKey].name, color: d.users[meKey].color },
    users: {
      editor: { name: d.users.editor.name, color: d.users.editor.color },
      viewer: { name: d.users.viewer.name, color: d.users.viewer.color, canEdit: !!d.users.viewer.canEdit },
    },
    marks: d.marks,
  };
}

/* ---------------- API layer ---------------- */

async function detectBackend() {
  try {
    const r = await fetch("/api/status");
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      S.localMode = false;
      return await r.json();
    }
  } catch (_) { /* fall through */ }
  S.localMode = true;
  return Local.status();
}

async function call(path, body) {
  if (S.localMode) return Local[path](body || {});
  const res = await fetch("/api/" + path, {
    method: body !== undefined ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(S.token ? { "x-token": S.token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

/* ---------------- Rendering ---------------- */

function applyState(st) {
  S.me = st.me;
  S.users = st.users;
  S.marks = st.marks || {};
}

function showAuth(setupDone) {
  $("app-screen").classList.add("hidden");
  $("auth-screen").classList.remove("hidden");
  $("setup-card").classList.toggle("hidden", setupDone);
  $("login-card").classList.toggle("hidden", !setupDone);
  $("mode-note").textContent = S.localMode
    ? "Running in browser-only mode: data is stored in this browser. Deploy to Netlify for shared logins."
    : "";
}

function showApp() {
  $("auth-screen").classList.add("hidden");
  $("app-screen").classList.remove("hidden");

  const isEditor = S.me.key === "editor";
  const mayEdit = canIEdit();
  const badge = $("role-badge");
  badge.textContent = isEditor ? `${S.me.name} · editor`
    : mayEdit ? `${S.me.name} · can edit` : `${S.me.name} · view only`;
  badge.classList.toggle("viewer", !mayEdit);
  $("change-color-btn").classList.toggle("hidden", isEditor);
  $("pass-btn").classList.toggle("hidden", !isEditor);
  $("edit-hint").textContent = isEditor
    ? "Tap a day to cycle: blank → green → friend's color → blank. Grey = draw."
    : mayEdit
    ? "Tap a day to cycle: blank → green → friend's color → blank. Days lock at 12:01 PM the next day."
    : "View-only: your friend marks the wins.";

  renderAll();

  if (!isEditor && !S.me.color && $("color-modal").classList.contains("hidden")) openColorModal();
}

function renderAll() {
  renderScores();
  renderCalendar();
}

function countWins(gameKey) {
  const m = S.marks[gameKey] || {};
  let e = 0, v = 0;
  for (const who of Object.values(m)) who === "editor" ? e++ : v++;
  return { e, v };
}

function renderScores() {
  const g = countWins(S.game);
  const total = GAME_KEYS.reduce(
    (acc, k) => { const c = countWins(k); return { e: acc.e + c.e, v: acc.v + c.v }; },
    { e: 0, v: 0 }
  );
  const label = GAMES.find((x) => x.key === S.game).label;
  $("score-game-title").textContent = label;
  const tKey = todayKeyTz();
  const day = GAME_KEYS.reduce((acc, k) => {
    const who = (S.marks[k] || {})[tKey];
    if (who === "editor") acc.e++;
    else if (who === "viewer") acc.v++;
    return acc;
  }, { e: 0, v: 0 });
  const line = (c) =>
    `<span style="color:${MY_GREEN}">${c.e}</span><span class="vs">vs</span><span style="color:${friendColor()}">${c.v}</span>`;
  $("score-game").innerHTML = line(g);
  $("score-today").innerHTML = line(day);
  $("score-total").innerHTML = line(total);
}

function renderCalendar() {
  const { y, m } = S.view;
  $("month-label").textContent = `${MONTH_NAMES[m]} ${y}`;
  $("prev-month").disabled = ymCompare(S.view, { y: MIN_YEAR, m: MIN_MONTH }) <= 0;
  $("next-month").disabled = ymCompare(S.view, currentYM()) >= 0;

  $("weekdays").innerHTML = WEEKDAYS.map((w) => `<div>${w}</div>`).join("");

  const first = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const tKey = todayKey();
  const mayEdit = canIEdit();
  const gameMarks = S.marks[S.game] || {};

  const grid = $("calendar-grid");
  grid.innerHTML = "";

  for (let i = 0; i < first; i++) {
    const filler = document.createElement("div");
    filler.className = "cell empty-slot";
    grid.appendChild(filler);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(y, m, d);
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = d;

    const mark = gameMarks[key];
    if (mark === "editor") {
  cell.classList.add("won");
  cell.style.background = MY_GREEN;
} else if (mark === "viewer") {
  cell.classList.add("won");
  cell.style.background = friendColor();
} else if (mark === "draw") {
  cell.classList.add("won");
  cell.style.background = "#808080";
}

    if (key === tKey) cell.classList.add("today");

    const lockedForMe = isLocked(key) && S.me.key !== "editor";
    const markable = key >= "2026-07-01" && key <= todayKeyTz() && !lockedForMe;
    if (key > tKey) cell.classList.add("disabled");
    if (lockedForMe && !mark) cell.classList.add("disabled");
    if (mayEdit && markable) {
      cell.classList.add("clickable");
      cell.addEventListener("click", () => cycleMark(key, mark));
    }
    grid.appendChild(cell);
  }
}

async function cycleMark(dateStr, current) {
  const next =
    current === undefined ? "editor" :
    current === "editor" ? "viewer" :
    current === "viewer" ? "draw" :
    null;

  try {
    const st = await call("mark", {
      game: S.game,
      date: dateStr,
      value: next
    });
    applyState(st);
    renderAll();
  } catch (e) {
    toast(e.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- Color modal ---------------- */

let chosenColor = null;

function openColorModal() {
  chosenColor = S.me.color || DEFAULT_FRIEND_COLOR;
  const wrap = $("swatches");
  wrap.innerHTML = "";
  for (const c of SWATCH_COLORS) {
    const sw = document.createElement("div");
    sw.className = "swatch" + (c === chosenColor ? " selected" : "");
    sw.style.background = c;
    sw.addEventListener("click", () => {
      chosenColor = c;
      wrap.querySelectorAll(".swatch").forEach((el) => el.classList.remove("selected"));
      sw.classList.add("selected");
    });
    wrap.appendChild(sw);
  }
  $("custom-color").value = chosenColor;
  $("color-modal").classList.remove("hidden");
}

$("custom-color").addEventListener("input", (e) => {
  chosenColor = e.target.value;
  document.querySelectorAll("#swatches .swatch").forEach((el) => el.classList.remove("selected"));
});

$("save-color").addEventListener("click", async () => {
  try {
    const st = await call("color", { color: chosenColor });
    applyState(st);
    $("color-modal").classList.add("hidden");
    renderAll();
    toast("Color saved!");
  } catch (e) {
    toast(e.message);
  }
});

/* ---------------- Password modal (editor only) ---------------- */

$("pass-btn").addEventListener("click", () => {
  $("pass-target").innerHTML = `
    <option value="viewer">${escapeHtml(S.users.viewer.name)} (friend)</option>
    <option value="editor">${escapeHtml(S.users.editor.name)} (you)</option>
  `;
  $("pass-new").value = "";
  $("pass-err").textContent = "";
  $("access-toggle").checked = !!S.users.viewer.canEdit;
  $("access-label").textContent = `Allow ${S.users.viewer.name} to edit the calendars`;
  $("pass-modal").classList.remove("hidden");
});

$("access-toggle").addEventListener("change", async (e) => {
  try {
    const st = await call("access", { canEdit: e.target.checked });
    applyState(st);
    renderAll();
    toast(e.target.checked ? `${S.users.viewer.name} can now edit` : `${S.users.viewer.name} is view-only`);
  } catch (err) {
    e.target.checked = !e.target.checked;
    $("pass-err").textContent = err.message;
  }
});

$("pass-cancel").addEventListener("click", () => $("pass-modal").classList.add("hidden"));

$("pass-save").addEventListener("click", async () => {
  $("pass-err").textContent = "";
  try {
    const target = $("pass-target").value;
    await call("password", { target, newPass: $("pass-new").value });
    $("pass-modal").classList.add("hidden");
    toast(`Password updated for ${S.users[target].name}`);
  } catch (e) {
    $("pass-err").textContent = e.message;
  }
});

/* ---------------- Events ---------------- */

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("setup-err").textContent = "";
  const body = {
    ownerName: $("su-owner-name").value,
    ownerPass: $("su-owner-pass").value,
    friendName: $("su-friend-name").value,
    friendPass: $("su-friend-pass").value,
  };
  try {
    await call("setup", body);
    const st = await call("login", { name: body.ownerName, pass: body.ownerPass });
    S.token = st.token;
    localStorage.setItem("plt-token", st.token);
    applyState(st);
    showApp();
  } catch (err) {
    $("setup-err").textContent = err.message;
  }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-err").textContent = "";
  try {
    const st = await call("login", { name: $("li-name").value, pass: $("li-pass").value });
    S.token = st.token;
    localStorage.setItem("plt-token", st.token);
    applyState(st);
    showApp();
  } catch (err) {
    $("login-err").textContent = err.message;
  }
});

$("logout-btn").addEventListener("click", async () => {
  try { await call("logout", {}); } catch (_) {}
  S.token = null;
  localStorage.removeItem("plt-token");
  location.reload();
});

$("refresh-btn").addEventListener("click", refresh);
$("change-color-btn").addEventListener("click", openColorModal);

$("game-select").addEventListener("change", (e) => {
  S.game = e.target.value;
  renderAll();
});

$("prev-month").addEventListener("click", () => {
  S.view = S.view.m === 0 ? { y: S.view.y - 1, m: 11 } : { y: S.view.y, m: S.view.m - 1 };
  renderCalendar();
});
$("next-month").addEventListener("click", () => {
  S.view = S.view.m === 11 ? { y: S.view.y + 1, m: 0 } : { y: S.view.y, m: S.view.m + 1 };
  renderCalendar();
});

async function refresh() {
  try {
    const st = await call("state");
    applyState(st);
    showApp(); // full re-render so access changes (badge, clickability) apply live
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- Boot ---------------- */

(async function init() {
  $("game-select").innerHTML = GAMES.map((g) => `<option value="${g.key}">${g.label}</option>`).join("");

  const now = currentYM();
  S.view = ymCompare(now, { y: MIN_YEAR, m: MIN_MONTH }) < 0 ? { y: MIN_YEAR, m: MIN_MONTH } : now;

  const status = await detectBackend();

  if (S.token) {
    try {
      const st = await call("state");
      applyState(st);
      showApp();
    } catch (_) {
      S.token = null;
      localStorage.removeItem("plt-token");
      showAuth(status.setup);
    }
  } else {
    showAuth(status.setup);
  }

  setInterval(() => { if (S.token && S.me) refresh(); }, 60000);
})();
