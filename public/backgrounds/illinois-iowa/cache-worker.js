/* Generated allowlist: cache immutable football artwork, never application data. */
(() => {
  const cacheName = 'cmpri-football-ed782e453d193e7e';
  const files = ["/backgrounds/illinois-iowa/index.ed782e453d193e7e.html"];
  const allowed = new Set(files.map(path => new URL(path, self.location.origin).href));
  const pending = new Map();
  self.addEventListener('install', event => {
    event.waitUntil((async () => {
      const cache = await caches.open(cacheName);
      const missing = [];
      for (const path of files) {
        if (await cache.match(path)) continue;
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
        if (name.startsWith('cmpri-football-') && name !== cacheName) await caches.delete(name);
      }
      await self.clients.claim();
    })());
  });
  self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    // ?theme=1 controls presentation; the immutable HTML bytes are identical.
    url.search = '';
    url.hash = '';
    const key = url.href;
    if (event.request.method !== 'GET' || event.request.headers.has('range') || !allowed.has(key)) return;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(key);
      if (cached) return cached;
      if (!pending.has(key)) {
        pending.set(key, fetch(event.request).then(async response => {
          if (response.status === 200 && response.type !== 'opaque') {
            try { await cache.put(key, response.clone()); } catch {}
          }
          return response;
        }).finally(() => pending.delete(key)));
      }
      return (await pending.get(key)).clone();
    })());
  });
})();
