import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/previews/weather/weather-map.js', import.meta.url), 'utf8');
const START = Date.parse('2026-11-19T18:00:00Z');
const MINUTE = 60000;

// Exercise the real catalog, request queue, cache, and draw functions. The only
// injected seam supplies a canvas and calls those functions without the modal UI.
// All responses and bitmaps are fixtures; this does not verify live NOAA access.
function fixture() {
  let now = START;
  let bounds = { width: 800, height: 380 };
  let advertised = Array.from({ length: 60 }, (_, index) =>
    new Date(START - (60 - index) * 2 * MINUTE).toISOString());
  const initialTimes = [...advertised];
  const closed = new Set();
  const mapRequests = [];
  const pendingCatalogs = new Set();
  let draws = 0;
  let heldTime = null;
  let releaseHeld = null;

  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const document = {
    hidden: false, fullscreenElement: null,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
  const canvas = {
    getBoundingClientRect: () => ({ ...bounds }),
    classList: { remove() {} },
  };
  const context = {
    save() {}, restore() {},
    drawImage(bitmap) {
      assert.equal(bitmap.closed, false, 'a drawn image must remain decoded and open');
      draws += 1;
    },
  };
  const sandbox = {
    document, Date: FixtureDate, URLSearchParams, Intl, Map, Set, AbortController, DOMException,
    setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    location: { search: '?clock=24' },
    CustomEvent: class {
      constructor(type, options) { this.type = type; this.detail = options?.detail; }
    },
    URL: { createObjectURL: () => 'blob:radar-cache-fixture' },
    window: { dispatchEvent() {}, devicePixelRatio: 1 },
    fixtureCanvas: canvas, fixtureContext: context,
    createImageBitmap: async blob => ({
      width: blob.width, height: blob.height, closed: false,
      close() { this.closed = true; if (blob.time) closed.add(blob.time); },
    }),
    fetch: async (path, options) => {
      const url = new URL(path, 'https://fixture.example');
      assert.equal(url.origin, 'https://fixture.example');
      assert.equal(url.pathname, '/api/weather-preview/wms', 'only the mocked map transport may be read');
      assert.equal(url.searchParams.get('product'), 'reflectivity');
      const op = url.searchParams.get('op');
      if (op === 'capabilities') return {
        ok: true,
        json: async () => ({
          mapFormats: ['image/png'], legendSupported: true,
          layers: [{ name: 'conus_bref_qcd', crs: ['EPSG:3857'], styles: [{ name: 'radar_reflectivity' }],
            time: { values: advertised.join(',') } }],
        }),
      };
      assert.ok(op === 'map' || op === 'legend');
      const time = url.searchParams.get('time');
      if (op === 'map') {
        assert.ok(advertised.includes(time), 'every image must use an explicit advertised scan time');
        mapRequests.push(time);
        if (time === heldTime) await new Promise((resolve, reject) => {
          releaseHeld = resolve;
          options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
        });
      }
      return {
        ok: true,
        headers: { get: name => name === 'X-Weather-Time' ? time : null },
        blob: async () => ({ type: 'image/png', time,
          width: Number(url.searchParams.get('width')) || 500,
          height: Number(url.searchParams.get('height')) || 30 }),
      };
    },
  };
  const marker = '  window.cmpriWeatherMap = {';
  assert.equal(source.split(marker).length, 2, 'the test seam must match one module export');
  const instrumented = source.replace(marker, `  window.radarCacheProbe = {
    setup() { canvas = globalThis.fixtureCanvas; context = globalThis.fixtureContext;
      state.opened = true; state.active = true; state.loopMinutes = 120; },
    catalog() { return radarCatalog(generation); },
    prime() { primeFrames(); },
    draw() { drawRadar(geometry()); }
  };
${marker}`);
  vm.runInNewContext(instrumented, sandbox, { filename: 'weather-map.js' });
  const probe = sandbox.window.radarCacheProbe;
  const api = sandbox.window.cmpriWeatherMap;
  probe.setup();
  const state = () => JSON.parse(JSON.stringify(api.getState()));
  async function until(predicate, description) {
    for (let turn = 0; turn < 400; turn += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail('The fixture did not settle: ' + description);
  }
  async function settle() {
    await until(() => state().rasterLoads === 0 && state().rasterQueue === 0, 'all queued images');
  }
  function catalog() {
    const task = probe.catalog();
    pendingCatalogs.add(task);
    task.then(() => pendingCatalogs.delete(task), () => pendingCatalogs.delete(task));
    return task;
  }
  function draw() { draws = 0; probe.draw(); return draws; }
  async function warm() {
    await catalog(); await settle();
    assert.equal(state().readyFrameCount, 60);
    assert.equal(draw(), 1, 'the initial displayed scan draws');
  }
  return {
    state, catalog, settle, warm, draw, initialTimes, closed, mapRequests, until,
    prime: () => probe.prime(),
    bounds: value => { bounds = value; },
    catalogAt(times, timestamp) { advertised = times; now = timestamp; },
    hold(time) { heldTime = time; },
    hasHeld: () => releaseHeld !== null,
    release() { assert.ok(releaseHeld); heldTime = null; releaseHeld(); releaseHeld = null; },
    async cleanup() {
      api.close();
      await Promise.allSettled([...pendingCatalogs]);
      assert.equal(state().pendingRequests, 0);
      assert.equal(state().databaseCalls, 0);
      assert.equal(state().pushes, 0);
    },
  };
}

test('catalog rollover retains the displayed image and every ready scan in the current loop', async () => {
  const f = fixture();
  try {
    await f.warm();
    const displayed = f.state().displayedScanTime;
    const newerTimes = Array.from({ length: 5 }, (_, index) => new Date(START + index * 2 * MINUTE).toISOString());
    f.catalogAt([...f.initialTimes, ...newerTimes], START + 10 * MINUTE);
    await f.catalog(); await f.settle();
    const state = f.state();
    assert.equal(state.frameCount, 61, 'only scans inside the new 120-minute window are active');
    assert.equal(state.readyFrameCount, 61, 'eviction must prefer obsolete scans over current ready scans');
    assert.equal(state.frameProgress.filter(frame => frame.status === 'pending').length, 0);
    assert.equal(f.draw(), 1, 'the displayed scan must survive the cache boundary');
    assert.equal(f.state().displayedScanTime, displayed);
    assert.equal(f.closed.has(new Date(displayed).toISOString()), false);
    assert.equal(f.mapRequests.length, 65, 'only the five newly advertised scans need image reads');
    assert.ok(state.imageCacheSize <= state.imageCacheLimit);
  } finally { await f.cleanup(); }
});

test('a smaller viewport reuses larger loaded geographic coverage without another NOAA image read', async () => {
  const f = fixture();
  try {
    await f.warm();
    const before = f.state();
    const reads = f.mapRequests.length;
    f.bounds({ width: 790, height: 370 });
    f.prime(); await f.settle();
    assert.equal(f.mapRequests.length, reads, 'a new size-based key must not discard suitable loaded coverage');
    assert.equal(f.state().readyFrameCount, 60);
    assert.equal(f.draw(), 1);
    assert.equal(f.state().displayedScanTime, before.displayedScanTime);
    assert.deepEqual(f.state().displayedRasterExtent, before.displayedRasterExtent);
  } finally { await f.cleanup(); }
});

test('an evicted displayed image stays open until the held replacement has decoded and drawn', async () => {
  const f = fixture();
  try {
    await f.warm();
    const oldScan = f.state().displayedScanTime;
    const oldTime = new Date(oldScan).toISOString();
    const replacementTimes = Array.from({ length: 64 }, (_, index) =>
      new Date(START + 3 * 60 * MINUTE - (64 - index) * MINUTE).toISOString());
    const latest = replacementTimes.at(-1);
    f.catalogAt(replacementTimes, START + 3 * 60 * MINUTE);
    f.hold(latest);
    const nextCatalog = f.catalog();
    await f.until(() => f.hasHeld() && f.state().rasterLoads === 1 && f.state().rasterQueue === 0,
      '63 ready images while the selected replacement is held');
    assert.equal(f.state().readyFrameCount, 63);
    assert.equal(f.draw(), 1, 'background image loads must not erase the displayed raster');
    assert.equal(f.state().displayedScanTime, oldScan);
    assert.equal(f.closed.has(oldTime), false);

    f.release(); await nextCatalog; await f.settle();
    assert.equal(f.state().readyFrameCount, 64);
    assert.equal(f.state().displayedRasterRetained, true, 'the decoded old image is retained independently of cache membership');
    assert.equal(f.closed.has(oldTime), false, 'cache eviction must not close the image still on screen');
    assert.equal(f.draw(), 1);
    assert.equal(f.state().displayedScanTime, Date.parse(latest));
    assert.equal(f.closed.has(oldTime), true, 'release the old bitmap only after its replacement draws');
    assert.ok(f.state().imageCacheSize <= f.state().imageCacheLimit);
    assert.equal(f.mapRequests.length, 124, 'each advertised replacement is read only once');
  } finally { await f.cleanup(); }
});
