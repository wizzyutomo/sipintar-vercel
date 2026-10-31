/* SIPINTAR service worker — shell offline (Fase 32, disempurnakan Fase 37) */
const CACHE = 'sipintar-shell-0.9.42-cahaya-prima';
const PRECACHE = ['./', './index.html'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE).catch(function () { return Promise.all(PRECACHE.map(function (u) { return c.add(u).catch(function () {}); })); }); }));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('sipintar-shell-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  /* Fase 37: JANGAN pernah menembolok /api/* — payload sinkronisasi harus
     selalu segar, bila tidak antar-perangkat tidak akan konvergen (bug lama:
     GET same-origin dicocokkan {ignoreSearch:true} termasuk /api/sync/pull). */
  if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) return;
  if (url.pathname === '/offline.html') return; /* berkas unduhan 1 MB+: tidak perlu ditembolok */
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put('./index.html', cp); }); return res;
    }).catch(function () { return caches.match('./index.html'); }));
    return;
  }
  /* Fase 37: kunci cache = URL lengkap termasuk query, sehingga app.js?v=VERSI
     baru tidak pernah dilayani dari salinan app.js?v=VERSI lama. */
  e.respondWith(caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req.url, cp); }); }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});