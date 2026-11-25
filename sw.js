// Offline support: the app shell is cached; GitHub API calls always go to the network.
const VERSION = "bq-v8";
const SHELL = [
  "./", "index.html", "app.css", "app.js", "mascot.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Network first so updates arrive when online. If the network fails, or is so slow that
  // the app would sit on a blank screen, use the saved copy instead.
  const saved = () => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"));
  const fresh = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  });
  const slow = new Promise((resolve) => setTimeout(resolve, 3000)).then(saved).then((r) => r || fresh);
  e.respondWith(Promise.race([fresh.catch(saved), slow]));
});
