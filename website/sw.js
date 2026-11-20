// Lưu tệp tĩnh của website để trang và demo có thể mở lại khi ngoại tuyến.
const CACHE_NAME = 'taylor-nd-audio-site-v1';
const FILES = [
  './', './index.html', './styles.css', './fonts.css', './app.js', './config.js',
  './site.webmanifest', './favicon.svg', './favicon.ico', './apple-touch-icon.png',
  './icon-maskable.png', './icon-192.png', './logo.svg', './logo-animated.svg', './og-image.png',
  './privacy.html', './terms.html', './licenses.html', './legal.css', './legal.js',
  './i18n/vi.json', './i18n/en.json',
  './fonts/be-vietnam-pro-latin-400-normal.woff2',
  './fonts/be-vietnam-pro-latin-600-normal.woff2',
  './fonts/be-vietnam-pro-latin-700-normal.woff2',
  './fonts/be-vietnam-pro-latin-800-normal.woff2',
  './fonts/be-vietnam-pro-latin-ext-400-normal.woff2',
  './fonts/be-vietnam-pro-latin-ext-600-normal.woff2',
  './fonts/be-vietnam-pro-latin-ext-700-normal.woff2',
  './fonts/be-vietnam-pro-latin-ext-800-normal.woff2',
  './fonts/be-vietnam-pro-vietnamese-400-normal.woff2',
  './fonts/be-vietnam-pro-vietnamese-600-normal.woff2',
  './fonts/be-vietnam-pro-vietnamese-700-normal.woff2',
  './fonts/be-vietnam-pro-vietnamese-800-normal.woff2',
  './fonts/montserrat-latin-wght-normal.woff2',
  './fonts/montserrat-latin-ext-wght-normal.woff2',
  './fonts/montserrat-vietnamese-wght-normal.woff2',
  './fonts/montserrat-cyrillic-wght-normal.woff2',
  './fonts/montserrat-cyrillic-ext-wght-normal.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(FILES.map((file) => new URL(file, self.registration.scope).href));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('taylor-nd-audio-site-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match(new URL('./index.html', self.registration.scope).href));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
