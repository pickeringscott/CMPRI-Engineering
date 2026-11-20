import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/previews/cmpri-weather-preview.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/previews/weather/weather-map.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/previews/weather/weather-map.css', import.meta.url), 'utf8');
const buttons = {
  reflectivity: 'mapLayerRadar', velocity: 'mapLayerVelocity', ptype: 'mapLayerPtype',
  roads: 'mapLayerRoads', impacts: 'mapLayerImpacts', alerts: 'mapLayerAlerts',
  cloudCover: 'mapLayerCloudCover',
};

function fixture() {
  const dom = new JSDOM(html, {
    url: 'https://preview.example/previews/cmpri-weather-preview.html?clock=24',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const forbidden = [];
  const errors = [];
  window.addEventListener('error', event => errors.push(event.error?.message || event.message));
  const reject = name => () => { forbidden.push(name); throw new Error(name + ' must not run before Weather opens'); };
  window.fetch = reject('network');
  window.setInterval = reject('scheduler');
  window.Notification = { requestPermission: reject('notification permission') };
  window.supabase = { from: reject('database'), rpc: reject('database') };
  window.HTMLCanvasElement.prototype.getContext = reject('canvas initialization');
  const style = window.document.createElement('style'); style.textContent = css; window.document.head.append(style);
  const marker = '  window.cmpriWeatherMap = {';
  window.eval(source.replace(marker, `  window.compactLegendProbe = () => {
    state.enabled.velocity = true; state.enabled.ptype = true;
    wmsLayers.velocity.legendUrl = 'blob:official-velocity-png';
    wmsLayers.ptype.legendUrl = 'blob:official-ptype-png';
    reflectivityLegendUrl = 'blob:official-reflectivity-png'; updateUI();
  };
  window.forecastClockProbe = () => { state.enabled.cloudCover = true;
    wmsLayers.cloudCover.state.displayedTime = '2026-11-20T13:00Z'; updateUI(); };
${marker}`));
  const api = window.cmpriWeatherMap;
  api.init();

  function click(name) {
    const button = window.document.getElementById(buttons[name]);
    assert.ok(button, 'the actual preview contains a ' + name + ' toggle');
    button.click();
  }
  function selected(expected) {
    const layers = api.getState().layers;
    for (const [name, enabled] of Object.entries(expected)) {
      assert.equal(layers[name], enabled, name + ' selection is independent');
      assert.equal(window.document.getElementById(buttons[name]).getAttribute('aria-pressed'), String(enabled),
        name + ' button reflects its selection');
    }
  }
  function opacity(value) {
    const input = window.document.getElementById('mapOpacity');
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  async function cleanup() {
    // Native <details> toggle events are queued by jsdom. Let them run while the
    // window still exists, just as they do while the preview is mounted.
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = api.getState();
    assert.equal(state.opened, false, 'control inspection never opens the live map');
    assert.equal(state.networkRequests, 0);
    assert.equal(state.pendingRequests, 0);
    assert.equal(state.databaseCalls, 0);
    assert.equal(state.pushes, 0);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    dom.window.close();
  }
  return { window, api, click, selected, opacity, cleanup };
}

for (const order of [['roads', 'impacts'], ['impacts', 'roads']]) {
  test('winter layers stack in ' + order.join(' then ') + ' order without altering other selected layers', async () => {
    const f = fixture();
    try {
      f.click('velocity');
      f.click('ptype');
      f.selected({ reflectivity: true, velocity: true, ptype: true, alerts: true, roads: false, impacts: false });
      for (const name of order) f.click(name);
      const all = { reflectivity: true, velocity: true, ptype: true, alerts: true, roads: true, impacts: true };
      f.selected(all);

      f.click(order[0]);
      f.selected({ ...all, [order[0]]: false });
      f.click(order[0]);
      f.selected(all);
      f.click(order[1]);
      f.selected({ ...all, [order[1]]: false });
    } finally { await f.cleanup(); }
  });
}

test('verified forecast cloud-cover control remains independent and reads no data before Weather opens', async () => {
  const f = fixture();
  try {
    const { document } = f.window;
    assert.equal(document.getElementById('mapLayerSatellite'), null);
    assert.equal(document.getElementById('mapLayerLightning'), null);
    const control = document.getElementById(buttons.cloudCover);
    assert.equal(control.textContent.trim(), 'Forecast cloud cover');
    assert.match(control.title, /forecast percentage.*opaque clouds.*UTC valid time/i);
    f.click('velocity'); f.click('ptype'); f.click('roads'); f.click('impacts');
    const original = { reflectivity: true, velocity: true, ptype: true, alerts: true, roads: true, impacts: true };
    f.selected({ ...original, cloudCover: false });
    f.click('cloudCover'); f.selected({ ...original, cloudCover: true });
    assert.doesNotMatch(document.getElementById('mapFeedStatus').textContent, /cloud cover unavailable/i);
    assert.equal(document.querySelector('[data-legend=cloudCover]').textContent, 'Forecast cloud cover · %');
    assert.match(document.querySelector('[data-legend=cloudCover]').title, /official PNG color key is not advertised/);
    assert.equal(document.querySelector('[data-legend=cloudCover] img'), null);
    assert.equal(document.querySelector('#mapLegend img'), null,
      'selecting forecast cloud cover before opening cannot synthesize imagery or a color key');
    f.click('cloudCover'); f.selected({ ...original, cloudCover: false });
    assert.equal(document.querySelector('[data-legend=cloudCover]'), null);
    assert.equal('satellite' in f.api.getState().layers, false);
    assert.equal('lightning' in f.api.getState().layers, false);
  } finally { await f.cleanup(); }
});

test('the real legend accordion starts closed and preserves user disclosure state across control updates', async () => {
  const f = fixture();
  try {
    const { document } = f.window;
    const accordion = () => document.getElementById('mapLegendAccordion');
    const summary = () => document.getElementById('mapLegendSummary');
    const contents = () => document.getElementById('mapLegendContents');
    assert.equal(accordion()?.tagName, 'DETAILS');
    assert.equal(summary()?.tagName, 'SUMMARY');
    assert.equal(summary().parentElement, accordion());
    assert.ok(contents()?.closest('#mapLegendAccordion'));
    assert.equal(accordion().open, false);

    f.click('roads');
    assert.equal(accordion().open, false, 'adding a layer must not open the key automatically');
    assert.match(contents().textContent, /IDOT reported roads.*UNAVAILABLE/i);
    summary().click();
    assert.equal(accordion().open, true, 'the native summary opens the details');

    f.opacity('37');
    assert.equal(f.api.getState().opacity, 0.37);
    assert.equal(accordion().open, true, 'opacity updates retain the open key');
    f.click('impacts');
    f.click('velocity');
    assert.equal(accordion().open, true, 'layer updates retain the open key');
    assert.match(contents().textContent, /IDOT reported roads.*UNAVAILABLE/i);
    assert.match(contents().textContent, /WSSI forecast impacts/i);
    assert.equal(contents().querySelector('img'), null, 'no invented weather image or legend is inserted before a feed loads');

    summary().click();
    assert.equal(accordion().open, false);
    f.opacity('65');
    f.click('ptype');
    assert.equal(accordion().open, false, 'later updates retain the closed key');
  } finally { await f.cleanup(); }
});


test('official PNG keys share a compact borderless scale with readable units and unchanged source glyphs', async () => {
  const f = fixture();
  try {
    const { document } = f.window;
    f.window.compactLegendProbe();
    const rows = [...document.querySelectorAll('#mapLegend .cmpri-map-legend-row')];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.firstElementChild.tagName, 'STRONG');
      assert.equal(row.children[1].classList.contains('cmpri-reflectivity-scale'), true);
      assert.equal(f.window.getComputedStyle(row).width, '180px');
      assert.equal(f.window.getComputedStyle(row).borderTopWidth, '0px');
      assert.equal(f.window.getComputedStyle(row.querySelector('.cmpri-reflectivity-ticks')).fontSize, '9px');
      const image = row.querySelector('.cmpri-reflectivity-ramp img');
      assert.match(image.src, /^blob:official-/);
      assert.equal(image.style.filter, '', 'source colors are not recolored');
    }
    assert.match(document.querySelector('[data-legend=velocity] strong').textContent, /KILX.*knots/);
    assert.deepEqual([...document.querySelectorAll('.cmpri-velocity-ticks span')].map(node => node.textContent),
      ['RF', '−100', '−80', '−60', '−45', '−20', '+0', '20', '45', '60', '80', '100']);
    const categoryGlyphs = [...document.querySelectorAll('.cmpri-source-code-tick')];
    assert.equal(categoryGlyphs.length, 7);
    for (const glyph of categoryGlyphs) {
      assert.match(glyph.style.backgroundImage, /blob:official-ptype-png/);
      assert.equal(f.window.getComputedStyle(glyph).backgroundSize, '750px 45px');
      assert.equal(glyph.textContent, '', 'source abbreviations are preserved as source pixels, without guessed expansions');
    }
    assert.equal(document.querySelector('.cmpri-map-source-legend'), null, 'native-size scrolling keys are removed');
  } finally { await f.cleanup(); }
});


test('cloud forecast key displays source percent and UTC valid time in Central without an invented palette', async () => {
  const f = fixture();
  try {
    const { document } = f.window;
    f.window.forecastClockProbe();
    const key = document.querySelector('[data-legend=cloudCover]');
    assert.equal(key.querySelector('strong').textContent, 'Forecast cloud cover · %');
    assert.match(key.textContent, /Valid Nov 20, 2026, 07:00 CST/);
    assert.match(document.getElementById('scanTime').textContent, /Forecast cloud cover valid: Nov 20, 2026, 07:00 CST/);
    assert.doesNotMatch(key.textContent, /unavailable/i);
    assert.match(key.title, /official PNG color key is not advertised/);
    assert.equal(key.querySelector('img,.cmpri-map-swatch'), null);
  } finally { await f.cleanup(); }
});
