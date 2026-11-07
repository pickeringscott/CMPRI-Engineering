/* Generated allowlist: cache only immutable Thanksgiving artwork, never app data. */
(() => {
  const cacheName = 'cmpri-thanksgiving-__VERSION__';
  const files = __FILES__;
  const allowed = new Set(files.map(path => new URL(path, self.location.origin).href));
  const pending = new Map();
  self.addEventListener('install', event => {
    event.waitUntil((async () => {
      const cache = await caches.open(cacheName);
      const missing = [];
      for (const path of files) {
        if (await cache.match(path)) continue;
        // Reuse identical content from the previous theme version without fetching it again.
        const previous = await caches.match(path);
        if (previous) await cache.put(path, previous);
        else missing.push(path);
      }
      if (missing.length) await cache.addAll(missing);
      await self.skipWaiting();
    })());
  });
  self.addEventListener('activate', event => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('cmpri-thanksgiving-') && name !== cacheName) await caches.delete(name);
      }
      await self.clients.claim();
    })());
  });
  self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET' || event.request.headers.has('range') || !allowed.has(event.request.url)) return;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const key = event.request.url;
      if (!pending.has(key)) {
        pending.set(key, fetch(event.request).then(async response => {
          if (response.status === 200 && response.type !== 'opaque') {
            // A full device cache must not prevent the downloaded artwork from rendering.
            try { await cache.put(event.request, response.clone()); } catch {}
          }
          return response;
        }).finally(() => pending.delete(key)));
      }
      return (await pending.get(key)).clone();
    })());
  });
})();
