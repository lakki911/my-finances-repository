// Offline support: serve the app shell from cache, refresh it in the background.
// Bump VERSION whenever app files change so phones pick up the update.
const VERSION = 'v8';
const CACHE = `finance-app-${VERSION}`;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'auth.js', 'cloud.js', 'config.js', 'lock.js', 'exporter.js', 'manifest.webmanifest', 'icons/icon.svg', 'fonts/manrope.woff2', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
