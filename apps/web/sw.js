/**
 * Top Speed PWA service worker.
 *
 * Strategy:
 *  - Static app shell (HTML/CSS/JS/images/manifest): CACHE-FIRST, so the
 *    installed app opens instantly and works offline for the shell.
 *  - API calls (/api/): NETWORK-FIRST, falling back to the last good
 *    cached response when offline — API data is never served stale when
 *    the network is up.
 *  - Navigations: network-first with the cached shell as the offline
 *    fallback.
 *
 * Bump CACHE_VERSION whenever the shell changes so old caches are purged
 * on activate.
 */
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `top-speed-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `top-speed-runtime-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/install.js',
  '/logo.jpg',
  '/flag.jpg',
  '/banner-hero-web.jpg',
  '/banner-journey-web.jpg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/download/',
  '/download/index.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API: network-first, cache fallback (same-origin /api or the local
  // skeleton API on :4000 during development).
  const isApi =
    url.pathname.startsWith('/api/') ||
    (url.port === '4000' && url.pathname.startsWith('/api/'));
  if (isApi) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Page navigations: network-first, shell fallback when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Everything else (static shell assets): cache-first, then network,
  // caching fresh responses for next time.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
