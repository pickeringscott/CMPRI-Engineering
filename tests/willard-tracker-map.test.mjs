import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../public/previews/weather/willard-tracker.js', import.meta.url), 'utf8');
const START = Date.parse('2026-11-20T18:00:00Z'), TTL = 180000;
function deferred() { let resolve, reject; const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
async function settle() { for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve)); }
function fixture({ clockMode = '24' } = {}) {
  const dom = new JSDOM('<!doctype html><div id="host"></div><div id="other"></div>', { url: 'https://cmpri.example/previews/cmpri-weather-preview.html', runScripts: 'outside-only' });
  const { window } = dom; let now = START, hidden = false, nextTimer = 0;
  const timers = new Map(), reads = [], bitmaps = [], forbidden = [], instances = [];
  const RealDate = window.Date;
  window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  window.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + Number(delay || 0), delay: Number(delay || 0) }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => { forbidden.push('interval'); throw new Error('No Background Interval'); };
  window.Storage.prototype.setItem = () => forbidden.push('storage');
  window.Notification = { requestPermission() { forbidden.push('notification'); } };
  window.PushManager = class { subscribe() { forbidden.push('push'); } };
  window.navigator.geolocation = { getCurrentPosition() { forbidden.push('GPS'); } };
  window.supabase = { from() { forbidden.push('database'); } };
  const context = new Proxy({}, { get(target, key) { if (!(key in target)) target[key] = () => {}; return target[key]; } });
  window.HTMLCanvasElement.prototype.getContext = () => context;
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 450, width: 640, height: 450 }; };
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.createImageBitmap = async () => { const bitmap = { closed: false, close() { this.closed = true; } }; bitmaps.push(bitmap); return bitmap; };
  const airport = { lat: 40.0398, lon: -88.2762 };
  function plane(overrides = {}) { return { hex: 'abc123', callsign: 'TEST123', registration: 'N123AB', type: 'C172', lat: 40.05, lon: -88.26, altitudeFeet: 0, speedKnots: 0, track: 0, seenSeconds: 2, positionAgeSeconds: 10, ...overrides }; }
  let payload = { airport: 'KCMI', status: 'live', observedAt: new Date(START).toISOString(), retrievedAt: new Date(START).toISOString(), aircraft: [plane()], source: 'https://api.adsb.lol/v2/point/40.03/-88.28/50' };
  let sourceHandler = async () => ({ ok: true, json: async () => payload });
  let tileHandler = async () => ({ ok: true, blob: async () => new window.Blob(['test'], { type: 'image/png' }) });
  window.fetch = (url, options) => { reads.push({ url: String(url), options }); return String(url).startsWith('/api/willard-tracker') ? sourceHandler(url, options) : tileHandler(url, options); };
  window.eval(source);
  function create(id = 'host', mode = clockMode) { const api = window.cmpriWillardTracker.create(window.document.getElementById(id), { clockMode: mode }); instances.push(api); return api; }
  const api = create();
  function pointer(type, x, y, target = window.document.querySelector('.wt-canvas')) { const event = new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }); Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event); return event; }
  async function advance(ms) {
    now += ms;
    const due = Array.from(timers).filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) { if (!timers.has(id)) continue; timers.delete(id); timer.fn(); }
    await settle();
  }
  return { window, api, create, airport, plane, reads, timers, bitmaps, pointer, advance,
    get now() { return now; }, setPayload(value) { payload = value; }, setSource(handler) { sourceHandler = handler; }, setTiles(handler) { tileHandler = handler; },
    hide(value) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    button(action, id = 'host') { return window.document.querySelector(`#${id} .wt-tools [data-action="${action}"]`); },
    sourceReads() { return reads.filter((read) => read.url === '/api/willard-tracker'); },
    close() { instances.forEach((instance) => instance.destroy()); assert.equal(timers.size, 0, 'destroy cleans up all foreground timers'); assert.ok(bitmaps.every((image) => image.closed), 'destroy releases every decoded bitmap'); assert.deepEqual(forbidden, [], 'no background interval, storage, GPS, database, permission or push'); window.close(); },
  };
}

