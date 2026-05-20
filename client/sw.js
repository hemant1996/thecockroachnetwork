// Minimal service worker — caches the app shell so the client loads offline.
// v0.1 intentionally does not background-sync events; queued publishes happen
// in-memory only and will be retried on reconnect while the tab is open.

const CACHE = "cockroach-shell-v1";
const SHELL = ["./", "./index.html", "./app.js", "./styles.css", "./icon.svg", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only cache same-origin GETs to the shell paths.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
