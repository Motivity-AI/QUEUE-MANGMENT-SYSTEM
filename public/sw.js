const CACHE = 'queue-v1';
const ASSETS = [
  '/manifest.json',
  '/kiosk.html',
  '/display.html',
  '/agent.html'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API وSSE: بدون كاش
  if (url.pathname.startsWith('/api/')) return;
  // الصفحات: تجرب الشبكة أولاً، وعند الفشل من الكاش
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // الأصول الثابتة: من الكاش أولاً
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});