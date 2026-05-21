// Cockroach client service worker.
//
// Strategy: NETWORK-FIRST.  Always try fresh, fall back to cache only when
// the network is unreachable.  This is the opposite of the v0.1 cache-first
// strategy, which made deploys invisible to anyone who'd installed the SW —
// the browser kept serving the cached app.js forever until the cache key
// changed.
//
// Cache name is versioned so that bumping it (any deploy that changes
// anything in the shell) wipes every visitor's stale cache on next SW
// activation.

const CACHE = "cockroach-shell-v074";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./verdicts.js",
  "./peers.js",
  "./media.js",
  "./styles.css",
  "./icon.svg",
  "./manifest.webmanifest",
  "./relays.json",
  "./lang/en.json",
  "./lang/hi.json",
];

self.addEventListener("install", (e) => {
  // Pre-warm the shell so an offline visitor still gets something.
  // skipWaiting() forces the new SW to activate immediately rather than
  // waiting for all controlled tabs to close — critical for deploy freshness.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {})) // tolerate any one URL failing
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  // Delete every cache that isn't the current one, then claim all open tabs
  // so they start using this SW immediately.
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first: always go to the network for the freshest version.
  // On success, opportunistically update the cache so the offline copy
  // stays current.  On failure (offline / DNS / 5xx hangup), fall back
  // to whatever we have in the cache.
  e.respondWith(
    fetch(e.request).then((resp) => {
      if (resp && resp.status === 200 && resp.type === "basic") {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
  );
});