test('tracker is independent, inactive by default, and projects the fixed CMI pin to the actual center', async () => {
  const f = fixture();
  try {
    assert.equal(f.reads.length, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.api.getState().active, false); assert.equal(f.api.getState().aircraftCount, null);
    const other = f.create('other', '12');
    f.api.setActive(true); await settle();
    const state = f.api.getState();
    assert.equal(state.zoom, 9); assert.equal(state.airport.x, 320); assert.ok(Math.abs(state.airport.y - 225) < 1e-8);
    assert.ok(Math.abs(state.center.lat - f.airport.lat) < 1e-9); assert.ok(Math.abs(state.center.lon - f.airport.lon) < 1e-9);
    assert.equal(other.getState().active, false); assert.equal(other.getState().requests, 0, 'instances do not share activation or requests');
    for (const zoom of [4, 9, 14]) {
      const point = f.window.cmpriWillardTracker.project(f.airport.lat, f.airport.lon, zoom);
      const location = f.window.cmpriWillardTracker.unproject(point.x, point.y, zoom);
      assert.ok(Math.abs(location.lat - f.airport.lat) < 1e-9); assert.ok(Math.abs(location.lon - f.airport.lon) < 1e-9);
    }
    assert.ok(f.reads.every((read) => read.url === '/api/willard-tracker' || /^\/api\/weather-preview\/basemap\?dataset=topo&op=tile&z=\d+&x=\d+&y=\d+$/.test(read.url)));
    assert.equal(f.sourceReads()[0].options.method, 'GET'); assert.equal(f.sourceReads()[0].options.credentials, 'same-origin');
    assert.match(f.window.document.querySelector('.wt-license').href, /opendatacommons.org\/licenses\/odbl\/1-0/);
  } finally { f.close(); }
});

test('markers use only reported positions and track; valid zero values and unknown fields remain distinct', async () => {
  const f = fixture();
  try {
    const rows = [f.plane(), f.plane({ hex: 'def456', callsign: null, registration: null, lat: 40.06, lon: -88.27, altitudeFeet: 'ground', track: null, speedKnots: null, positionAgeSeconds: null })];
    f.setPayload({ status: 'live', observedAt: new Date(START).toISOString(), aircraft: rows });
    f.api.setActive(true); await settle();
    const before = f.api.getState();
    assert.equal(before.aircraftCount, 2); assert.equal(before.aircraftCoverageVerified, true);
    assert.deepEqual(Array.from(before.markers, (marker) => [marker.hex, marker.kind, marker.track]), [['abc123', 'arrow', 0], ['def456', 'dot', null]]);
    assert.equal(before.markers[1].stale, true, 'unknown position age never masquerades as a fresh position');
    assert.equal(before.aircraft[0].altitudeFeet, 0); assert.equal(before.aircraft[0].speedKnots, 0);
    const actual = before.markers[0]; f.pointer('click', actual.x, actual.y);
    assert.match(f.window.document.querySelector('.wt-details').textContent, /0 Ft/); assert.match(f.window.document.querySelector('.wt-details').textContent, /0 Kt/);
    f.pointer('click', before.markers[1].x, before.markers[1].y);
    assert.match(f.window.document.querySelector('.wt-details').textContent, /Ground/); assert.match(f.window.document.querySelector('.wt-details').textContent, /Unknown/);
    await f.advance(60000);
    const after = f.api.getState();
    assert.deepEqual(Array.from(after.markers, (marker) => [marker.lat, marker.lon, marker.x, marker.y]), Array.from(before.markers, (marker) => [marker.lat, marker.lon, marker.x, marker.y]), 'elapsed time never predicts movement');
    assert.equal(after.aircraft[0].positionAgeSeconds, 70, 'position age includes elapsed time since the original snapshot');
    assert.equal(after.observedAt, new Date(START).toISOString());
  } finally { f.close(); }
});

test('wheel zoom requires a click, resets on pointer leave, and pan/zoom/recenter keep geographic anchors correct', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); await settle(); const canvas = f.window.document.querySelector('.wt-canvas');
    const initial = f.api.getState();
    const wheel = () => { const event = new f.window.WheelEvent('wheel', { clientX: 320, clientY: 225, deltaY: -120, bubbles: true, cancelable: true }); canvas.dispatchEvent(event); return event; };
    assert.equal(wheel().defaultPrevented, false); assert.equal(f.api.getState().zoom, 9);
    f.pointer('click', 320, 225); assert.equal(wheel().defaultPrevented, true); assert.equal(f.api.getState().zoom, 10);
    f.pointer('pointerleave', 320, 225); assert.equal(wheel().defaultPrevented, false); assert.equal(f.api.getState().zoom, 10);
    f.pointer('pointerdown', 320, 225); f.pointer('pointermove', 400, 245); f.pointer('pointerup', 400, 245);
    assert.ok(Math.abs(f.api.getState().center.lon - initial.center.lon) > .01);
    f.button('zoom-out').click(); assert.equal(f.api.getState().zoom, 9);
    f.button('recenter').click(); const centered = f.api.getState();
    assert.ok(Math.abs(centered.center.lat - initial.center.lat) < 1e-9); assert.ok(Math.abs(centered.center.lon - initial.center.lon) < 1e-9);
    assert.equal(centered.airport.x, 320); assert.ok(Math.abs(centered.airport.y - 225) < 1e-8);
    f.button('fullscreen').click(); assert.equal(f.window.document.querySelector('.wt-map').classList.contains('wt-expanded'), true, 'fullscreen fallback expands this independent map');
    f.button('fullscreen').click(); assert.equal(f.window.document.querySelector('.wt-map').classList.contains('wt-expanded'), false);
  } finally { f.close(); }
});

