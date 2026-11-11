// ELWORK Sklad – service worker (offline + aktualizácie)
// Pri každej novej verzii appky zvýš číslo verzie tu aj v app.js.
var VERSION = '1.0.0';
var CACHE = 'elwork-sklad-' + VERSION;
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'maskable-512.png',
  'apple-touch-icon.png',
  'logo-dark.png',
  'logo-light.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('elwork-sklad-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Dáta skladu (Apps Script) vždy zo siete – appka si ich ukladá sama
  if (url.hostname.indexOf('script.google') >= 0 || url.hostname.indexOf('googleusercontent') >= 0) return;

  // Písmo a knižnica ZXing – uložia sa pri prvom použití
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { c.put(req, res.clone()); return res; });
      });
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // config.js a stránka: najprv sieť (aby sa zmeny prejavili), offline z cache
  if (req.mode === 'navigate' || url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req.mode === 'navigate' ? 'index.html' : req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req.mode === 'navigate' ? 'index.html' : req);
    }));
    return;
  }

  // Ostatné súbory appky: z cache, inak zo siete
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
});
