import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const visualsSource = readFileSync(new URL('../public/previews/weather/weather-visuals.js', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../public/previews/weather/nws-live-view.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/previews/weather/weather-visuals.css', import.meta.url), 'utf8');
const HOUR = 3600000;
const NOW = Date.parse('2026-11-20T18:00:00Z');

function fixture() {
  const dom = new JSDOM('<!doctype html><section id="currentConditionsSection"><span id="liveTemperature"></span><span id="liveConditionIcon"></span><p id="liveObservationTime"></p><span id="liveConditionText"></span><span id="liveFeelsLike"></span><span id="liveGusts"></span></section><div id="hourlyForecast"></div><div id="extendedForecast"></div><div id="liveSnow"></div><div id="liveIce"></div>', {
    url: 'https://cmpri.example/previews/cmpri-weather-preview.html', runScripts: 'outside-only',
  });
  const { window } = dom;
  const OriginalDate = window.Date;
  window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  };
  window.eval(visualsSource);
  return { window, visuals: window.cmpriWeatherVisuals, close() { window.nwsLiveView?.close(); window.close(); } };
}
function hours(start, temperatures) {
  return temperatures.map((fahrenheit, index) => ({
    startTime: new Date(Date.parse(start) + index * HOUR).toISOString(),
    endTime: new Date(Date.parse(start) + (index + 1) * HOUR).toISOString(), fahrenheit,
  }));
}
function contrast(foreground, background) {
  const luminance = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('reference colors stay fixed, preserve zero and negative values, and retain readable numeric text', () => {
  const f = fixture();
  try {
    const values = [-25, -13, 0, 15, 25, 32, 34, 40, 45, 55, 63, 80, 85, 106, 130];
    for (const value of values) {
      const visual = f.visuals.temperature(value);
      assert.equal(visual.dataset.airTemperature, String(value));
      assert.equal(visual.querySelector('.wv-temperature-value').textContent, `${value}°F`);
      assert.equal(visual.dataset.temperatureColor, f.visuals.colorAt(value));
    }
    assert.equal(f.visuals.colorAt(-13), '#00e7e5');
    assert.equal(f.visuals.colorAt(0), '#00e7e5');
    assert.equal(f.visuals.colorAt(32), '#e000ee');
    assert.equal(f.visuals.colorAt(80), '#ffcc00');
    assert.equal(f.visuals.colorAt(106), '#e92b95');
    assert.equal(f.visuals.colorAt(null), null);
    assert.equal(f.visuals.temperature(null).querySelector('.wv-temperature-marker'), null);
    assert.match(styles, /\.wv-temperature-value\{[^}]*color:#f8f5ee/);
    assert.match(styles, /\.wv-dial-marker text\{[^}]*fill:#ffffff;stroke:#000000/);
    assert.ok(contrast('#f8f5ee', '#11110f') > 7, 'numeric temperatures retain high contrast regardless of ramp color');
    assert.ok(contrast('#dededb', '#11110f') > 7, '24-hour labels retain high contrast');
    assert.doesNotMatch(visualsSource, /site-palette|--gold|--orange|--accent/);
  } finally { f.close(); }
});

test('a complete Central day maps times around the dial and uses only actual supplied extrema times', () => {
  const f = fixture();
  try {
    const temperatures = Array.from({ length: 24 }, (_, hour) => hour === 7 ? -10 : hour === 16 ? 0 : -5);
    const [day] = f.visuals.forecastDays(hours('2026-11-20T00:00:00-06:00', temperatures));
    assert.equal(day.key, '2026-11-20');
    assert.equal(day.coverageHours, 24);
    assert.equal(day.partial, false);
    assert.equal(day.high.sampleTime, Date.parse('2026-11-20T16:00:00-06:00'));
    assert.equal(day.low.sampleTime, Date.parse('2026-11-20T07:00:00-06:00'));
    const dial = f.visuals.temperatureDial(day);
    assert.deepEqual(Array.from(dial.querySelectorAll('.wv-dial-clock'), (el) => el.textContent), ['00', '06', '12', '18', '24']);
    assert.equal(dial.querySelector('[data-extreme="H"] time').textContent, '16:00 CST');
    assert.equal(dial.querySelector('[data-extreme="L"] time').textContent, '07:00 CST');
    assert.equal(dial.querySelectorAll('.wv-dial-segment').length, 24);
    for (const segment of dial.querySelectorAll('.wv-dial-segment')) {
      assert.equal(segment.getAttribute('stroke'), f.visuals.colorAt(Number(segment.dataset.airTemperature)));
    }
  } finally { f.close(); }
});

test('missing temperatures and forecast hours stay gaps; extended-only days have no fabricated hour or extrema', () => {
  const f = fixture();
  try {
    const provided = hours('2026-11-20T00:00:00-06:00', [-5, null, 0, 10]).filter((_, index) => index !== 2);
    const extended = [{ startTime: '2026-11-21T06:00:00-06:00', endTime: '2026-11-21T18:00:00-06:00', temperature: 28 }];
    const days = f.visuals.forecastDays(provided, extended);
    assert.equal(days.length, 2);
    assert.equal(days[0].coverageHours, 2);
    assert.equal(days[0].partial, true);
    assert.deepEqual(Array.from(days[0].segments, (segment) => segment.minute), [0, 180]);
    const partial = f.visuals.temperatureDial(days[0]);
    assert.equal(partial.dataset.coverage, 'partial');
    assert.match(partial.textContent, /H\/L: supplied hours only · gaps unknown/);
    const absent = f.visuals.temperatureDial(days[1]);
    assert.equal(absent.dataset.coverage, 'unavailable');
    assert.equal(absent.querySelectorAll('.wv-dial-segment').length, 0);
    assert.equal(absent.querySelectorAll('.wv-dial-marker').length, 0);
    assert.match(absent.textContent, /Hourly timeline unavailable/);
    assert.doesNotMatch(absent.textContent, /05:00|14:00|0°F/);
  } finally { f.close(); }
});

test('Central daylight changes retain 23/25 supplied hours and distinguish the repeated hour', () => {
  const f = fixture();
  try {
    const [spring] = f.visuals.forecastDays(hours('2026-03-08T00:00:00-06:00', Array(23).fill(40)));
    assert.equal(spring.expectedHours, 23);
    assert.equal(spring.coverageHours, 23);
    assert.equal(spring.partial, false);
    assert.equal(spring.segments.some((segment) => segment.minute === 120), false);
    assert.match(spring.clockChange, /02:00 skipped/);
    const [fall] = f.visuals.forecastDays(hours('2026-11-01T00:00:00-05:00', Array(25).fill(40)));
    assert.equal(fall.expectedHours, 25);
    assert.equal(fall.coverageHours, 25);
    assert.equal(fall.partial, false);
    const repeated = fall.segments.filter((segment) => segment.minute === 60);
    assert.deepEqual(Array.from(repeated, (segment) => segment.label), ['01:00 CDT', '01:00 CST']);
    assert.deepEqual(Array.from(repeated, (segment) => segment.repeated), [false, true]);
    const dial = f.visuals.temperatureDial(fall);
    assert.equal(dial.querySelectorAll('[data-repeated-hour="true"]').length, 1);
    assert.match(dial.textContent, /25-hour Central day/);
  } finally { f.close(); }
});

test('KCMI observation renders before forecast; hourly cards share the palette and daily fallback stays honest', async () => {
  const f = fixture();
  try {
    const observation = { status: 'live', data: { properties: {
      timestamp: '2026-11-20T17:53:00Z', temperature: { value: -10, unitCode: 'wmoUnit:degF' },
      windChill: { value: -21, unitCode: 'wmoUnit:degF' }, textDescription: 'Clear',
    } } };
    const rawHours = hours('2026-11-20T12:00:00-06:00', [0, -2, 5]).map(({ fahrenheit, ...period }) => ({ ...period, temperature: fahrenheit, temperatureUnit: 'F', shortForecast: 'Clear', windSpeed: '5 mph', windDirection: 'N' }));
    const forecast = { status: 'live', data: { properties: { periods: [
      { startTime: '2026-11-20T06:00:00-06:00', endTime: '2026-11-20T18:00:00-06:00', isDaytime: true, temperature: 7, temperatureUnit: 'F', shortForecast: 'Sunny', detailedForecast: 'TEST official day forecast.' },
      { startTime: '2026-11-22T06:00:00-06:00', endTime: '2026-11-22T18:00:00-06:00', isDaytime: true, temperature: 30, temperatureUnit: 'F', shortForecast: 'Snow' },
    ] } } };
    let resolveForecast;
    const deferred = new Promise((resolve) => { resolveForecast = resolve; });
    const reads = [];
    f.window.fetch = async (input) => {
      const part = new URL(input, f.window.location.href).searchParams.get('part'); reads.push(part);
      if (part === 'forecast') return deferred;
      return { ok: true, json: async () => ({ resources: part === 'observation' ? { observation } : { alerts: { status: 'live', data: { features: [] } } } }) };
    };
    f.window.eval(viewSource);
    const opened = f.window.nwsLiveView.open();
    await new Promise((resolve) => setImmediate(resolve));
    const current = f.window.document.getElementById('liveTemperature');
    assert.equal(current.querySelector('.wv-temperature-value').textContent, '-10°F');
    assert.equal(current.querySelectorAll('.wv-dial-segment').length, 0);
    assert.match(current.textContent, /Hourly forecast loading/);
    assert.match(f.window.document.getElementById('liveObservationTime').textContent, /2026-11-20 11:53 CST/);
    assert.equal(f.window.document.getElementById('liveFeelsLike').textContent, '-21°F');
    resolveForecast({ ok: true, json: async () => ({ resources: { forecast, hourly: { status: 'live', data: { properties: { periods: rawHours } } }, grid: { status: 'unavailable' } } }) });
    await opened;
    assert.equal(current.querySelector('.wv-temperature-value').textContent, '-10°F', 'forecast never replaces the observed center');
    assert.equal(current.querySelectorAll('.wv-dial-segment').length, 3);
    const hourly = f.window.document.querySelector('#hourlyForecast .forecast-card');
    assert.equal(hourly.className, 'forecast-card', 'hourly retains its existing card class and hierarchy');
    assert.ok(hourly.querySelector('.forecast-card-heading'));
    assert.ok(hourly.querySelector('.wv-temperature'));
    assert.equal(hourly.querySelector('.wv-temperature').dataset.temperatureColor, f.visuals.colorAt(0));
    assert.equal(hourly.querySelector('.wv-temperature-dial'), null, 'hourly layout stays as cards');
    const daily = f.window.document.querySelector('#extendedForecast [data-day="2026-11-22"]');
    assert.equal(daily.querySelector('.wv-temperature-dial').dataset.coverage, 'unavailable');
    assert.match(daily.textContent, /NWS day high30°F/);
    assert.equal(daily.querySelectorAll('.wv-dial-marker').length, 0);
    assert.equal(f.window.document.querySelector('#nwsHourlySource, #nwsExtendedSource, #nwsAccumulationSource, #liveFeedStatus'), null);
    assert.deepEqual(reads.sort(), ['alerts', 'forecast', 'observation']);
    assert.equal(f.window.nwsLiveView.getState().databaseCalls, 0);
  } finally { f.close(); }
});
