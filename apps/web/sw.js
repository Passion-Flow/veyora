/**
 * Veyora service worker — offline-first static shell.
 *
 * W3C Service Workers spec: §5 "Caching" — the cache-first strategy for
 * same-origin GET requests means the vault UI loads even when the API is
 * unreachable. API calls (connect-src) always go to the network because
 * ciphertext must be authoritative.
 *
 * Cache Storage provides the offline shell. Network fills explicitly bypass
 * the browser HTTP cache because release assets currently use unversioned
 * paths; an old security kernel must never be copied into a new cache.
 */

// v5 evicts every cache generation that may contain the removed JavaScript
// demonstration kernel. Returning clients must receive the fail-closed loader.
const CACHE_NAME = 'veyora-v5';
const PRECACHE = [
  '/',
  '/index.html',
  '/veyora-config.js',
  '/manifest.json',
  '/assets/fonts/fonts.css',
  '/assets/brand/mark.png',
  '/src/styles/tokens.css',
  '/src/styles/base.css',
  '/src/styles/components.css',
  '/src/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(
        PRECACHE.map((path) => new Request(path, { cache: 'reload' })),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const legacyCaches = keys.filter(
        (key) => key.startsWith('veyora-') && key !== CACHE_NAME,
      );
      await Promise.all(legacyCaches.map((key) => caches.delete(key)));
      await self.clients.claim();

      // An already-open legacy page has executed the vulnerable loader even
      // after v5 takes control. Reload only during a Veyora cache upgrade so
      // those windows restart under the fail-closed assets immediately; a
      // fresh installation does not incur an extra navigation.
      if (legacyCaches.length > 0) {
        const windows = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        await Promise.allSettled(windows.map((client) => client.navigate(client.url)));
      }
    })(),
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

  // Static assets: current Cache Storage first. A miss bypasses the separate
  // browser HTTP cache before populating this release's cache generation.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(new Request(request, { cache: 'reload' }));
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});
