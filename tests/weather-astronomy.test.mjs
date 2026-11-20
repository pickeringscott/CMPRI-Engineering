import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from 'astronomy-engine';
import { loadTs } from './helpers/load-ts.mjs';

const SOURCE = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const NOW = new Date('2026-11-20T04:00:00Z');
function payload(overrides = {}) {
  return { 'Observation Time': '2026-11-20 03:50:00', 'Forecast Time': '2026-11-20 04:30:00',
    'Data Format': '[Longitude, Latitude, Aurora]', coordinates: [[272, 40, 0], [272, 44, 0], [272, 60, 100]], ...overrides };
}
function fixture(options = {}) {
  const calls = [], deadlines = [];
  const fetcher = options.fetcher || (async (url, init) => {
    calls.push({ url, init });
    return Response.json(options.payload || payload());
  });
  const api = loadTs('src/lib/server/weather-astronomy.ts', { 'astronomy-engine': options.engine || engine }, {
    AbortSignal: options.AbortSignal || { any: AbortSignal.any, timeout(milliseconds) {
      deadlines.push(milliseconds); return AbortSignal.timeout(milliseconds);
    } }, Response, TextDecoder, Uint8Array, Date, Error, fetch: fetcher,
  });
  const route = loadTs('src/app/api/weather-preview/astronomy/route.ts', {
    '@/lib/server/weather-astronomy': api,
  }, { Response, URL, process: { env: { VERCEL_ENV: 'production' } } });
  return { api, route, calls, deadlines, read: (extra = {}) => api.readWeatherAstronomy(new AbortController().signal,
    { now: NOW, useCache: false, ...extra }) };
}

test('actual engine calculates a bounded illuminated fraction and the correct eight-phase label', () => {
  const { api } = fixture();
  const result = api.calculateWeatherAstronomy(new Date('2026-11-20T12:00:00Z'), false);
  assert.equal(result.moonPhase.label, 'Waxing gibbous');
  assert.ok(Math.abs(result.moonPhase.angle - 125.216) < 0.02);
  assert.ok(Math.abs(result.moonPhase.illumination - 0.788764) < 0.0001);
  assert.equal(result.moonPhase.calculatedAt, '2026-11-20T12:00:00.000Z');
  assert.equal(result.events.length, 0, 'A global future eclipse must not become an event within the next seven days.');
});

test('February2027 lunar eclipse is retained after moonrise even though its peak is below the hotel horizon', () => {
  const { api } = fixture();
  const result = api.calculateWeatherAstronomy(new Date('2027-02-20T12:00:00Z'), false);
  const eclipse = result.events.find(event => event.type === 'lunar-eclipse');
  assert.ok(eclipse); assert.equal(eclipse.title, 'Lunar eclipse'); assert.equal(eclipse.calculated, true);
  assert.ok(Date.parse(eclipse.start) > Date.parse(eclipse.peak), 'Only the later visible portion begins after the hidden peak.');
  assert.ok(Math.abs(Date.parse(eclipse.start) - Date.parse('2027-02-20T23:37:57Z')) < 5000);
  assert.ok(Date.parse(eclipse.end) > Date.parse('2027-02-21T01:00:00Z'));
  assert.ok(eclipse.details.some(text => text.includes('below the local horizon')));
  const detailTimes = eclipse.details.flatMap(text => text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) || []);
  assert.ok(detailTimes.length >= 3, 'Details retain ISO tokens for the frontend role-specific clock.');
  assert.ok(detailTimes.every(value => Number.isFinite(Date.parse(value))));
  assert.ok(!eclipse.details.some(text => /\b(?:CST|CDT|AM|PM)\b/.test(text)), 'The server must not choose a display clock.');
  assert.equal(api.localVisibilityWindows(engine.Body.Moon, new Date(eclipse.end), new Date(eclipse.start)).length, 0);
});

