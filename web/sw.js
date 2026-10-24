// TalonHive Swap service worker: lets the installed app open on a bad connection.
// Rules: (1) same-origin app files are fetched fresh first and only served from cache when offline,
// so updates show immediately; (2) blockchain data (other origins) is never cached or touched, so
// the app can never show stale offers as live; (3) only successful GET responses are stored.
const CACHE = "talonhive-shell-v2";
const SHELL = ["./", "./index.html", "./app.js", "./config.js", "./boc.js", "./send.js", "./favicon.svg",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;   // chain API etc.: browser default
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok) {
        const copy = fresh.clone();
        const key = new Request(url.origin + url.pathname);                    // ignore ?v= cache-bust stamps
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return fresh;
    } catch {
      const cached = await caches.match(new Request(url.origin + url.pathname))
        || (req.mode === "navigate" ? await caches.match("./index.html") : undefined);
      return cached || Response.error();
    }
  })());
});
