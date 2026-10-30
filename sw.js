// 離線用：先回快取（地下收不到訊號也能開），背景再抓新版存起來，下次開啟生效。
// 改 index.html 裡的 ?v= 時，CACHE 也一起改，舊快取會在啟用時清掉。
const CACHE = 'metro-v17';
const ASSETS = ['./', 'router.js?v=17', 'data/timetables.js?v=17', 'data/freq.js?v=17', 'data/transfer.js?v=17', 'favicon.svg?v=1', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const nav = req.mode === 'navigate';
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(nav ? './' : req, { ignoreSearch: nav });
    const fresh = fetch(req).then((res) => {
      if (res.ok) c.put(nav ? './' : req, res.clone());
      return res;
    });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});
