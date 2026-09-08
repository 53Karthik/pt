import { getStore } from "@netlify/blobs";
import { randomUUID, createHash } from "node:crypto";

export const config = { path: "/api/*" };

const GAME_KEYS = ["zip", "pinpoint", "sudoku", "queens", "patches"];
const MY_GREEN = "#057642";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/* Marking deadline: a day stays editable until 12:01 PM (IST) the NEXT day, then locks. */
const TZ_OFFSET_MIN = 330; // IST (UTC+5:30) — the players' timezone
const LOCK_HOUR = 12, LOCK_MINUTE = 1;
const todayKey = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
function isLocked(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const deadlineUtcMs = Date.UTC(y, m - 1, d + 1, LOCK_HOUR, LOCK_MINUTE) - TZ_OFFSET_MIN * 60000;
  return Date.now() > deadlineUtcMs;
}

async function load(store) {
  return (await store.get("data", { type: "json" })) ||
    { setup: false, users: null, sessions: {}, marks: {} };
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

export default async (req) => {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const store = getStore({ name: "puzzle-tracker", consistency: "strong" });
    const data = await load(store);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const token = req.headers.get("x-token") || "";
    const meKey = data.sessions[token] || null;

    if (path === "status") return json({ setup: !!data.setup });

    if (path === "setup" && req.method === "POST") {
      if (data.setup) return json({ error: "Already set up" }, 400);
      for (const f of ["ownerName", "ownerPass", "friendName", "friendPass"])
        if (!body[f] || !String(body[f]).trim()) return json({ error: "All fields are required" }, 400);
      if (body.ownerName.trim().toLowerCase() === body.friendName.trim().toLowerCase())
        return json({ error: "Names must be different" }, 400);
      data.users = {
        editor: { name: body.ownerName.trim(), passHash: sha256(body.ownerPass), color: MY_GREEN },
        viewer: { name: body.friendName.trim(), passHash: sha256(body.friendPass), color: null },
      };
      data.setup = true;
      data.marks = {};
      await store.setJSON("data", data);
      return json({ ok: true });
    }

    if (path === "login" && req.method === "POST") {
      if (!data.setup) return json({ error: "Not set up yet" }, 400);
      const hash = sha256(body.pass || "");
      const key = ["editor", "viewer"].find(
        (k) =>
          data.users[k].name.toLowerCase() === (body.name || "").trim().toLowerCase() &&
          data.users[k].passHash === hash
      );
      if (!key) return json({ error: "Wrong name or password" }, 401);
      const newToken = randomUUID();
      data.sessions[newToken] = key;
      await store.setJSON("data", data);
      return json({ token: newToken, ...publicState(data, key) });
    }

    /* ---- everything below requires a valid session ---- */
    if (!meKey) return json({ error: "Session expired — log in again" }, 401);

    if (path === "state") return json(publicState(data, meKey));

    if (path === "logout" && req.method === "POST") {
      delete data.sessions[token];
      await store.setJSON("data", data);
      return json({ ok: true });
    }

    if (path === "mark" && req.method === "POST") {
      if (meKey !== "editor" && !data.users.viewer.canEdit) return json({ error: "View-only account" }, 403);
      if (!GAME_KEYS.includes(body.game)) return json({ error: "Unknown game" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) return json({ error: "Bad date" }, 400);
      if (body.date < "2026-07-01") return json({ error: "Calendar starts July 2026" }, 400);
      if (body.date > todayKey()) return json({ error: "Can't mark future days" }, 400);
      // the lock binds the friend; the owner-editor can always correct locked days
      if (isLocked(body.date) && meKey !== "editor") return json({ error: "This day is locked (deadline was 12:01 PM next day)" }, 400);
      if (![null, "editor", "viewer","draw"].includes(body.value)) return json({ error: "Bad value" }, 400);
      data.marks[body.game] = data.marks[body.game] || {};
      if (body.value === null) delete data.marks[body.game][body.date];
      else data.marks[body.game][body.date] = body.value;
      await store.setJSON("data", data);
      return json(publicState(data, meKey));
    }

    if (path === "access" && req.method === "POST") {
      if (meKey !== "editor") return json({ error: "Only the editor can change access" }, 403);
      data.users.viewer.canEdit = !!body.canEdit;
      await store.setJSON("data", data);
      return json(publicState(data, meKey));
    }

    if (path === "password" && req.method === "POST") {
      if (meKey !== "editor") return json({ error: "Only the editor can change passwords" }, 403);
      if (!["editor", "viewer"].includes(body.target)) return json({ error: "Bad target" }, 400);
      if (!body.newPass || !String(body.newPass).trim()) return json({ error: "Password can't be empty" }, 400);
      data.users[body.target].passHash = sha256(body.newPass);
      for (const [t, k] of Object.entries(data.sessions))
        if (k === body.target && t !== token) delete data.sessions[t];
      await store.setJSON("data", data);
      return json({ ok: true });
    }

    if (path === "color" && req.method === "POST") {
      if (meKey !== "viewer") return json({ error: "Only your friend picks their color" }, 403);
      if (!/^#[0-9a-fA-F]{6}$/.test(body.color || "")) return json({ error: "Bad color" }, 400);
      data.users.viewer.color = body.color;
      await store.setJSON("data", data);
      return json(publicState(data, meKey));
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err.message || "Server error" }, 500);
  }
};
