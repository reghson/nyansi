// Nyansi service worker: offline app shell. AI requests always go to the network.
const CACHE = "nyansi-v3";
const SHELL = ["./", "index.html", "styles.css", "manifest.json", "icons/logo.svg", "icons/icon-192.png", "icons/icon-512.png",
  "app/", "app/index.html", "app/app.css", "app/app.js", "app/config.js", "app/markdown.js",
  "app/prompts.js", "app/views.js", "app/bot.js", "app/code.js"];
const CDN = "cdnjs.cloudflare.com"; // code editor files, cached after first use
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // never cache AI/API calls
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("app/index.html"))));
});
