// notify v1 — Cloudflare Pages Function — PREVIEW ONLY
//
// POST /api/notify
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body:    { "date": "YYYY-MM-DD", "mode": "preview" }
//
// Builds the assignment text each person WOULD receive for a finalized day
// and reports who would be skipped and why. Sends nothing. Twilio is not
// called anywhere in this version.
//
// Env vars used: FIREBASE_PROJECT_ID, FIREBASE_DB_URL

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
});

export async function onRequestPost(context) {
  const env = context.env;
  const projectId = env.FIREBASE_PROJECT_ID;
  const dbUrl = (env.FIREBASE_DB_URL || "").replace(/\/+$/, "");
  if (!projectId || !dbUrl) return json({ error: "FIREBASE_PROJECT_ID / FIREBASE_DB_URL not set" }, 500);

  // ── 1. Authenticate ──────────────────────────────────────────
  const authz = context.request.headers.get("Authorization") || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!idToken) return json({ error: "Not signed in. Sign in on the Contacts tab." }, 401);

  let uid;
  try { uid = await verifyFirebaseToken(idToken, projectId); }
  catch (e) { return json({ error: "Sign-in check failed: " + e.message }, 401); }

  // ── 2. Request body ──────────────────────────────────────────
  let date, mode;
  try {
    const body = await context.request.json();
    date = String(body.date || "");
    mode = String(body.mode || "preview");
  } catch (e) { return json({ error: "Bad request body" }, 400); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
  if (mode !== "preview") return json({ error: "Only preview is enabled in this version." }, 403);

  // ── 3. Admin + finalized gates ───────────────────────────────
  const fb = path => fbGet(dbUrl, path, idToken);
  let isAdmin, finalized, assignments, contacts, log;
  try {
    isAdmin = (await fb("admins/" + uid)) === true;
    if (!isAdmin) return json({ error: "This account is not an admin." }, 403);
    [finalized, assignments, contacts, log] = await Promise.all([
      fb("finalized/" + date),
      fb("assignments/" + date),
      fb("smsContacts"),
      fb("smsLog/" + date)
    ]);
  } catch (e) { return json({ error: "Firebase read failed: " + e.message }, 502); }

  if (finalized !== true) return json({ error: date + " is not finalized." }, 409);
  if (!assignments || typeof assignments !== "object") return json({ error: "No assignments for " + date }, 404);

  // ── 4. Build plan ────────────────────────────────────────────
  const plan = buildPlan(date, assignments, contacts || {}, log || {});
  return json({ date, mode, ...plan });
}

// ════════════════════════════════════════════════════════════════
// Plan building
// ════════════════════════════════════════════════════════════════

