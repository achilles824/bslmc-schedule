// notify v2 — Cloudflare Pages Function
// v1.1: name matching ignores quotes/apostrophes/extra spaces (matches smsNorm in index.html)
// v1.2: approved message wording with contact line
// v2:   send mode (Twilio), test allowlist, per-date lock, batched sends, failed-send tracking
//
// POST /api/notify
//   Headers: Authorization: Bearer <Firebase ID token>
//   Body:    { "date": "YYYY-MM-DD", "mode": "preview" | "send", "retryFailed": false }
//
// preview: builds the text each person would receive and reports skips. Sends nothing.
// send:    sends up to BATCH texts per call and logs each to smsLog/{date}. The response
//          includes "remaining"; the caller repeats the call until remaining is 0.
//          (Cloudflare caps outbound requests per call, so big days take 2-3 calls.)
//
// Env vars:
//   FIREBASE_PROJECT_ID, FIREBASE_DB_URL                      (Text)
//   TWILIO_ACCOUNT_SID, TWILIO_MESSAGING_SERVICE_SID           (Text)
//   TWILIO_AUTH_TOKEN  — or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET   (Secret)
//   SMS_ENABLED        "true" to allow send mode; anything else blocks sending (kill switch)
//   SMS_TEST_ALLOWLIST optional, comma-separated names. When set, ONLY these people are
//                      texted; everyone else is reported under heldByAllowlist.

