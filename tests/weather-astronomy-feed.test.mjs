import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../public/previews/weather/weather-astronomy-feed.js', import.meta.url), 'utf8');
const START = Date.parse('2026-11-20T05:30:00Z'); //23:30 Central; no device clock/position lookup.
const MINUTE = 60000, TTL = 5 * MINUTE;
const ENGINE = 'https://github.com/cosinekitty/astronomy';
const NASA = 'https://science.nasa.gov/eclipses/';
const NOAA = 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast';
function fixture() {
  const dom = new JSDOM('<!doctype html>', { url: 'https://cmpri.example/previews/cmpri-weather-preview.html', runScripts: 'outside-only' });
  const { window } = dom;
  let now = START, hidden = false, nextTimer = 0;
  const timers = new Map(), forbidden = [], reads = [], published = [];
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  window.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + Number(delay || 0) }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => { forbidden.push('interval'); throw new Error('No interval permitted'); };
  window.Storage.prototype.setItem = () => { forbidden.push('storage'); };
  window.Notification = { requestPermission() { forbidden.push('permission'); } };
  window.PushManager = class { subscribe() { forbidden.push('push'); } };
  window.supabase = { from() { forbidden.push('database'); } };
  function phase(overrides = {}) { return { label: 'New Moon', angle: 0, illumination: 0, calculatedAt: new Date(now).toISOString(), ...overrides }; }
  function event(type, overrides = {}) {
    return { type, title: 'TEST ' + type, start: new Date(now + 10 * MINUTE).toISOString(), end: new Date(now + 60 * MINUTE).toISOString(),
      sourceUrl: type === 'aurora' ? NOAA : ENGINE, ...overrides };
  }
  function response(data, status = 'live') { return { ok: true, json: async () => ({ resources: { astronomy: { status, data } } }) }; }
  let handler = async () => response({ moonPhase: phase(), events: [], aurora: { status: 'unavailable' } });
  window.fetch = (url, options) => { reads.push({ url, options }); return handler(url, options); };
  window.addEventListener('cmpri-weather-astronomy', (message) => published.push(message.detail));
  window.eval(source);
  function advance(milliseconds) {
    now += milliseconds;
    const due = Array.from(timers).filter(([, timer]) => timer.at <= now);
    due.forEach(([id, timer]) => { timers.delete(id); timer.fn(); });
  }
  return { window, api: window.cmpriWeatherAstronomyFeed, reads, timers, forbidden, published, phase, event, response,
    setHandler(next) { handler = next; }, hide(value) { hidden = value; }, advance,
    get now() { return now; },
    close() {
      window.dispatchEvent(new window.Event('pagehide'));
      assert.equal(timers.size, 0, 'pagehide cleans up the bounded request timeout');
      assert.deepEqual(forbidden, [], 'no storage, scheduler, database, push or permission calls');
      window.close();
    } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('astronomy reads only its fixed foreground endpoint and reuses a five-minute memory cache', async () => {
  const f = fixture();
  try {
    assert.equal(f.reads.length, 0, 'loading the script must not fetch');
    assert.equal(f.timers.size, 0);
    assert.equal(f.api.getData().moonPhase, null);
    assert.equal(f.api.getState().backgroundPolling, false);
    f.hide(true); await f.api.open(); assert.equal(f.reads.length, 0, 'hidden view does not read');
    f.hide(false); await f.api.open();
    assert.equal(f.reads.length, 1);
    const { url, options } = f.reads[0];
    assert.equal(url, '/api/weather-preview/astronomy');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal); assert.equal(f.timers.size, 0);
    assert.equal(f.api.getState().cacheTtlMs, TTL);
    assert.equal(f.api.getData().moonPhase.angle, 0);
    assert.equal(f.api.getData().moonPhase.illumination, 0, 'a real0% illuminated moon is not missing');
    f.api.close(); f.advance(TTL - 1); await f.api.open();
    assert.equal(f.reads.length, 1, 'fresh RAM cache survives close/open');
    f.api.close(); f.advance(1); await f.api.open();
    assert.equal(f.reads.length, 2, 'due data refreshes only when reopened');
    assert.equal(f.api.getState().databaseCalls, 0); assert.equal(f.api.getState().scheduler, false);
    assert.ok(f.published.length > 0, 'data is published to the existing foreground renderer');
  } finally { f.close(); }
});

