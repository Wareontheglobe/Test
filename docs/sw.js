// Offline cache for Under the Coverslip. Serves the cached copy first (so the game opens with no connection) and
// refreshes it in the background past the HTTP cache (GitHub Pages sends max-age=600, which used to hand the old
// file back for three launches). When the refreshed game file differs from the one stored, open pages get
// {type:'update-ready'} so they can offer a reload at a safe moment; a page brought back from the background sends
// 'check' to run the refresh again.
const CACHE = 'coverslip-v4';
const ASSETS = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// the game page, whatever URL launched it ('/', '/index.html', '/?source=pwa'), is stored under one key: './'
const isPage = req => req.mode === 'navigate' || /\/(index\.html)?$/.test(new URL(req.url).pathname);

// Tell the open game pages that a newer build is stored. A refresh started by a launch can finish before the launching
// page is a window client at all (a slow phone on a fast network): matchAll() leaves it out then, so keep looking for
// it for up to 15 s and tell it once it is there. `launch` names that page: {id} is e.resultingClientId, or, where the
// browser gives none, {url}, the first window on the launch URL. It is undefined for a 'check' from an open page.
async function tell(launch) {
  const msg = { type: 'update-ready' };
  for (let t = 0; ; t++) {
    const open = await self.clients.matchAll({ type: 'window' });
    const me = launch && open.find(cl => launch.id ? cl.id === launch.id : cl.url.split('#')[0] === launch.url);
    if (t === 0) for (const cl of open) cl.postMessage(msg);   // every page open now runs the older build
    else if (me) me.postMessage(msg);                          // the launching page, now that it is there
    if (!launch || me || t >= 75) return;                      // 75 x 200 ms
    await new Promise(r => setTimeout(r, 200));
  }
}

async function refresh(req, launch) {
  const same = new URL(req.url).origin === location.origin;
  const res = await fetch(same ? new Request(req, { cache: 'no-cache' }) : req);   // revalidate, never a stale HTTP-cache copy
  if (!res || !(res.ok || res.type === 'opaque')) return res;
  const c = await caches.open(CACHE);
  // compare with our own stored copy, read afresh (the copy answering the page is being streamed to it)
  const old = isPage(req) && await c.match(req);
  if (old) {
    const [a, b] = await Promise.all([old.text(), res.clone().text()]);
    await c.put(req, res.clone());
    if (a !== b) await tell(launch);
  } else await c.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const page = isPage(req);
  const hitP = caches.match(page ? './' : req, { ignoreSearch: true });
  // a launch answered from the cache: that page is told about a newer build even when the refresh finds it before the
  // page exists (tell() waits for it, inside this waitUntil)
  const launch = req.mode === 'navigate' ? (e.resultingClientId ? { id: e.resultingClientId } : { url: req.url }) : undefined;
  const net = hitP.then(hit => refresh(page ? new Request('./') : req, hit && launch).catch(() => hit));
  e.respondWith(hitP.then(hit => hit || net));
  e.waitUntil(net.then(() => {}, () => {}));   // keep the worker alive until the refresh is stored and told
});

self.addEventListener('message', e => {
  if (e.data === 'check') e.waitUntil(refresh(new Request('./')).catch(() => {}));
});
