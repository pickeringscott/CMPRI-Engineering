import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const worker = readFileSync('public/backgrounds/thanksgiving-animated/cache-worker.js', 'utf8');
const manifest = JSON.parse(readFileSync('src/lib/ui/thanksgiving-assets.json', 'utf8'));
const origin = 'https://cmpri.test';
function mount({ previous = false, failure = false } = {}) {
  const handlers = new Map(), stores = new Map(), network = [];
  let claimed = false, skipped = false;
  const key = request => typeof request === 'string' ? new URL(request, origin).href : request.url;
  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map()); const data = stores.get(name);
    return { async match(request) { return data.get(key(request))?.clone(); }, async put(request, value) { data.set(key(request), value.clone()); },
      async addAll(paths) { for (const path of paths) { network.push(key(path)); if (failure) throw Error('Offline'); data.set(key(path), new Response('asset')); } } };
  }
  if (previous) stores.set('cmpri-thanksgiving-old', new Map(manifest.files.map(path => [origin + path, new Response('cached')])));
  stores.set('another-feature', new Map());
  const caches = { async open(name) { return store(name); }, async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); },
    async match(request) { for (const values of stores.values()) { if (values.has(key(request))) return values.get(key(request)).clone(); } } };
  vm.runInNewContext(worker, { URL, Set, Map, caches, fetch: async request => { network.push(key(request)); return new Response('downloaded'); },
    self: { location: { origin }, clients: { async claim() { claimed = true; } }, async skipWaiting() { skipped = true; }, addEventListener(name, handler) { handlers.set(name, handler); } } });
  return { stores, network, get claimed() { return claimed; }, get skipped() { return skipped; },
    async event(name) { let done; handlers.get(name)({ waitUntil(promise) { done = promise; } }); await done; },
    async request(path, method = 'GET') { let result; handlers.get('fetch')({ request: new Request(new URL(path, origin), { method }), respondWith(promise) { result = promise; } }); return result ? await result : null; } };
}
test('cache hits are local and clearing a cached file downloads only that file again', async () => {
  const a = mount(); await a.event('install'); await a.event('activate');
  assert.equal(a.network.length, manifest.files.length); assert.ok(a.skipped && a.claimed);
  for (let i = 0; i < 3; i++) for (const path of manifest.files) assert.equal(await (await a.request(path)).text(), 'asset');
  assert.equal(a.network.length, manifest.files.length);
  const current = a.stores.get('cmpri-thanksgiving-' + manifest.version);
  current.delete(origin + manifest.entry);
  assert.equal(await (await a.request(manifest.entry)).text(), 'downloaded');
  await a.request(manifest.entry); assert.equal(a.network.length, manifest.files.length + 1);
});
test('a new worker reuses unchanged files and retires only the older theme cache', async () => {
  const a = mount({ previous: true }); await a.event('install');
  assert.equal(a.network.length, 0); assert.ok(a.stores.has('cmpri-thanksgiving-old'));
  await a.event('activate'); assert.ok(!a.stores.has('cmpri-thanksgiving-old')); assert.ok(a.stores.has('another-feature'));
  assert.ok(a.stores.has('cmpri-thanksgiving-' + manifest.version));
});
test('failed installation never activates; private data and non-allowlisted requests are never intercepted', async () => {
  const a = mount({ failure: true }); await assert.rejects(a.event('install'), /Offline/); assert.equal(a.skipped, false);
  for (const path of ['/api/work-orders', '/api/session', '/engineering', 'https://other.test' + manifest.entry, manifest.entry + '?changed=1']) assert.equal(await a.request(path), null);
  assert.equal(await a.request(manifest.entry, 'POST'), null);
});