test('close aborts a held read, suppresses its late result and does not clear a newer pending request', async () => {
  const f = fixture();
  try {
    const old = deferred(), current = deferred();
    f.setHandler(() => old.promise);
    const opening = f.api.open();
    await f.api.open(); assert.equal(f.reads.length, 1, 'repeated open deduplicates the pending read');
    assert.equal(f.timers.size, 1);
    f.api.close(); assert.equal(f.reads[0].options.signal.aborted, true); assert.equal(f.timers.size, 0);
    f.setHandler(() => current.promise);
    const reopening = f.api.open();
    old.resolve(f.response({ moonPhase: f.phase({ label: 'OLD late phase' }), events: [f.event('lunar-eclipse')] }));
    await opening;
    assert.equal(f.api.getState().pendingRequests, 1, 'old finally cannot clear the new request');
    assert.equal(f.api.getData().moonPhase, null, 'late closed-generation phase is ignored');
    current.resolve(f.response({ moonPhase: f.phase({ label: 'Current phase' }), events: [] }));
    await reopening;
    assert.equal(f.api.getData().moonPhase.label, 'Current phase');
    assert.equal(f.api.getState().pendingRequests, 0); assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test('the request has a bounded timeout and no background work continues after failure or close', async () => {
  const f = fixture();
  try {
    f.setHandler((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
    }));
    const opening = f.api.open();
    assert.equal(f.timers.size, 1);
    f.advance(15000); await opening;
    assert.equal(f.reads[0].options.signal.aborted, true);
    assert.equal(f.api.getState().status, 'unavailable');
    assert.match(f.api.getState().error, /timed out/);
    assert.equal(f.api.getState().pendingRequests, 0); assert.equal(f.timers.size, 0);
    f.api.close(); f.advance(60 * MINUTE);
    assert.equal(f.reads.length, 1, 'elapsed time never schedules another request');
  } finally { f.close(); }
});

test('failed refresh keeps calculated eclipses while suppressing cached aurora notices', async () => {
  const f = fixture();
  try {
    const data = { moonPhase: f.phase(), events: [f.event('solar-eclipse', { sourceUrl: NASA }), f.event('lunar-eclipse'), f.event('aurora')], aurora: { status: 'live' } };
    f.setHandler(async () => f.response(data)); await f.api.open();
    assert.deepEqual(Array.from(f.api.getData().events, (event) => event.type), ['solar-eclipse', 'lunar-eclipse', 'aurora']);
    f.api.close(); f.advance(TTL);
    f.setHandler(async () => { throw new Error('TEST NOAA data unavailable'); }); await f.api.open();
    assert.equal(f.api.getState().status, 'stale');
    assert.deepEqual(Array.from(f.api.getData().events, (event) => event.type), ['solar-eclipse', 'lunar-eclipse']);
    assert.equal(f.api.getData().moonPhase.angle, 0);
    f.advance(56 * MINUTE);
    assert.equal(f.api.getData().events.length, 0, 'expired cached eclipses disappear without a request');
    assert.equal(f.api.getData().moonPhase, null, 'phase older than an hour falls back to the renderer');
    assert.equal(f.reads.length, 2);
  } finally { f.close(); }
});

test('event filtering requires supported types, valid future intervals and verified official source URLs', async () => {
  const f = fixture();
  try {
    const valid = [f.event('solar-eclipse', { title: 'NASA source', sourceUrl: NASA }), f.event('lunar-eclipse', { title: 'Engine source', sourceUrl: ENGINE + '/blob/master/README.md' }), f.event('aurora', { title: 'NOAA source' })];
    const invalid = [
      f.event('unknown'), f.event('solar-eclipse', { title: '' }), f.event('solar-eclipse', { title: 'x'.repeat(121) }),
      f.event('solar-eclipse', { start: 'not a timestamp' }), f.event('solar-eclipse', { end: null }),
      f.event('solar-eclipse', { start: new Date(f.now).toISOString(), end: new Date(f.now).toISOString() }),
      f.event('solar-eclipse', { start: new Date(f.now - MINUTE).toISOString(), end: new Date(f.now).toISOString() }),
      f.event('solar-eclipse', { start: new Date(f.now + 7 * 86400000 + 1).toISOString(), end: new Date(f.now + 7 * 86400000 + MINUTE).toISOString() }),
      ...['http://www.noaa.gov/alert', 'https://www.noaa.gov.evil.example/alert', 'https://evilnoaa.gov/alert', 'https://user:secret@www.nasa.gov/eclipse', 'https://github.com/other/astronomy', 'https://github.com/cosinekitty/astronomyevil'].map((sourceUrl) => f.event('solar-eclipse', { sourceUrl })),
    ];
    f.setHandler(async () => f.response({ moonPhase: f.phase(), events: [...valid, ...invalid] })); await f.api.open();
    assert.deepEqual(Array.from(f.api.getData().events, (event) => event.title), ['NASA source', 'Engine source', 'NOAA source']);
    assert.equal(f.api.getData().aurora.status, 'unavailable', 'missing aurora metadata is not an all-clear');
  } finally { f.close(); }
});

test('aurora notices stay inside the live90-minute start/two-hour duration window', async () => {
  const f = fixture();
  try {
    const valid = f.event('aurora', { title: 'At permitted limits', start: new Date(f.now + 90 * MINUTE).toISOString(), end: new Date(f.now + 210 * MINUTE).toISOString() });
    const tooLate = f.event('aurora', { start: new Date(f.now + 90 * MINUTE + 1).toISOString(), end: new Date(f.now + 150 * MINUTE).toISOString() });
    const tooLong = f.event('aurora', { start: new Date(f.now).toISOString(), end: new Date(f.now + 120 * MINUTE + 1).toISOString() });
    f.setHandler(async () => f.response({ moonPhase: f.phase(), events: [valid, tooLate, tooLong] })); await f.api.open();
    assert.equal(f.api.getData().events.length, 1); assert.equal(f.api.getData().events[0].title, 'At permitted limits');
    f.api.close(); f.advance(TTL); f.setHandler(async () => f.response({ moonPhase: f.phase(), events: [f.event('aurora')] }, 'stale')); await f.api.open();
    assert.equal(f.api.getData().events.length, 0, 'stale source cannot generate an aurora notice');
  } finally { f.close(); }
});

test('moon phase requires a recent valid calculation while preserving true zero angle and illumination', async () => {
  const cases = [
    [{ angle: 0, illumination: 0 }, true], [{ calculatedAt: new Date(START - 60 * MINUTE).toISOString() }, true],
    [{ calculatedAt: new Date(START + 5 * MINUTE).toISOString() }, true],
    [{ calculatedAt: new Date(START - 60 * MINUTE - 1).toISOString() }, false],
    [{ calculatedAt: new Date(START + 5 * MINUTE + 1).toISOString() }, false],
    [{ calculatedAt: 'bad timestamp' }, false], [{ calculatedAt: null }, false],
    [{ angle: 360 }, false], [{ angle: -1 }, false], [{ illumination: -0.01 }, false], [{ illumination: 1.01 }, false],
  ];
  for (const [overrides, accepted] of cases) {
    const f = fixture();
    try {
      f.setHandler(async () => f.response({ moonPhase: f.phase(overrides), events: [] })); await f.api.open();
      assert.equal(f.api.getData().moonPhase !== null, accepted, JSON.stringify(overrides));
    } finally { f.close(); }
  }
});
