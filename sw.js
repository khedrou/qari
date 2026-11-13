/* Service worker ديال قارئ الكتب.
   كل ما بدلتي شي ملف، بدل رقم VERSION باش التيليفون يحمّل النسخة الجديدة. */
const VERSION = 'qari-v1';
const CORE = [
  './',
  'index.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'lib/pdf.min.mjs',
  'lib/pdf.worker.min.mjs'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheable(res) {
  return res && (res.ok || res.type === 'opaque');
}

/* كيجيب من الكاش بسرعة، وكيحدّث النسخة ف الخلفية */
async function staleWhileRevalidate(req, fallbackKey) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (cacheable(res)) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await net;
  if (res) return res;
  if (fallbackKey) {
    const fb = await cache.match(fallbackKey);
    if (fb) return fb;
  }
  return new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    e.respondWith(staleWhileRevalidate(req, 'index.html'));
    return;
  }

  /* ملفات التطبيق ومكتبة pdf.js (خطوط وwasm كيتحفظو ملي كيتطلبو أول مرة) */
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  /* خطوط Google */
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req));
  }
});