test('July2027 global lunar eclipse remains absent because it is below the local horizon throughout', () => {
  const { api } = fixture();
  const result = api.calculateWeatherAstronomy(new Date('2027-07-17T12:00:00Z'), false);
  assert.ok(!result.events.some(event => event.type === 'lunar-eclipse'));
  const eclipse = engine.SearchLunarEclipse(new Date('2027-07-01T00:00:00Z'));
  assert.equal(api.localVisibilityWindows(engine.Body.Moon,
    eclipse.peak.AddDays(-eclipse.sd_penum / 1440).date, eclipse.peak.AddDays(eclipse.sd_penum / 1440).date).length, 0);
});

test('solar event uses the hotel observer, a generic title and actual locally visible contact interval', () => {
  const { api } = fixture();
  const result = api.calculateWeatherAstronomy(new Date('2024-04-08T12:00:00Z'), false);
  const eclipse = result.events.find(event => event.type === 'solar-eclipse');
  assert.ok(eclipse); assert.equal(eclipse.title, 'Solar eclipse');
  assert.ok(Date.parse(eclipse.start) < Date.parse(eclipse.peak));
  assert.ok(Date.parse(eclipse.end) > Date.parse(eclipse.peak));
  assert.ok(!/total/i.test(eclipse.summary), 'A global total eclipse must not mislabel the hotel partial eclipse.');
  assert.ok(eclipse.details.some(text => text.includes('eye protection')));
});

test('rolling event windows reevaluate cached candidates rather than keeping a finished event beyond24hours', () => {
  const { api } = fixture();
  const atMoonrise = api.calculateWeatherAstronomy(new Date('2027-02-20T23:45:00Z'));
  assert.equal(atMoonrise.events.filter(event => event.type === 'lunar-eclipse').length, 1);
  const after = api.calculateWeatherAstronomy(new Date('2027-02-22T02:00:00Z'));
  assert.equal(after.events.length, 0);
});

test('strict official aurora parsing preserves real zero and UTC timestamps without guessing missing data', () => {
  const { api } = fixture();
  const result = api.parseAuroraSample(payload());
  assert.equal(result.localValue, 0); assert.equal(result.regionalValue, 0);
  assert.equal(result.nearestLongitude, -88); assert.equal(result.nearestLatitude, 40);
  assert.equal(result.observationTime, '2026-11-20T03:50:00.000Z');
  assert.equal(api.parseAuroraSample(payload({ 'Observation Time': '2026-11-20T03:50:00.125Z' })).observationTime,
    '2026-11-20T03:50:00.125Z', 'Preserve supplied source precision.');
  for (const input of [null, {}, payload({ 'Observation Time': '2026-02-30 03:00:00' }),
    payload({ 'Data Format': '[Latitude,Longitude,Aurora]' }), payload({ coordinates: [] }),
    payload({ coordinates: [[272, 60, 100]] }), payload({ coordinates: [[272, 40, null]] }),
    payload({ coordinates: [[272, 40, '0']] }), payload({ coordinates: [[272, 40, 101]] }),
    payload({ coordinates: [[-88, 40, 10]] }), payload({ coordinates: [[272, 91, 10]] })]) {
    assert.throws(() => api.parseAuroraSample(input));
  }
});

test('fresh local or bounded northern signal can show potential aurora only at local civil night', () => {
  const { api } = fixture();
  const dark = api.evaluateAuroraSample(api.parseAuroraSample(payload({ coordinates: [[272, 40, 10], [272, 60, 100]] })), NOW);
  assert.equal(dark.aurora.status, 'live'); assert.ok(dark.aurora.sunAltitude < -6);
  assert.equal(dark.event.title, 'Potential northern lights'); assert.equal(dark.event.calculated, false);
  assert.equal(dark.event.end, '2026-11-20T04:45:00.000Z');
  const regional = api.evaluateAuroraSample(api.parseAuroraSample(payload({ coordinates: [[272, 40, 0], [272, 44, 12]] })), NOW);
  assert.equal(regional.aurora.localValue, 0); assert.equal(regional.aurora.regionalValue, 12); assert.ok(regional.event);
  assert.ok(regional.event.details.some(text => text.includes('not an exact probability')));
  const farAway = api.evaluateAuroraSample(api.parseAuroraSample(payload()), NOW);
  assert.equal(farAway.event, null, 'A strong Canadian signal outside500km cannot masquerade as Champaign potential.');
  const day = api.evaluateAuroraSample(api.parseAuroraSample(payload({ 'Observation Time': '2026-11-20 17:50:00',
    'Forecast Time': '2026-11-20 18:30:00', coordinates: [[272, 40, 100]] })), new Date('2026-11-20T18:00:00Z'));
  assert.equal(day.aurora.status, 'live'); assert.ok(day.aurora.sunAltitude > -6); assert.equal(day.event, null);
});