test('fresh activation reuses memory while the foreground timer refreshes only when active and visible', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); await settle(); assert.equal(f.sourceReads().length, 1); assert.equal(f.api.getState().refreshTimerActive, true);
    f.api.setActive(false); assert.equal(f.api.getState().refreshTimerActive, false); assert.equal(f.api.getState().tileCacheSize, 0);
    await f.advance(60000); f.api.setActive(true); await settle();
    assert.equal(f.sourceReads().length, 1, 'fresh source memory is reused');
    await f.advance(120000);
    assert.equal(f.sourceReads().length, 2, 'cache reuse does not extend the original freshness deadline');
    f.hide(true); assert.equal(f.api.getState().active, false); assert.equal(f.api.getState().refreshTimerActive, false);
    const count = f.sourceReads().length; await f.advance(TTL * 2); assert.equal(f.sourceReads().length, count);
    f.hide(false); await settle(); assert.equal(f.api.getState().active, true); assert.equal(f.sourceReads().length, count + 1);
    f.api.setActive(false); const stopped = f.sourceReads().length; await f.advance(TTL * 2); assert.equal(f.sourceReads().length, stopped);
  } finally { f.close(); }
});

test('a delayed successful read cannot check again just before the shared server cache expires', async () => {
  const f = fixture(), read = deferred();
  try {
    f.setSource(() => read.promise);
    f.api.setActive(true); await settle();
    await f.advance(2000);
    read.resolve({ ok: true, json: async () => ({ status: 'live', observedAt: new Date(START + 2000).toISOString(), aircraft: [f.plane()] }) });
    await settle();
    f.setSource(async () => ({ ok: true, json: async () => ({ status: 'live', observedAt: new Date(f.now).toISOString(), aircraft: [f.plane()] }) }));
    await f.advance(TTL - 2000);
    assert.equal(f.sourceReads().length, 1, 'request-start time does not shorten the returned cache interval');
    await f.advance(2000);
    assert.equal(f.sourceReads().length, 2, 'the next read follows the completed cache interval');
  } finally { f.close(); }
});

test('failed and stale reads preserve dimmed known aircraft, while verified empty results remain distinct', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); await settle(); const original = f.api.getState().observedAt;
    f.setSource(async () => { throw new Error('TEST Outage'); }); f.button('refresh').click(); await settle();
    const unavailable = f.api.getState();
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.aircraftCount, null); assert.equal(unavailable.retainedAircraftCount, 1);
    assert.equal(unavailable.markers[0].stale, true); assert.equal(unavailable.observedAt, original);
    assert.match(f.window.document.querySelector('.wt-status').textContent, /Unavailable/); assert.doesNotMatch(f.window.document.querySelector('.wt-status').textContent, /No Aircraft Reported/);
    f.setSource(async () => ({ ok: true, json: async () => ({ status: 'stale', observedAt: original, aircraft: [f.plane()] }) })); f.button('refresh').click(); await settle();
    assert.equal(f.api.getState().status, 'stale'); assert.equal(f.api.getState().markers[0].stale, true);
    f.setSource(async () => ({ ok: true, json: async () => ({ status: 'live', observedAt: new Date(f.now).toISOString(), aircraft: [] }) })); f.button('refresh').click(); await settle();
    assert.equal(f.api.getState().aircraftCount, 0); assert.equal(f.api.getState().aircraftCoverageVerified, false); assert.equal(f.api.getState().markers.length, 0);
    assert.match(f.window.document.querySelector('.wt-status').textContent, /No Aircraft Reported/);
    f.setSource(async () => ({ ok: true, json: async () => ({ status: 'live', observedAt: new Date(f.now).toISOString(), aircraft: [{ hex: 'invalid', lat: null, lon: 0 }] }) })); f.button('refresh').click(); await settle();
    assert.equal(f.api.getState().status, 'unavailable'); assert.equal(f.api.getState().aircraftCount, null);
  } finally { f.close(); }
});

