import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(readFileSync('src/lib/ui/football-assets.json', 'utf8'));
const worker = readFileSync('public/backgrounds/illinois-iowa/cache-worker.js', 'utf8');
const origin = 'https://cmpri.test';
const url = request => typeof request === 'string' ? new URL(request, origin).href : request.url;

function harness({ previous = false, quota = false } = {}) {
  const stores = new Map([['cmpri-thanksgiving-retained', new Map()], ['app-cache', new Map()]]);
  const network = [];
  const handlers = new Map();
  if (previous) stores.set('cmpri-football-old', new Map(manifest.files.map(path => [url(path), new Response('already saved')])));
  const cache = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(request) { return store.get(url(request))?.clone(); },
      async put(request, response) { if (quota) throw new Error('QuotaExceededError'); store.set(url(request), response.clone()); },
      async addAll(paths) { for (const path of paths) { network.push(url(path)); store.set(url(path), new Response('downloaded')); } },
    };
  };
  const self = { location: { origin }, addEventListener(name, handler) { handlers.set(name, handler); }, async skipWaiting() {}, clients: { async claim() {} } };
  vm.runInNewContext(worker, {
    self, URL, Set, Map,
    caches: { async open(name) { return cache(name); }, async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); }, async match(request) { for (const store of stores.values()) if (store.has(url(request))) return store.get(url(request)).clone(); } },
    async fetch(request) { network.push(url(request)); return new Response('from network'); },
  });
  return {
    stores, network,
    async event(name, request) {
      const waits = []; let response;
      handlers.get(name)?.({ request, waitUntil(promise) { waits.push(promise); }, respondWith(promise) { response = promise; } });
      await Promise.all(waits); return response;
    },
  };
}

test('football build publishes a self-contained immutable entry and matching stable alias', () => {
  assert.match(manifest.entry, /^\/backgrounds\/illinois-iowa\/index\.[a-f0-9]{16}\.html$/);
  assert.deepEqual(manifest.files, [manifest.entry]);
  const bytes = readFileSync('public' + manifest.entry);
  assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0, 16), manifest.version);
  assert.ok(manifest.entry.includes('.' + manifest.version + '.'));
  assert.deepEqual(bytes, readFileSync('public/backgrounds/illinois-iowa/index.html'));
  const html = bytes.toString();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('data:image/webp;base64,'));
  assert.ok(html.includes('data:image/svg+xml;base64,'));
  assert.doesNotMatch(html, /__(?:STADIUM_IMAGE|ILLINOIS_LOGO|IOWA_LOGO|ASSET_DIGEST)__/);
});

test('the cache reuses identical immutable artwork across versions and preserves unrelated caches', async () => {
  const a = harness({ previous: true });
  await a.event('install');
  assert.equal(a.network.length, 0);
  assert.ok(a.stores.has('cmpri-football-' + manifest.version));
  await a.event('activate');
  assert.equal(a.stores.has('cmpri-football-old'), false);
  assert.equal(a.stores.has('cmpri-thanksgiving-retained'), true);
  assert.equal(a.stores.has('app-cache'), true);
});

test('embedded theme query reads the same cached HTML without another network request', async () => {
  const a = harness({ previous: true });
  await a.event('install');
  const response = await a.event('fetch', new Request(origin + manifest.entry + '?theme=1'));
  assert.equal(await response.text(), 'already saved');
  assert.equal(a.network.length, 0);
});

test('the artwork worker never intercepts app data, unrelated files, writes, or partial requests', async () => {
  const a = harness();
  for (const request of [new Request(origin + '/api/work-orders'), new Request(origin + '/engineering'), new Request(origin + '/other.html'), new Request(origin + manifest.entry, { method: 'POST' }), new Request(origin + manifest.entry, { headers: { range: 'bytes=0-99' } })]) {
    assert.equal(await a.event('fetch', request), undefined);
  }
  assert.equal(a.network.length, 0);
});

test('a full local cache does not prevent newly downloaded artwork from rendering', async () => {
  const a = harness({ quota: true });
  const response = await a.event('fetch', new Request(origin + manifest.entry + '?theme=1'));
  assert.equal(await response.text(), 'from network');
  assert.equal(a.network.length, 1);
});