test('stale, inconsistent and excessively future source clocks cannot generate an aurora event', () => {
  const { api } = fixture();
  for (const overrides of [
    { 'Observation Time': '2026-11-20 03:00:00', 'Forecast Time': '2026-11-20 03:40:00' },
    { 'Observation Time': '2026-11-20 01:00:00', 'Forecast Time': '2026-11-20 04:30:00' },
    { 'Observation Time': '2026-11-20 04:10:00', 'Forecast Time': '2026-11-20 04:30:00' },
    { 'Observation Time': '2026-11-20 03:50:00', 'Forecast Time': '2026-11-20 05:31:00' },
    { 'Observation Time': '2026-11-20 03:50:00', 'Forecast Time': '2026-11-20 03:45:00' },
  ]) {
    const { aurora, event } = api.evaluateAuroraSample(api.parseAuroraSample(payload({ ...overrides, coordinates: [[272, 40, 100]] })), NOW);
    assert.equal(aurora.status, 'stale'); assert.equal(event, null); assert.equal(aurora.sunAltitude, null);
  }
});

test('foreground transport uses only the fixed NOAA JSON with omitted credentials, manual redirects and an8second deadline', async () => {
  const f = fixture(); const data = await f.read();
  assert.equal(data.aurora.status, 'live'); assert.equal(data.aurora.localValue, 0); assert.equal(data.events.length, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, SOURCE);
  assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.redirect, 'manual'); assert.equal(f.calls[0].init.cache, 'no-store');
  assert.equal(f.calls[0].init.headers.Accept, 'application/json'); assert.deepEqual(f.deadlines, [8000]);
});

test('source failures retain calculated phase and eclipses, without fabricated aurora zero or event', async () => {
  for (const fetcher of [async () => { throw new Error('Network unavailable'); },
    async () => new Response(null, { status: 302, headers: { Location: 'https://unrelated.example/private' } }),
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('<html>Wrong source</html>', { headers: { 'Content-Type': 'text/html' } }),
    async () => new Response('{bad json}', { headers: { 'Content-Type': 'application/json' } }),
    async () => Response.json(payload({ 'Forecast Time': null })),
  ]) {
    const f = fixture({ fetcher });
    const data = await f.read({ now: new Date('2027-02-20T12:00:00Z') });
    assert.ok(data.moonPhase.label); assert.ok(data.events.some(event => event.type === 'lunar-eclipse'));
    assert.equal(data.aurora.status, 'unavailable'); assert.equal(data.aurora.localValue, null);
    assert.equal(data.aurora.forecastTime, null); assert.ok(!data.events.some(event => event.type === 'aurora'));
  }
});

test('declared and streamed responses over3MiB are rejected without parsing or substituting data', async () => {
  for (const response of [
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array(3 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const f = fixture({ fetcher: async () => response }); const data = await f.read();
    assert.equal(data.aurora.status, 'unavailable'); assert.match(data.aurora.error, /3 MiB/); assert.equal(data.aurora.localValue, null);
  }
});

test('client abort stops calculation entirely while an upstream timeout preserves calculated astronomy', async () => {
  let calculations = 0;
  const observedEngine = { ...engine, MoonPhase(...args) { calculations++; return engine.MoonPhase(...args); } };
  const controller = new AbortController(); controller.abort();
  const f = fixture({ engine: observedEngine });
  await assert.rejects(f.api.readWeatherAstronomy(controller.signal, { now: NOW, useCache: false }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0); assert.equal(calculations, 0);
  const timeout = fixture({ engine: observedEngine, AbortSignal: { any: AbortSignal.any,
    timeout: () => AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')) } });
  const unavailable = await timeout.read();
  assert.equal(timeout.calls.length, 0); assert.equal(unavailable.aurora.status, 'unavailable');
  assert.match(unavailable.aurora.error, /timed out/); assert.ok(unavailable.moonPhase.label);
  assert.equal(calculations, 1, 'Only an active view retains calculated phase after an upstream timeout.');
});

test('cancellation while reading a pending body cancels its reader rather than leaving the request alive', async () => {
  let readerCanceled = false, notifyRead, calculations = 0;
  const reading = new Promise(resolve => { notifyRead = resolve; });
  const controller = new AbortController();
  const stream = new ReadableStream({ cancel() { readerCanceled = true; } });
  const f = fixture({ engine: { ...engine, MoonPhase(...args) { calculations++; return engine.MoonPhase(...args); } },
    fetcher: async () => ({ status: 200, ok: true,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: { getReader() { const reader = stream.getReader(); notifyRead(); return reader; } },
  }) });
  const pending = f.api.readWeatherAstronomy(controller.signal, { now: NOW, useCache: false });
  await reading; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(readerCanceled, true); assert.equal(calculations, 0);
});

test('route returns499 without resources when the client closes Weather during an upstream read', async () => {
  const controller = new AbortController(); let started;
  const reading = new Promise(resolve => { started = resolve; });
  const f = fixture({ fetcher: async (_url, init) => {
    started();
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    throw new Error('Canceled source must never complete.');
  } });
  const pending = f.route.GET(new Request('https://app.example/api/weather-preview/astronomy', { signal: controller.signal }));
  await reading; controller.abort(); const response = await pending, body = await response.json();
  assert.equal(response.status, 499); assert.equal(body.error, 'Request canceled.'); assert.equal(body.resources, undefined);
});

test('five-minute RAM cache still reevaluates forecast expiry on every foreground request', async () => {
  const f = fixture({ payload: payload({ 'Observation Time': '2026-11-20 03:00:00',
    'Forecast Time': '2026-11-20 03:48:00', coordinates: [[272, 40, 30]] }) });
  const first = await f.read({ useCache: true }); assert.equal(first.aurora.status, 'live'); assert.ok(first.events.some(event => event.type === 'aurora'));
  const cached = await f.read({ now: new Date('2026-11-20T04:04:00Z'), useCache: true });
  assert.equal(f.calls.length, 1); assert.equal(cached.aurora.status, 'stale'); assert.equal(cached.events.length, 0);
  await f.read({ now: new Date('2026-11-20T04:06:00Z'), useCache: true }); assert.equal(f.calls.length, 2);
});

test('production-available read-only route rejects methods, user sources and canceled requests before source work', async () => {
  const f = fixture(); const base = 'https://app.example/api/weather-preview/astronomy';
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await f.route[method](new Request(base, { method }));
    assert.equal(response.status, 405); assert.equal(response.headers.get('Allow'), 'GET');
  }
  for (const query of ['?url=https://unrelated.example', '?lat=0&lon=0', '?date=2027-01-01']) {
    assert.equal((await f.route.GET(new Request(base + query))).status, 400);
  }
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.route.GET(new Request(base, { signal: controller.signal }))).status, 499);
  assert.equal(f.calls.length, 0);
  const response = await f.route.GET(new Request(base)), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.location.latitude, 40.138080); assert.equal(body.location.longitude, -88.251416);
  assert.deepEqual(Object.keys(body.resources), ['astronomy']); assert.equal(body.resources.astronomy.status, 'live');
  assert.equal(body.resources.astronomy.sourceTimestamp, body.resources.astronomy.data.moonPhase.calculatedAt);
  assert.equal(body.resources.astronomy.error, null); assert.equal(f.calls.length, 1);
});
