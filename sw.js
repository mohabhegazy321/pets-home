// Pets Home (local edition) service worker: the whole app opens with no internet.
// App files are served from the saved copy instantly and refreshed in the background,
// so a new version uploaded to the site appears the next time the app is opened.
const VERSION = "petshome-local-v1";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(staleWhileRevalidate(req, e));
  else if (FONT_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(req));
});
async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(VERSION);
  const key = req.mode === "navigate" ? "./index.html" : req;
  const hit = await cache.match(key, { ignoreSearch: true });
  const update = fetch(req).then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
  if (hit) { event.waitUntil(update); return hit; }
  const res = await update;
  return res || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
}
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch { return new Response("", { status: 503 }); }
}