test('pending reads and bitmap work abort on deactivation, late source results cannot replace a newer activation', async () => {
  const f = fixture();
  try {
    const old = deferred(), next = deferred(); f.setSource(() => old.promise);
    f.setTiles((_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { const error = new Error('Aborted'); error.name = 'AbortError'; reject(error); }, { once: true }); }));
    f.api.setActive(true); assert.equal(f.api.getState().pendingTiles, 4); assert.equal(f.api.getState().pending, 1);
    const oldSource = f.sourceReads()[0]; f.api.setActive(false); assert.equal(oldSource.options.signal.aborted, true);
    assert.equal(f.api.getState().pending, 0); assert.equal(f.api.getState().pendingTiles, 0); assert.equal(f.timers.size, 0);
    f.setSource(() => next.promise); f.api.setActive(true);
    old.resolve({ ok: true, json: async () => ({ status: 'live', observedAt: new Date(START).toISOString(), aircraft: [f.plane({ lat: 10, lon: 10 })] }) }); await settle();
    assert.equal(f.api.getState().pending, 1); assert.equal(f.api.getState().retainedAircraftCount, 0, 'closed generation result is ignored');
    next.resolve({ ok: true, json: async () => ({ status: 'live', observedAt: new Date(START).toISOString(), aircraft: [f.plane()] }) }); await settle();
    assert.equal(f.api.getState().aircraftCount, 1); assert.equal(f.api.getState().aircraft[0].lat, 40.05);
    assert.ok(f.api.getState().pendingTiles <= 4);
  } finally { f.close(); }
});

test('tile cache stays bounded, deactivation closes its images, and role clocks preserve the same source timestamp', async () => {
  const f = fixture();
  try {
    const other = f.create('other', '12'); f.api.setActive(true); other.setActive(true); await settle();
    assert.match(f.window.document.querySelector('#host .wt-updated').textContent, /12:00 CST/);
    assert.match(f.window.document.querySelector('#other .wt-updated').textContent, /12:00 PM CST/);
    for (let index = 0; index < 128; index += 1) { f.pointer('pointerdown', 320, 225); f.pointer('pointermove', 20, 225); f.pointer('pointerup', 20, 225); await settle(); }
    const state = f.api.getState();
    assert.equal(state.tileCacheLimit, 256, 'cache accommodates a real4K fullscreen viewport');
    assert.ok(state.tileRequests > state.tileCacheLimit); assert.ok(state.tileCacheSize <= state.tileCacheLimit);
    assert.ok(f.bitmaps.some((image) => image.closed), 'evicted bitmaps are released');
    f.api.setActive(false); assert.equal(f.api.getState().tileCacheSize, 0); assert.equal(f.api.getState().refreshTimerActive, false);
  } finally { f.close(); }
});

test('rapid close/reopen starts fresh tile work and late aborted tiles cannot clear newer matching records', async () => {
  const f = fixture();
  try {
    const first = [], second = []; let phase = 'first';
    f.setTiles((_url, options) => {
      const pending = deferred();
      const row = { ...pending, signal: options.signal };
      if (phase === 'first') first.push(row);
      else if (second.length < 4) second.push(row);
      else return Promise.resolve({ ok: true, blob: async () => new f.window.Blob(['new tile']) });
      return row.promise;
    });
    f.api.setActive(true); await settle();
    assert.equal(first.length, 4); assert.equal(f.api.getState().pendingTiles, 4);
    f.api.setActive(false);
    assert.ok(first.every((read) => read.signal.aborted)); assert.equal(f.api.getState().pendingTiles, 0);
    phase = 'second'; f.api.setActive(true); await settle();
    assert.equal(second.length, 4, 'the reopened viewport does not wait on aborted promises');
    assert.equal(f.api.getState().pendingTiles, 4);
    first.forEach((read) => read.resolve({ ok: true, blob: async () => new f.window.Blob(['old tile']) })); await settle();
    assert.equal(f.api.getState().pendingTiles, 4, 'old finally blocks cannot delete newer records using the same tile keys');
    assert.equal(f.api.getState().tileCacheSize, 0, 'late aborted bitmaps do not enter the cache');
    second.forEach((read) => read.resolve({ ok: true, blob: async () => new f.window.Blob(['current tile']) })); await settle();
    assert.ok(f.api.getState().tileCacheSize > 0); assert.equal(f.api.getState().pendingTiles, 0);
    f.api.setActive(false); assert.equal(f.api.getState().tileCacheSize, 0);
  } finally { f.close(); }
});