const norm = s => String(s || "").replace(/["'\u201C\u201D\u2018\u2019]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const keyOf = name => norm(name).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// "Main OR|12" -> "Main OR 12", "MRI|" -> "MRI", "Main OR|Float" -> "Main OR Float"
function roomLabel(roomKey) {
  const [group, num] = roomKey.split("|");
  return num ? group + " " + num : group;
}

// "2026-11-17" -> "Tue 11/17"  (computed in UTC so the server's timezone can't shift the day)
function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  const wd = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return wd + " " + m + "/" + d;
}

function buildPlan(date, assignments, contacts, log) {
  const closed = (assignments.__closed && typeof assignments.__closed === "object") ? assignments.__closed : {};

  // Person -> list of { room, slot, caseTime, partner }
  const people = new Map();
  const inClosedRoom = [];
  const add = (person, entry) => {
    if (!person || !person.name) return;
    const k = norm(person.name);
    if (!people.has(k)) people.set(k, { name: person.name.trim(), credential: person.credential || "", rooms: [] });
    people.get(k).rooms.push(entry);
  };

  for (const [roomKey, slots] of Object.entries(assignments)) {
    if (roomKey === "__closed" || !slots || typeof slots !== "object") continue;
    const room = roomLabel(roomKey);
    const caseTime = slots.caseTime || "";
    const md = slots.md && slots.md.name ? slots.md : null;
    const app = slots.app && slots.app.name ? slots.app : null;
    const floats = Array.isArray(slots.float) ? slots.float.filter(f => f && f.name) : [];

    if (closed[roomKey]) {
      [md, app, ...floats].forEach(p => p && inClosedRoom.push(p.name + " (" + room + ")"));
      continue;
    }
    if (md) add(md, { room, slot: "md", caseTime, partner: null });
    if (app) add(app, { room, slot: "app", caseTime, partner: md ? md.name : null });
    floats.forEach(f => add(f, { room, slot: "float", caseTime: "", partner: null }));
  }

  // Directory lookup by name (case-insensitive)
  const dir = new Map();
  for (const c of Object.values(contacts)) if (c && c.name) dir.set(norm(c.name), c);

  const out = { toSend: [], unchanged: [], noNumber: [], noConsent: [], inactive: [], inClosedRoom, removedSinceSent: [] };

  for (const [k, p] of people) {
    const body = buildMessage(date, p);
    const c = dir.get(k);
    if (!c || !c.phone) { out.noNumber.push(p.name); continue; }
    if (c.active === false) { out.inactive.push(p.name); continue; }
    if (!c.consentForm) { out.noConsent.push(p.name); continue; }

    const prev = log[keyOf(p.name)];
    if (prev && prev.body && stripUpdated(prev.body) === body && prev.status !== "failed") {
      out.unchanged.push(p.name);
      continue;
    }
    const isUpdate = !!(prev && prev.body && prev.status !== "failed");
    out.toSend.push({
      name: p.name,
      phone: c.phone,
      kind: isUpdate ? "updated" : "new",
      body: isUpdate ? "UPDATED: " + body : body,
      chars: (isUpdate ? "UPDATED: " + body : body).length
    });
  }

  // Texted earlier for this date but no longer on the schedule
  for (const [lk, entry] of Object.entries(log)) {
    if (!entry || entry.status === "failed") continue;
    const stillThere = [...people.values()].some(p => keyOf(p.name) === lk);
    if (!stillThere) out.removedSinceSent.push(lk);
  }

  const by = (a, b) => (a.name || a).localeCompare(b.name || b);
  out.toSend.sort(by);
  ["unchanged", "noNumber", "noConsent", "inactive", "inClosedRoom", "removedSinceSent"].forEach(f => out[f].sort());

  out.counts = {
    new: out.toSend.filter(t => t.kind === "new").length,
    updated: out.toSend.filter(t => t.kind === "updated").length,
    unchanged: out.unchanged.length,
    noNumber: out.noNumber.length,
    noConsent: out.noConsent.length,
    inactive: out.inactive.length,
    inClosedRoom: out.inClosedRoom.length,
    removedSinceSent: out.removedSinceSent.length
  };
  return out;
}

const stripUpdated = s => String(s).replace(/^UPDATED: /, "");

// Wording approved by Eric 2026-11-16. Plain ASCII only (an em dash or curly
// quote would force UCS-2 encoding and cut each segment to 70 characters).
const CONTACT_LINE = "Call Dr. Chelliah with issues for Main assignments and Dr. Ritter for issues with McNair assignments.";
const drName = n => /^dr\.?\s/i.test(n) ? n : "Dr. " + n;

function buildMessage(date, p) {
  const head = "BSLMC Anesthesia - " + dayLabel(date) + ": ";
  const rooms = p.rooms;
  let core;
  if (rooms.length === 1) {
    const r = rooms[0];
    core = r.room +
      (r.slot === "app" && r.partner ? " with " + drName(r.partner) : "") + "." +
      (r.caseTime ? " First case " + r.caseTime + "." : "");
  } else {
    // Multiple rooms (MD supervision): list with times, earliest first
    core = rooms
      .slice()
      .sort((a, b) => String(a.caseTime || "99").localeCompare(String(b.caseTime || "99")))
      .map(r => r.room + (r.caseTime ? " (" + r.caseTime + ")" : ""))
      .join(", ") + ".";
  }
  return head + core + " " + CONTACT_LINE;
}

// ════════════════════════════════════════════════════════════════
// Firebase helpers
// ════════════════════════════════════════════════════════════════

async function fbGet(dbUrl, path, idToken) {
  const res = await fetch(dbUrl + "/" + path + ".json?auth=" + encodeURIComponent(idToken));
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(path + " → HTTP " + res.status + " " + t.slice(0, 200));
  }
  return res.json();
}

// Verifies a Firebase Auth ID token (RS256) and returns the uid.
async function verifyFirebaseToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(b64urlText(parts[0]));
  const payload = JSON.parse(b64urlText(parts[1]));
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad token header");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("wrong audience");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("wrong issuer");
  if (!payload.exp || payload.exp < now) throw new Error("token expired — reload the page");
  if (!payload.iat || payload.iat > now + 300) throw new Error("token issued in the future");
  if (!payload.sub) throw new Error("no subject");

  const jwks = await (await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } })).json();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad signature");
  return payload.sub;
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }
