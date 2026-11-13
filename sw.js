// Pets Home service worker. (Firebase data and sign-in requests are never touched here; Firestore keeps its own offline copy.)
// Online: always loads the newest app files, so publishing an update only needs a refresh.
// Offline (or slow network): opens instantly from the saved copy.
const VERSION = "petshome-v3-1";
const SHELL = ["./", "./index.html", "./app.js", "./backend.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: "no-cache" })).then(r => r.ok && c.put(u, r)).catch(() => {}))))
    .then(() => self.skipWaiting()));
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
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (FONT_HOSTS.includes(url.hostname) || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) e.respondWith(cacheFirst(req));
});
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const key = req.mode === "navigate" ? "./index.html" : req.url.split("?")[0];
  try {
    const res = await Promise.race([
      fetch(new Request(req.url, { cache: "no-cache" })),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))
    ]);
    if (res && res.ok) { cache.put(key, res.clone()); return res; }
    throw new Error("bad response");
  } catch (err) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
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