const BATCH = 30;
const LOCK_STALE_MS = 2 * 60 * 1000;
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
  let date, mode, retryFailed;
  try {
    const body = await context.request.json();
    date = String(body.date || "");
    mode = String(body.mode || "preview");
    retryFailed = body.retryFailed === true;
  } catch (e) { return json({ error: "Bad request body" }, 400); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
  if (mode !== "preview" && mode !== "send") return json({ error: "mode must be preview or send" }, 400);
  if (mode === "send" && env.SMS_ENABLED !== "true") return json({ error: "Sending is turned off (SMS_ENABLED is not \"true\")." }, 403);

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
  const allow = String(env.SMS_TEST_ALLOWLIST || "").split(",").map(norm).filter(Boolean);
  const plan = buildPlan(date, assignments, contacts || {}, log || {}, { retryFailed, allow });
  if (mode === "preview") return json({ date, mode, testAllowlist: allow.length ? allow : null, ...plan });

  // ── 5. Send ──────────────────────────────────────────────────
  const tw = twilioConfig(env);
  if (tw.error) return json({ error: tw.error }, 500);

  const lockPath = "smsLocks/" + date;
  try {
    const got = await lockAcquire(dbUrl, lockPath, idToken, uid);
    if (!got) return json({ error: "Another admin is sending texts for " + date + " right now. Try again in a minute." }, 409);
  } catch (e) { return json({ error: "Could not lock: " + e.message }, 502); }

  const batch = plan.toSend.slice(0, BATCH);
  const results = [];
  const logPatch = {};
  try {
    // 5 at a time; Twilio's Messaging Service queues for carrier throughput.
    for (let i = 0; i < batch.length; i += 5) {
      const chunk = batch.slice(i, i + 5);
      const sent = await Promise.all(chunk.map(t => twilioSend(tw, t.phone, t.body)));
      chunk.forEach((t, j) => {
        const r = sent[j];
        results.push({ name: t.name, kind: t.kind, ok: r.ok, sid: r.sid || null, error: r.error || null, code: r.code || null });
        const entry = { body: t.body, status: r.ok ? "queued" : "failed", sentAt: Date.now(), by: uid };
        if (r.sid) entry.sid = r.sid;
        if (!r.ok) entry.error = String(r.code || "") + " " + String(r.error || "").slice(0, 200);
        logPatch[keyOf(t.name)] = entry;
      });
    }
  } finally {
    let logError = null;
    if (Object.keys(logPatch).length) {
      try { await fbPatch(dbUrl, "smsLog/" + date, logPatch, idToken); }
      catch (e) { logError = e.message; }
    }
    try { await fbDelete(dbUrl, lockPath, idToken); } catch (e) {}
    if (logError) return json({ error: "Texts went out but the log write failed — do NOT resend until checked: " + logError, results }, 500);
  }

  const remaining = Math.max(0, plan.toSend.length - batch.length);
  return json({
    date, mode,
    sent: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    remaining,
    results
  });
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

function buildPlan(date, assignments, contacts, log, opts = {}) {
  const allow = opts.allow || [];
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

  const out = { toSend: [], unchanged: [], noNumber: [], noConsent: [], inactive: [], failedBefore: [], heldByAllowlist: [], inClosedRoom, removedSinceSent: [] };

  for (const [k, p] of people) {
    const body = buildMessage(date, p);
    const c = dir.get(k);
    if (!c || !c.phone) { out.noNumber.push(p.name); continue; }
    if (c.active === false) { out.inactive.push(p.name); continue; }
    if (!c.consentForm) { out.noConsent.push(p.name); continue; }

    const prev = log[keyOf(p.name)];
    const sameBody = !!(prev && prev.body && stripUpdated(prev.body) === body);
    if (sameBody && prev.status !== "failed") { out.unchanged.push(p.name); continue; }
    // This exact text already failed once (e.g. opted out). Don't retry unless asked.
    if (sameBody && prev.status === "failed" && !opts.retryFailed) {
      out.failedBefore.push(p.name + " — " + (prev.error || "failed"));
      continue;
    }
    if (allow.length && !allow.includes(k)) { out.heldByAllowlist.push(p.name); continue; }
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
  ["unchanged", "noNumber", "noConsent", "inactive", "failedBefore", "heldByAllowlist", "inClosedRoom", "removedSinceSent"].forEach(f => out[f].sort());

  out.counts = {
    new: out.toSend.filter(t => t.kind === "new").length,
    updated: out.toSend.filter(t => t.kind === "updated").length,
    unchanged: out.unchanged.length,
    noNumber: out.noNumber.length,
    noConsent: out.noConsent.length,
    inactive: out.inactive.length,
    failedBefore: out.failedBefore.length,
    heldByAllowlist: out.heldByAllowlist.length,
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

async function fbPatch(dbUrl, path, data, idToken) {
  const res = await fetch(dbUrl + "/" + path + ".json?auth=" + encodeURIComponent(idToken), {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(path + " → HTTP " + res.status + " " + (await res.text().catch(() => "")).slice(0, 200));
}

async function fbDelete(dbUrl, path, idToken) {
  await fetch(dbUrl + "/" + path + ".json?auth=" + encodeURIComponent(idToken), { method: "DELETE" });
}

// Compare-and-set lock using Firebase REST ETags. Returns true if acquired.
async function lockAcquire(dbUrl, path, idToken, uid) {
  const url = dbUrl + "/" + path + ".json?auth=" + encodeURIComponent(idToken);
  const cur = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
  if (!cur.ok) throw new Error("lock read HTTP " + cur.status);
  const etag = cur.headers.get("ETag");
  const val = await cur.json();
  if (val && val.at && Date.now() - val.at < LOCK_STALE_MS && val.uid !== uid) return false;
  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "if-match": etag },
    body: JSON.stringify({ uid, at: Date.now() })
  });
  if (put.status === 412) return false;           // someone else grabbed it first
  if (!put.ok) throw new Error("lock write HTTP " + put.status);
  return true;
}

// ════════════════════════════════════════════════════════════════
// Twilio
// ════════════════════════════════════════════════════════════════

function twilioConfig(env) {
  const account = env.TWILIO_ACCOUNT_SID;
  const service = env.TWILIO_MESSAGING_SERVICE_SID;
  const user = env.TWILIO_API_KEY_SID || account;
  const pass = env.TWILIO_API_KEY_SID ? env.TWILIO_API_KEY_SECRET : env.TWILIO_AUTH_TOKEN;
  if (!account || !service || !user || !pass) return { error: "Twilio variables are not all set in Cloudflare." };
  return { account, service, basic: "Basic " + btoa(user + ":" + pass) };
}

async function twilioSend(tw, to, body) {
  try {
    const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + tw.account + "/Messages.json", {
      method: "POST",
      headers: { Authorization: tw.basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, MessagingServiceSid: tw.service, Body: body }).toString()
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.sid) return { ok: true, sid: data.sid };
    const friendly = data.code === 21610 ? "Opted out (replied STOP) — blocks all texts from this number" : (data.message || ("HTTP " + res.status));
    return { ok: false, code: data.code || res.status, error: friendly };
  } catch (e) {
    return { ok: false, code: "network", error: e.message };
  }
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
