const CACHE = 'piano-rec-v7';
const FILES = [
  './', 'index.html', 'app.js', 'midi-file.js', 'ble-midi.js', 'audio-render.js', 'video-store.js',
  'style.css', 'manifest.webmanifest', 'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

const BIG = /\/(samples\/|tone\.js|lame\.min\.js)/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (BIG.test(req.url)) {
    // Large, rarely-changing files: cache first, fill the cache on first use.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }
  // App files: network first, bypassing the browser's HTTP cache (GitHub Pages sends
  // max-age=600) so a new page never runs with stale scripts. Cache is the offline fallback.
  e.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match(req)));
});
