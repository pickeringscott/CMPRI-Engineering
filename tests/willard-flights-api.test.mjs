import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const ARRIVALS = 'https://www.avionio.com/widget/en/cmi/arrivals?style=3';
const DEPARTURES = 'https://www.avionio.com/widget/en/cmi/departures?style=3';
function fixture(options = {}) {
  let at = Date.parse(options.at || '2026-11-20T13:00:00Z');
  const calls = [];
  class FakeDate extends Date {
    constructor(value) { super(arguments.length ? value : at); }
    static now() { return at; }
  }
  const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const parse = options.parse || ((html, kind) => {
    if (html === 'broken') throw Error('Changed provider layout');
    return { providerDate: day(), explicitEmpty: false, flights: [
      { id: kind + '-test', flight: 'TEST12', airline: 'Test carrier', location: 'Test city', iata: 'ABC', date: day(), time: '07:15', status: 'Estimated 07:22' },
    ] };
  });
  const route = loadTs('src/app/api/willard-flights/route.ts', { '@/lib/server/willard-flight-board': { parseWillardBoard: parse } }, {
    Request, Response, URL, URLSearchParams, TextDecoder, AbortSignal, Date: FakeDate, Intl,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return options.fetch ? options.fetch(url, init) : new Response('board', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
    process: { env: { VERCEL_ENV: 'production' } },
  });
  return { calls, route, advance(ms) { at += ms; }, get(init = {}, query = '') { return route.GET(new Request('https://cmpri.test/api/willard-flights' + query, init)); } };
}

test('production reads only fixed CMI documents and returns source and retrieval provenance', async () => {
  const f = fixture();
  const response = await f.get({}, '?airport=JFK&url=https://untrusted.test&date=1900-01-01');
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(data.airport, 'KCMI'); assert.equal(data.iata, 'CMI'); assert.equal(data.timeZone, 'America/Chicago');
  assert.deepEqual(f.calls.map(x => x.url), [ARRIVALS, DEPARTURES]);
  for (const call of f.calls) {
    assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  for (const kind of ['arrivals', 'departures']) {
    const b = data.boards[kind];
    assert.equal(b.status, 'live'); assert.equal(b.providerDate, '2026-11-20');
    assert.equal(b.retrievedAt, '2026-11-20T13:00:00.000Z'); assert.equal(b.flights[0].status, 'Estimated 07:22');
    assert.equal(b.explicitEmpty, false); assert.equal(b.error, null); assert.ok(!('updatedAt' in b));
  }
});

test('bounded memory cache expires after sixty seconds and never carries yesterday into a new Central day', async () => {
  const f = fixture();
  await f.get(); f.advance(59000); await f.get(); assert.equal(f.calls.length, 2);
  f.advance(1001); await f.get(); assert.equal(f.calls.length, 4);
  const midnight = fixture({ at: '2026-11-21T05:59:30Z' });
  await midnight.get(); midnight.advance(31000);
  const data = await (await midnight.get()).json();
  assert.equal(midnight.calls.length, 4); assert.equal(data.boards.arrivals.providerDate, '2026-11-21');
});

test('one unavailable board does not hide the verified other board or imply zero flights', async () => {
  const f = fixture({ fetch: async url => {
    if (url === ARRIVALS) throw Error('Provider down');
    return new Response('board', { headers: { 'Content-Type': 'text/html' } });
  } });
  const data = await (await f.get()).json();
  assert.equal(f.calls.length, 2); assert.equal(data.boards.departures.status, 'live');
  assert.equal(data.boards.arrivals.status, 'unavailable'); assert.equal(data.boards.arrivals.flights, null);
  assert.equal(data.boards.arrivals.retrievedAt, null); assert.equal(data.boards.arrivals.explicitEmpty, false);
  assert.match(data.boards.arrivals.error, /could not be verified/);
});

test('bad content, oversized streams and changed provider markup remain unavailable without retries', async () => {
  for (const response of [
    () => Response.json({ challenge: true }),
    () => new Response('x', { headers: { 'Content-Type': 'text/html', 'Content-Length': '1048577' } }),
    () => new Response('x'.repeat(1048577), { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('broken', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('', { status: 503, headers: { 'Content-Type': 'text/html' } }),
  ]) {
    const f = fixture({ fetch: async () => response() });
    const data = await (await f.get()).json();
    assert.equal(f.calls.length, 2);
    for (const b of Object.values(data.boards)) { assert.equal(b.status, 'unavailable'); assert.equal(b.flights, null); }
  }
});

test('unsupported methods and already-canceled requests do no provider work', async () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await f.route[method](new Request('https://cmpri.test/api/willard-flights', { method }));
    assert.equal(response.status, 405);
  }
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.get({ signal: controller.signal })).status, 499); assert.equal(f.calls.length, 0);
});

test('canceling the foreground request aborts both reads and cannot warm a successful cache', async () => {
  const f = fixture({ fetch: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('Canceled')), { once: true });
  }) });
  const controller = new AbortController(); const pending = f.get({ signal: controller.signal });
  assert.equal(f.calls.length, 2); controller.abort();
  assert.equal((await pending).status, 499); assert.ok(f.calls.every(c => c.init.signal.aborted));
});
