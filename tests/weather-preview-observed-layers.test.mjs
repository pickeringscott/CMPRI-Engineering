import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/previews/weather/weather-map.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-20T12:25:00Z');
const PRODUCTS = {
  satellite: { layer: 'goes_longwave_imagery', style: 'goes-lir', time: '2026-11-20T12:13:00Z',
    source: 'https://nowcoast.noaa.gov/geoserver/observations/satellite/ows' },
  lightning: { layer: 'ldn_lightning_strike_density', style: 'lightning_density', time: '2026-11-20T12:00:00Z',
    source: 'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows' },
};

// The real WMS loaders and canvas renderer run with explicit local responses.
// The injected seam supplies initial view state and invokes existing functions;
// it does not replace request, cache, time-selection, draw, or lifecycle logic.
function fixture() {
  const products = structuredClone(PRODUCTS), calls = [], bitmaps = [], drawn = [];
  const tasks = new Set();
  let held = null, releaseHeld = null, now = NOW;
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class FixtureURL extends URL {
    static createObjectURL() { return 'blob:observed-layer-fixture'; }
    static revokeObjectURL() {}
  }
  const document = {
    hidden: false, fullscreenElement: null,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
  const canvas = { getBoundingClientRect: () => ({ width: 800, height: 380 }), classList: { remove() {} } };
  const context = {
    save() {}, restore() {}, setTransform() {}, fillRect() {}, beginPath() {},
    arc() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { if (String(this.fillStyle).startsWith('rgba(')) drawn.push('wssi'); },
    drawImage(bitmap) {
      assert.equal(bitmap.closed, false, 'rendering cannot use a closed bitmap');
      drawn.push(bitmap.product);
    },
  };
  const sandbox = {
    document, Date: FixtureDate, URL: FixtureURL, URLSearchParams, Intl, Map, Set, AbortController, DOMException,
    setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    location: { search: '?clock=24' },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    window: {
      dispatchEvent() {}, devicePixelRatio: 1,
      cmpriGroundMap: { draw() { drawn.push('ground'); }, drawReferences() { drawn.push('roads'); },
        close() {}, getState() { return null; } },
    },
    fixtureCanvas: canvas, fixtureContext: context,
    createImageBitmap: async blob => {
      const bitmap = { product: blob.product, time: blob.time, width: blob.width, height: blob.height,
        closed: false, close() { this.closed = true; } };
      bitmaps.push(bitmap); return bitmap;
    },
    fetch: async (path, options) => {
      const url = new URL(path, 'https://fixture.example'), query = url.searchParams;
      assert.equal(url.origin, 'https://fixture.example');
      assert.equal(url.pathname, '/api/weather-preview/wms');
      const product = query.get('product'), op = query.get('op'), expected = products[product];
      assert.ok(expected, 'only selected observed fixture products can request data');
      calls.push({ product, op, time: query.get('time') });
      if (op === 'capabilities') return { ok: true, json: async () => ({
        source: expected.source, mapFormats: ['image/png'], legendSupported: true,
        layers: [{ name: expected.layer, crs: ['EPSG:3857'], styles: [{ name: expected.style }],
          time: { values: expected.time, default: expected.time } }],
      }) };
      assert.ok(op === 'map' || op === 'legend');
      assert.equal(query.get('layer'), expected.layer);
      assert.equal(query.get('style'), expected.style);
      const time = query.get('time');
      if (op === 'map') {
        assert.equal(Date.parse(time), Date.parse(expected.time), 'maps use the exact advertised observation');
        if (held === product) await new Promise((resolve, reject) => {
          releaseHeld = resolve;
          options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
        });
      }
      return {
        ok: true, headers: { get: name => name === 'X-Weather-Time' ? time : expected.source },
        blob: async () => ({ type: 'image/png', product, time,
          width: Number(query.get('width')) || 180, height: Number(query.get('height')) || 24 }),
      };
    },
  };
  const marker = '  window.cmpriWeatherMap = {';
  assert.equal(source.split(marker).length, 2, 'one existing module export is the fixture seam');
  const instrumented = source.replace(marker, `  window.observedLayerProbe = {
    setup() { canvas = globalThis.fixtureCanvas; context = globalThis.fixtureContext;
      state.opened = true; state.active = true; state.showRadar = false;
      state.enabled.satellite = true; state.enabled.lightning = true; },
    load(name, refresh) { return loadWmsProduct(name, refresh); },
    draw() { draw(); },
    seedRadar() { state.showRadar = true; displayedRaster = {
      bitmap: { product: 'reflectivity', closed: false }, extent: viewport(geometry()), time: 1 }; },
    seedImpacts() { state.impacts = true;
      state.forecastRenderer = [{ value: 'MINOR', symbol: { color: [100, 110, 120, 255] } }];
      state.forecastFeatures = [{ attributes: { impact: 'MINOR' }, reviewTiming: { stale: false },
        geometry: { rings: [[[-88.3, 40.1], [-88.2, 40.1], [-88.2, 40.2], [-88.3, 40.1]]] } }]; }
  };
${marker}`);
  vm.runInNewContext(instrumented, sandbox, { filename: 'weather-map.js' });
  const api = sandbox.window.cmpriWeatherMap, probe = sandbox.window.observedLayerProbe;
  probe.setup();
  const state = () => JSON.parse(JSON.stringify(api.getState()));
  function load(name, refresh = false) {
    const task = probe.load(name, refresh); tasks.add(task);
    task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;
  }
  async function until(predicate) {
    for (let turn = 0; turn < 100; turn += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail('held fixture request did not begin');
  }
  return {
    state, calls, products, bitmaps, document, api, load, until,
    draw() { drawn.length = 0; probe.draw(); return [...drawn]; },
    seedRadar: () => probe.seedRadar(), seedImpacts: () => probe.seedImpacts(),
    advance(minutes) { now += minutes * 60000; },
    hold(name) { held = name; }, hasHeld: () => releaseHeld !== null,
    release() { held = null; releaseHeld?.(); releaseHeld = null; },
    async cleanup() { api.close(); await Promise.allSettled([...tasks]); },
  };
}

test('cloud and lightning use separate advertised images, times and legends in the geographic drawing order', async () => {
  const f = fixture();
  try {
    await Promise.all([f.load('satellite'), f.load('lightning')]);
    const state = f.state();
    for (const [name, expected] of Object.entries(PRODUCTS)) {
      const layer = state.wmsLayers[name];
      assert.equal(state.layers[name], true);
      assert.equal(layer.layer, expected.layer); assert.equal(layer.style, expected.style);
      assert.equal(Date.parse(layer.displayedTime), Date.parse(expected.time));
      assert.equal(layer.imageLoaded, true); assert.equal(layer.legendLoaded, true);
      assert.equal(layer.mapSource, expected.source); assert.equal(layer.legendSource, expected.source);
      assert.equal(f.calls.filter(call => call.product === name && call.op === 'legend').length, 1);
    }
    f.seedRadar(); f.seedImpacts();
    assert.deepEqual(f.draw(), ['ground', 'satellite', 'wssi', 'reflectivity', 'lightning', 'roads']);
    const count = f.calls.length;
    f.advance(60);
    for (const name of Object.keys(PRODUCTS)) {
      const layer = f.state().wmsLayers[name];
      assert.equal(layer.stale, true, 'the displayed observation becomes stale as its own timestamp ages');
      assert.ok(layer.ageMinutes > layer.staleAfterMinutes);
      assert.equal(Date.parse(layer.displayedTime), Date.parse(PRODUCTS[name].time));
    }
    assert.equal(f.calls.length, count, 'display freshness does not create a background read');
  } finally { await f.cleanup(); }
});

for (const name of Object.keys(PRODUCTS)) {
  test(name + ' retains the displayed bitmap and timestamp until a verified replacement is ready', async () => {
    const f = fixture();
    try {
      await f.load(name);
      const before = f.state().wmsLayers[name];
      const oldBitmap = f.bitmaps.find(bitmap => bitmap.product === name && bitmap.time);
      f.products[name].time = '2026-11-20T12:18:00Z';
      f.hold(name); const replacement = f.load(name, true);
      await f.until(f.hasHeld);
      const during = f.state().wmsLayers[name];
      assert.equal(Date.parse(during.displayedTime), Date.parse(before.displayedTime));
      assert.deepEqual(during.extent, before.extent);
      assert.equal(oldBitmap.closed, false);
      assert.ok(f.draw().includes(name), 'the prior source pixels remain drawable while loading');
      f.release(); await replacement;
      const after = f.state().wmsLayers[name];
      assert.equal(Date.parse(after.displayedTime), Date.parse(f.products[name].time));
      assert.equal(oldBitmap.closed, true, 'only a ready replacement releases the prior image');
    } finally { f.release(); await f.cleanup(); }
  });
}

test('hiding and closing abort observed layer requests while retaining cached images without new work', async () => {
  const f = fixture();
  try {
    await Promise.all([f.load('satellite'), f.load('lightning')]);
    f.products.lightning.time = '2026-11-20T12:18:00Z';
    f.hold('lightning'); const pending = f.load('lightning', true);
    await f.until(f.hasHeld);
    f.document.hidden = true; f.api.pause(); await pending;
    const paused = f.state(), count = f.calls.length;
    assert.equal(paused.active, false); assert.equal(paused.pendingRequests, 0);
    assert.ok(Object.values(paused.wmsLayers).every(layer => layer.pending === 0));
    assert.equal(paused.wmsLayers.satellite.imageLoaded, true);
    assert.equal(paused.wmsLayers.lightning.imageLoaded, true);
    assert.equal(Date.parse(paused.wmsLayers.lightning.displayedTime), Date.parse(PRODUCTS.lightning.time));
    await f.load('satellite', true); f.api.close(); await f.load('lightning', true);
    assert.equal(f.calls.length, count, 'hidden and closed map states cannot start requests');
    assert.equal(f.state().databaseCalls, 0); assert.equal(f.state().pushes, 0);
  } finally { f.release(); await f.cleanup(); }
});
