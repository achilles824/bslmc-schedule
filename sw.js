// ══════════════════════════════════════════════════════════════════
// Staff Schedule Portal — service worker
//
// Two behaviors only:
//   1. The page itself is NETWORK-FIRST. A deploy is live on next launch.
//      The cached copy exists purely so the app opens when the network
//      is down or the hospital is blocking something.
//   2. The CDN libraries and fonts are CACHE-FIRST. They never change,
//      and caching them means gstatic/cdnjs being blocked stops
//      breaking the app.
//
// Everything else — the Gist, Firebase, anything not listed below —
// is passed straight through untouched. Caching those would serve
// stale providers or stale assignments, which is worse than an error.
//
// Bump CACHE_VERSION to force every client to drop its caches.
// ══════════════════════════════════════════════════════════════════

const CACHE_VERSION = "v2";
const SHELL = "shell-" + CACHE_VERSION;
const LIBS = "libs-" + CACHE_VERSION;
const DATA = "data-" + CACHE_VERSION;

// Cache-first hosts. Exact match, so fonts.googleapis.com is covered
// but no other *.googleapis.com host is.
const CDN_HOSTS = [
  "www.gstatic.com",          // Firebase SDK modules
  "cdnjs.cloudflare.com",     // SheetJS, PDF.js, Tesseract
  "fonts.googleapis.com",     // font CSS
  "fonts.gstatic.com"         // font files
];

self.addEventListener("install", event => {
  // Precache the shell so a cold offline launch still works.
  event.waitUntil(
    caches.open(SHELL)
      .then(c => c.add(new Request("/", { cache: "reload" })))
      .catch(() => {})          // never let a failed precache block install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== LIBS && k !== DATA)
            .map(k => caches.delete(k))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // ── the page ────────────────────────────────────────────────
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put("/", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match("/", { cacheName: SHELL })
            .then(hit => hit || Response.error()))
    );
    return;
  }

    // ── provider Gist: network-first, last-known-good fallback ──
  // The portal appends ?t=<timestamp> as a cache-buster, so the cache key
  // has to drop the query string or every read is a miss and the cache
  // grows without bound.
  if (url.hostname === "gist.githubusercontent.com") {
    const key = url.origin + url.pathname;
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(DATA).then(c => c.put(key, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(key, { cacheName: DATA })
            .then(hit => hit || Response.error()))
    );
    return;
  }
  
  // ── CDN libraries and fonts ─────────────────────────────────
  if (CDN_HOSTS.indexOf(url.hostname) > -1) {
    event.respondWith(
      caches.match(req, { cacheName: LIBS }).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => {
          // Opaque responses (status 0) are still worth caching — that is
          // what a cross-origin no-cors font request looks like.
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(LIBS).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // ── everything else: Gist, Firebase, icons, manifest ────────
  // No respondWith — the browser handles it normally.
});
