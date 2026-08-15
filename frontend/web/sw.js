/**
 * Veyora service worker — offline-first static shell.
 *
 * W3C Service Workers spec: §5 "Caching" — the cache-first strategy for
 * same-origin GET requests means the vault UI loads even when the API is
 * unreachable. API calls (connect-src) always go to the network because
 * ciphertext must be authoritative.
 *
 * WASM kernel (src/wasm/*.wasm) and self-hosted fonts (assets/fonts/*.woff2)
 * are large and immutable per build, so they cache indefinitely. The HTML
 * shell revalidates so deploys are picked up on the next visit.
 */

const CACHE_NAME = 'veyora-v2';
const PRECACHE = [
  '/',
  '/index.html',
  '/veyora-config.js',
  '/manifest.json',
  '/assets/fonts/fonts.css',
  '/src/styles/tokens.css',
  '/src/styles/base.css',
  '/src/styles/components.css',
  '/src/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API paths: network-only (ciphertext must be fresh).
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/records')) {
    return;
  }

  // Static assets: cache-first, populate on miss.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }),
  );
});
