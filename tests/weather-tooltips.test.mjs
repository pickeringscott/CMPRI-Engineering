import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../public/previews/weather/weather-tooltips.js', import.meta.url), 'utf8');

function fixture(markup = '') {
  const dom = new JSDOM('<!doctype html><html><head><title>Weather document title</title></head><body>' + markup + '</body></html>', {
    url: 'https://cmpri.example/previews/cmpri-weather-preview.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom, forbidden = [];
  const reject = name => () => { forbidden.push(name); throw Error('Unexpected ' + name); };
  window.fetch = reject('fetch'); window.XMLHttpRequest = reject('XHR'); window.WebSocket = reject('WebSocket');
  window.setTimeout = reject('timer'); window.setInterval = reject('polling');
  window.Storage.prototype.setItem = reject('storage');
  window.Notification = { requestPermission: reject('notification permission') };
  window.supabase = { from: reject('database'), rpc: reject('database') };
  window.eval(source);
  const api = window.cmpriWeatherTooltips;
  api.init();
  async function flush() { for (let i = 0; i < 4; i++) await Promise.resolve(); }
  function cleanup() { api.disconnect(); assert.deepEqual(forbidden, []); dom.window.close(); }
  return { window, document: window.document, api, flush, cleanup };
}

test('every prose word starts uppercase, including connectors and hyphen/slash words, without lowercasing acronyms', () => {
  const f = fixture();
  try {
    assert.equal(f.api.titleCase('highest/lowest observed reading of the day and forecast hours'), 'Highest/Lowest Observed Reading Of The Day And Forecast Hours');
    assert.equal(f.api.titleCase('provider-published time; today’s wind and NOAA/NWS KCMI UTC MPH'), 'Provider-Published Time; Today’s Wind And NOAA/NWS KCMI UTC MPH');
    assert.equal(f.api.titleCase('don’t fill unknown gaps'), 'Don’t Fill Unknown Gaps');
    assert.equal(f.api.titleCase('éclipse and northern lights'), 'Éclipse And Northern Lights');
  } finally { f.cleanup(); }
});

test('source URLs, identifiers, measurements, callsigns and published timestamps remain intact', () => {
  const f = fixture();
  try {
    const input = 'source https://api.weather.gov/gridpoints/ILX/95,74?units=us and api.weather.gov; layer conus_bref_qcd style goes-lir with wmoUnit:degC windChill at 2026-11-20T13:05:00Z; wind 15 mph and 6 m/s, rain 0.2 in in the forecast; flight AA100 at 7:05 pm CST';
    assert.equal(f.api.titleCase(input), 'Source https://api.weather.gov/gridpoints/ILX/95,74?units=us And api.weather.gov; Layer conus_bref_qcd Style goes-lir With wmoUnit:degC windChill At 2026-11-20T13:05:00Z; Wind 15 mph And 6 m/s, Rain 0.2 in In The Forecast; Flight AA100 At 7:05 pm CST');
    assert.equal(f.api.titleCase('read /api/weather-preview and weather/weather-map.js or conus/conus_bref_qcd at 25 dBZ'), 'Read /api/weather-preview And weather/weather-map.js Or conus/conus_bref_qcd At 25 dBZ');
    assert.equal(f.api.titleCase('source `radar-reflectivity` at 32°F and 1013 hPa'), 'Source `radar-reflectivity` At 32°F And 1013 hPa');
  } finally { f.cleanup(); }
});

test('existing native and inline SVG tooltips change while official body, labels, links, IDs and aria labels retain their source text', () => {
  const f = fixture('<button id="map-layer" title="recenter on hotel" aria-label="recenter on hotel">recenter on hotel</button>'
    + '<p id="forecast">rain likely and winds of 15 mph.</p><a href="https://api.weather.gov/alerts/active" title="official NWS bulletin">read bulletin</a>'
    + '<svg viewBox="0 0 20 20"><title>observed temperature at KCMI</title><circle id="marker" title="current reading of the day" /></svg>');
  try {
    const button = f.document.getElementById('map-layer');
    assert.equal(button.title, 'Recenter On Hotel'); assert.equal(button.textContent, 'recenter on hotel');
    assert.equal(button.getAttribute('aria-label'), 'recenter on hotel'); assert.equal(button.id, 'map-layer');
    assert.equal(f.document.querySelector('svg title').textContent, 'Observed Temperature At KCMI');
    assert.equal(f.document.querySelector('svg circle').getAttribute('title'), 'Current Reading Of The Day');
    assert.equal(f.document.querySelector('head title').textContent, 'Weather document title');
    assert.equal(f.document.getElementById('forecast').textContent, 'rain likely and winds of 15 mph.');
    assert.equal(f.document.querySelector('a').href, 'https://api.weather.gov/alerts/active');
  } finally { f.cleanup(); }
});

test('dynamic title attributes, replaced SVG titles and nested custom tooltip text are formatted incrementally', async () => {
  const f = fixture('<button id="dial"></button><svg><title>first tooltip</title></svg><div id="tip" role="tooltip">wind <span>of the day</span><code>conus_bref_qcd</code></div>');
  try {
    await f.flush();
    f.document.getElementById('dial').title = 'forecast value and observed reading';
    f.document.querySelector('svg title').textContent = 'unknown gaps are not filled';
    const nested = f.document.createElement('strong'); nested.textContent = 'and NWS hourly forecast';
    f.document.getElementById('tip').append(nested);
    await f.flush();
    assert.equal(f.document.getElementById('dial').title, 'Forecast Value And Observed Reading');
    assert.equal(f.document.querySelector('svg title').textContent, 'Unknown Gaps Are Not Filled');
    assert.equal(f.document.getElementById('tip').textContent, 'Wind Of The Dayconus_bref_qcdAnd NWS Hourly Forecast');
    nested.firstChild.nodeValue = 'time of next scan'; await f.flush();
    assert.equal(nested.textContent, 'Time Of Next Scan');
    const added = f.document.createElement('div');
    added.innerHTML = '<button title="zoom in on the hotel">zoom in</button><div data-weather-tooltip>map of nearby towns</div>';
    f.document.body.append(added); await f.flush();
    assert.equal(added.querySelector('button').title, 'Zoom In On The Hotel');
    assert.equal(added.querySelector('[data-weather-tooltip]').textContent, 'Map Of Nearby Towns');
  } finally { f.cleanup(); }
});

test('data tooltip strings do not rewrite control labels and newly assigned tooltip roles format their bodies', async () => {
  const f = fixture('<button data-tooltip="wind direction and speed" data-tooltip-content="forecast source of NOAA">ordinary label</button><div id="future">future custom hint</div>');
  try {
    const button = f.document.querySelector('button');
    assert.equal(button.dataset.tooltip, 'Wind Direction And Speed');
    assert.equal(button.dataset.tooltipContent, 'Forecast Source Of NOAA');
    assert.equal(button.textContent, 'ordinary label');
    const future = f.document.getElementById('future'); future.setAttribute('role', 'tooltip'); await f.flush();
    assert.equal(future.textContent, 'Future Custom Hint');
  } finally { f.cleanup(); }
});

test('idempotent observer settles without loops, ignores non-tooltip changes, and disconnects on page exit', async () => {
  const f = fixture('<button title="forecast of the day">label</button><p id="body">official text</p>');
  try {
    await f.flush(); const stable = f.api.getState();
    assert.equal(f.api.titleCase(f.api.titleCase('wind of the day')), 'Wind Of The Day');
    f.document.querySelector('button').setAttribute('title', 'Forecast Of The Day'); await f.flush();
    assert.equal(f.api.getState().writes, stable.writes);
    const scans = f.api.getState().scans;
    f.document.getElementById('body').firstChild.nodeValue = 'unchanged official bulletin body'; await f.flush();
    assert.equal(f.api.getState().scans, scans, 'a changed text node does not rescan the document');
    assert.equal(f.document.getElementById('body').textContent, 'unchanged official bulletin body');
    const settled = f.api.getState(); await f.flush(); assert.deepEqual(f.api.getState(), settled, 'an idle observer performs no repeated writes or scans');
    f.window.dispatchEvent(new f.window.Event('pagehide')); assert.equal(f.api.getState().observing, false);
    f.document.querySelector('button').title = 'not processed after page exit'; await f.flush();
    assert.equal(f.document.querySelector('button').title, 'not processed after page exit');
  } finally { f.cleanup(); }
});
