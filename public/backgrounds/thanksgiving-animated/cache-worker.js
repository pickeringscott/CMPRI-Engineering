/* Generated allowlist: cache only immutable Thanksgiving artwork, never app data. */
(() => {
  const cacheName = 'cmpri-thanksgiving-34994bf2d9dd0465';
  const files = ["/backgrounds/thanksgiving-animated/assets/turkey.8934e07aa880f4d4.png","/backgrounds/thanksgiving-animated/assets/greeting.bd3767aa5f2b6ee9.png","/backgrounds/thanksgiving-animated/assets/pumpkin-orange.dde1dc2fa1952c57.png","/backgrounds/thanksgiving-animated/assets/pumpkin-pale.6c7612e4bcfe7c30.png","/backgrounds/thanksgiving-animated/scene.bfc89175a05bbced.css","/backgrounds/thanksgiving-animated/leaves.a3b76e550bc9e2ec.js","/backgrounds/thanksgiving-animated/scene.6dc36d6decadb4f0.js","/backgrounds/thanksgiving-animated/index.d82fdc49d79478ce.html"];
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
