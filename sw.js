// Build timestamp: 2026-06-22 20:15:00 UTC
// sw.js – Service Worker for the Pressure app
// Focus: cache/offline support and notification handling.

const CACHE_NAME = 'lufttryck-app-v5';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

async function broadcastLog(message) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  for (const client of clients) {
    client.postMessage({
      type: 'SW_LOG',
      message
    });
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await broadcastLog('⚙️ Service worker installing');
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
    await broadcastLog('✅ Service worker active');
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;

    try {
      const response = await fetch(event.request);
      const url = new URL(event.request.url);

      if (url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }

      return response;
    } catch (err) {
      const accept = event.request.headers.get('accept') || '';
      if (accept.includes('text/html')) {
        return caches.match('./index.html');
      }
      throw err;
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(client => client.url.startsWith(target));
        if (existing) return existing.focus();
        return self.clients.openWindow(target);
      })
  );
});
