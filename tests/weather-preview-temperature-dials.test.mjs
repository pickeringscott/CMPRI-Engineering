import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const clockSource = readFileSync(new URL('../public/previews/weather/weather-clock.js', import.meta.url), 'utf8');
const visualsSource = readFileSync(new URL('../public/previews/weather/weather-visuals.js', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../public/previews/weather/nws-live-view.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/previews/weather/weather-visuals.css', import.meta.url), 'utf8');
const HOUR = 3600000;
const NOW = Date.parse('2026-11-20T18:00:00Z');

function fixture({ chief = true } = {}) {
  const dom = new JSDOM('<!doctype html><section id="currentConditionsSection"><span id="liveTemperature"></span><p id="liveObservationTime"></p></section><div id="hourlyForecast"></div><div id="extendedForecast"></div><div id="liveSnow"></div><div id="liveIce"></div>', {
    url: 'https://cmpri.example/previews/cmpri-weather-preview.html' + (chief ? '?clock=24' : ''), runScripts: 'outside-only',
  });
  const { window } = dom;
  let now = NOW;
  const OriginalDate = window.Date;
  window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  window.eval(clockSource);
  window.eval(visualsSource);
  return { window, setNow(value) { now = value; }, visuals: window.cmpriWeatherVisuals, close() { window.nwsLiveView?.close(); window.close(); } };
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
      assert.equal(visual.querySelector('.wv-temperature-value').textContent, `${value}°`);
      assert.equal(visual.dataset.temperatureColor, f.visuals.colorAt(value));
    }
    assert.equal(f.visuals.colorAt(-13), '#00e7e5');
    assert.equal(f.visuals.colorAt(0), '#00e7e5');
    assert.equal(f.visuals.colorAt(32), '#e000ee');
    assert.equal(f.visuals.colorAt(80), '#ffcc00');
    assert.equal(f.visuals.colorAt(106), '#e92b95');
    assert.equal(f.visuals.colorAt(null), null);
    assert.equal(f.visuals.temperature(null).querySelector('.wv-temperature-marker'), null);
    assert.match(styles, /\.wv-temperature-value\{[^}]*color:var\(--wv-temperature-color/);
    assert.equal(f.visuals.temperature(50).querySelector('.wv-temperature-scale'), null, 'separate temperature key removed');
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
      assert.equal(segment.dataset.temperatureColor, f.visuals.colorAt(Number(segment.dataset.airTemperature)));
      assert.match(segment.getAttribute('stroke'), /^url\(#wv-dial-/);
      assert.equal(dial.querySelector(segment.getAttribute('stroke').slice(4, -1)).querySelectorAll('stop').length, 9, 'smooth ramp uses local temperature colors');
    }
    assert.deepEqual(Array.from(dial.querySelectorAll('.wv-dial-marker text'), (label) => label.textContent), ['H', 'L']);
    const current = f.visuals.temperatureDial(day, { current: true, observedTemperature: -5 });
    assert.deepEqual(Array.from(current.querySelectorAll('.wv-dial-marker[data-kind="forecast"] text'), (label) => label.textContent), ['FH', 'FL'], 'Current retains forecast/observed distinctions');
    assert.match(current.querySelector('.wv-dial-extreme-value').textContent, /^F H /);
    const fill = (wheel) => Array.from(wheel.querySelectorAll('.wv-dial-segment'), (arc) => ({
      path: arc.getAttribute('d'), temperature: arc.dataset.airTemperature,
      colors: Array.from(wheel.querySelector(arc.getAttribute('stroke').slice(4, -1)).querySelectorAll('stop'), (stop) => [stop.getAttribute('offset'), stop.getAttribute('stop-color')]),
    }));
    assert.deepEqual(fill(dial), fill(current), 'Extended label simplification preserves today’s supplied forecast ring fill');
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
    assert.match(partial.title, /gray gaps are unknown/);
    assert.equal(partial.querySelector('.wv-dial-coverage, .wv-dial-caption, .wv-dial-limit'), null);
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
    assert.match(dial.title, /25-hour Central day/);
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
    assert.equal(current.querySelector('.wv-temperature-value').textContent, '-10°');
    assert.equal(current.querySelectorAll('.wv-dial-segment').length, 0);
    assert.match(current.querySelector('.wv-temperature-dial').title, /Hourly forecast loading/);
    assert.match(f.window.document.getElementById('liveObservationTime').textContent, /2026-11-20 11:53 CST/);
    assert.equal(f.window.document.getElementById('liveFeelsLike').textContent, 'Feels Like -21°');
    resolveForecast({ ok: true, json: async () => ({ resources: { forecast, hourly: { status: 'live', data: { properties: { periods: rawHours } } },
      grid: { status: 'live', data: { properties: { windGust: { uom: 'wmoUnit:mi_h-1', values: [{ validTime: '2026-11-20T18:00:00Z/PT3H', value: 20 }] } } } } } }) });
    await opened;
    assert.equal(current.querySelector('.wv-temperature-value').textContent, '-10°', 'forecast never replaces the observed center');
    assert.equal(current.querySelectorAll('.wv-dial-segment').length, 3);
    const hourly = f.window.document.querySelector('#hourlyForecast .forecast-card');
    assert.equal(hourly.className, 'forecast-card hourly-forecast-card');
    assert.ok(hourly.querySelector('.hourly-condition-main>.wv-condition'));
    assert.equal(hourly.querySelector('.wv-temperature-scale'), null);
    assert.equal(hourly.querySelector('.wv-wind-gust').textContent, 'Gusts 20 mph');
    assert.equal(hourly.querySelector('.wv-wind-gust').getAttribute('aria-label'), 'Forecast gusts 20 mph', 'compact visible copy preserves forecast semantics');
    assert.equal(hourly.querySelector('.forecast-validity'), null, 'hourly time is shown once at the top');
    assert.ok(hourly.querySelector('.forecast-card-heading'));
    assert.ok(hourly.querySelector('.wv-temperature'));
    assert.equal(hourly.querySelector('.wv-temperature').dataset.temperatureColor, f.visuals.colorAt(0));
    assert.equal(hourly.querySelector('.wv-temperature-dial'), null, 'hourly layout stays as cards');
    const daily = f.window.document.querySelector('#extendedForecast [data-day="2026-11-22"]');
    assert.equal(daily.querySelector('.wv-temperature-dial').dataset.coverage, 'unavailable');
    assert.match(daily.querySelector('.wv-dial-face').textContent, /H 30°/);
    assert.equal(daily.querySelector('.wv-official-day-values'), null);
    assert.equal(daily.querySelectorAll('.wv-dial-marker').length, 0);
    assert.equal(f.window.document.querySelector('#nwsHourlySource, #nwsExtendedSource, #nwsAccumulationSource, #liveFeedStatus'), null);
    assert.deepEqual(reads.sort(), ['alerts', 'forecast', 'history', 'observation']);
    assert.equal(f.window.nwsLiveView.getState().databaseCalls, 0);
  } finally { f.close(); }
});

test('clock preference uses Chief24-hour time and defaults to12-hour AM/PM in Central time', () => {
  const chief = fixture(), staff = fixture({ chief: false });
  try {
    const instant = '2026-11-20T18:53:00Z';
    assert.equal(chief.window.cmpriWeatherClock.time(instant), '12:53 CST');
    assert.equal(staff.window.cmpriWeatherClock.time(instant), '12:53 PM CST');
    assert.equal(chief.window.cmpriWeatherClock.stamp('2026-07-01T05:00:00Z'), '2026-07-01 00:00 CDT');
    assert.equal(staff.window.cmpriWeatherClock.stamp('2026-07-01T05:00:00Z'), '2026-07-01 12:00 AM CDT');
    const [day] = staff.visuals.forecastDays(hours('2026-11-20T00:00:00-06:00', [30, 35]));
    assert.deepEqual(Array.from(staff.visuals.temperatureDial(day).querySelectorAll('.wv-dial-clock'), (label) => label.textContent), ['12 AM', '6 AM', '12 PM', '6 PM', '12 AM']);
    assert.equal(staff.window.cmpriWeatherClock.time('2026-11-01T06:00:00Z'), '1:00 AM CDT');
    assert.equal(staff.window.cmpriWeatherClock.time('2026-11-01T07:00:00Z'), '1:00 AM CST');
  } finally { chief.close(); staff.close(); }
});

test('observed colors reach midnight only through a real bounded anchor; gaps/nulls remain unknown and extrema exclude yesterday', () => {
  const f = fixture();
  try {
    const samples = [
      { timestamp: '2026-11-19T23:53:00-06:00', fahrenheit: 70 },
      { timestamp: '2026-11-20T00:53:00-06:00', fahrenheit: 40 },
      { timestamp: '2026-11-20T01:53:00-06:00', fahrenheit: 45 },
      { timestamp: '2026-11-20T02:20:00-06:00', fahrenheit: null },
      { timestamp: '2026-11-20T02:53:00-06:00', fahrenheit: 42 },
      { timestamp: '2026-11-20T05:53:00-06:00', fahrenheit: 30 },
    ];
    const day = f.visuals.observationDay(samples, NOW);
    assert.equal(day.segments[0].start, Date.parse('2026-11-20T00:00:00-06:00'));
    assert.equal(day.segments[0].sampleStart, Date.parse(samples[0].timestamp));
    assert.equal(day.segments[0].fahrenheit, 66.5, 'boundary color is interpolated, not a synthetic report');
    assert.equal(day.high.fahrenheit, 45, 'yesterday70° is not included in today’s extrema');
    assert.equal(day.low.fahrenheit, 30);
    assert.equal(day.reports.some((report) => report.sampleTime === day.start), false, 'no invented midnight reading');
    assert.equal(day.segments.some((segment) => segment.sampleStart === Date.parse(samples[2].timestamp)), false, 'null report prevents interpolation across missing data');
    assert.equal(day.segments.some((segment) => segment.sampleEnd === Date.parse(samples[5].timestamp)), false, 'three-hour gap stays unknown');
    const dial = f.visuals.temperatureDial(null, { current: true, observedDay: day, observedTemperature: 30 });
    assert.ok(dial.querySelector('.wv-dial-observed-segment'));
    assert.match(dial.querySelector('.wv-dial-observed-segment title').textContent, /interpolated between actual KCMI reports/);
    assert.equal(dial.querySelectorAll('.wv-dial-report').length, 4);
    assert.equal(dial.querySelector('.wv-dial-coverage, .wv-dial-caption, .wv-dial-limit'), null);
    assert.equal(dial.querySelectorAll(':scope>.wv-dial-extrema').length, 0, 'extrema stay inside the face');
  } finally { f.close(); }
});

test('day-to-date observed extrema keep their original times until a new extreme is observed', () => {
  const f = fixture();
  try {
    const first = f.visuals.observationDay([
      { timestamp: '2026-11-20T01:53:00-06:00', fahrenheit: 30 },
      { timestamp: '2026-11-20T02:53:00-06:00', fahrenheit: 40 },
    ], NOW);
    const unchanged = f.visuals.observationDay([
      { timestamp: '2026-11-20T10:53:00-06:00', fahrenheit: 40 },
      { timestamp: '2026-11-20T11:53:00-06:00', fahrenheit: 35 },
    ], NOW, first);
    assert.equal(unchanged.high.sampleTime, first.high.sampleTime);
    assert.equal(unchanged.low.sampleTime, first.low.sampleTime);
    const extreme = f.visuals.observationDay([{ timestamp: '2026-11-20T11:59:00-06:00', fahrenheit: 45 }], NOW, unchanged);
    assert.equal(extreme.high.fahrenheit, 45);
    assert.equal(extreme.high.sampleTime, Date.parse('2026-11-20T11:59:00-06:00'));
    assert.equal(extreme.low.sampleTime, first.low.sampleTime);
    const tomorrow = f.visuals.observationDay([{ timestamp: '2026-11-21T00:01:00-06:00', fahrenheit: 36 }], Date.parse('2026-11-21T00:02:00-06:00'), extreme);
    assert.equal(tomorrow.high.fahrenheit, 36);
    assert.equal(tomorrow.low.fahrenheit, 36);
  } finally { f.close(); }
});

test('historical backfill resolves an earlier tied extreme after latest arrives, while later equal reports keep the mark stable', () => {
  const f = fixture();
  try {
    const latest = { timestamp: '2026-11-20T11:53:00-06:00', fahrenheit: 45 };
    const initial = f.visuals.observationDay([latest], NOW);
    assert.equal(initial.high.sampleTime, Date.parse(latest.timestamp));
    const backfill = f.visuals.observationDay([
      { timestamp: '2026-11-20T05:20:00-06:00', fahrenheit: 30 },
      { timestamp: '2026-11-20T05:55:00-06:00', fahrenheit: 30 },
      { timestamp: '2026-11-20T07:35:00-06:00', fahrenheit: 45 }, latest,
    ], NOW, initial);
    assert.equal(backfill.high.sampleTime, Date.parse('2026-11-20T07:35:00-06:00'));
    assert.equal(backfill.low.sampleTime, Date.parse('2026-11-20T05:20:00-06:00'));
    const later = f.visuals.observationDay([{ timestamp: '2026-11-20T12:05:00-06:00', fahrenheit: 45 }], NOW + 6 * 60000, backfill);
    assert.equal(later.high.sampleTime, backfill.high.sampleTime);
    assert.equal(later.low.sampleTime, backfill.low.sampleTime);
  } finally { f.close(); }
});

test('in-memory reopen reuses data, stale foreground refresh retains the wheel, and observed changes never move forecast marks', async () => {
  const f = fixture();
  try {
    const observation = (temperature, timestamp) => ({ type: 'Feature', properties: { timestamp, temperature: { value: temperature, unitCode: 'wmoUnit:degF' },
      windSpeed: { value: 12, unitCode: 'wmoUnit:mi_h-1' }, windGust: { value: 21, unitCode: 'wmoUnit:mi_h-1' }, windDirection: { value: 270 },
      visibility: { value: 16093.44, unitCode: 'wmoUnit:m' }, textDescription: 'Clear' } });
    let latest = observation(35, '2026-11-20T17:53:00Z');
    const resource = (data) => ({ status: 'live', sourceTimestamp: '2026-11-20T17:53:00Z', data });
    const rawHours = hours('2026-11-20T12:00:00-06:00', [50, 30, 45]).map(({ fahrenheit, ...period }) => ({ ...period, temperature: fahrenheit, temperatureUnit: 'F', shortForecast: 'Sunny' }));
    const history = resource({ type: 'FeatureCollection', features: [observation(30, '2026-11-20T06:53:00Z'), observation(40, '2026-11-20T07:53:00Z')] });
    const resourcesFor = (part) => part === 'observation' ? { observation: resource(latest) } : part === 'history' ? { history } : part === 'alerts' ? { alerts: resource({ features: [] }) } : {
      hourly: resource({ properties: { periods: rawHours } }), forecast: resource({ properties: { periods: [] } }), grid: resource({ properties: {} }), points: resource({ properties: {} }),
    };
    let hold = false, reject = false;
    const delayed = [], reads = [];
    f.window.fetch = async (input) => {
      const part = new URL(input, f.window.location.href).searchParams.get('part'); reads.push(part);
      if (reject) throw new Error('TEST connection unavailable');
      if (hold) await new Promise((resolve) => delayed.push(resolve));
      return { ok: true, json: async () => ({ resources: resourcesFor(part) }) };
    };
    f.window.eval(viewSource);
    const api = f.window.nwsLiveView; await api.open();
    assert.equal(reads.length, 4);
    const host = f.window.document.getElementById('liveTemperature');
    const forecastMarks = () => Array.from(host.querySelectorAll('.wv-dial-marker[data-kind="forecast"]'), (mark) => [mark.dataset.extreme, mark.dataset.sampleTime, mark.dataset.airTemperature]);
    const before = forecastMarks();
    assert.equal(host.querySelector('#liveVisibility').textContent, '10 mi visibility');
    assert.equal(host.querySelector('#liveGusts').textContent, 'G 21 MPH');
    assert.equal(host.querySelector('#liveWind .wv-wind-value').textContent, 'W · 12 MPH');
    assert.ok(host.querySelector('.wv-dial-face #liveConditionIcon'));
    assert.match(f.window.document.getElementById('liveObservationTime').textContent, /Willard \(KCMI\)/);
    const highTime = api.getState().observedExtremes.high.sampleTime;
    api.close(); await api.open();
    assert.equal(reads.length, 4, 'fresh cached reopen makes no NWS request');
    assert.equal(api.getState().observedExtremes.high.sampleTime, highTime);
    api.close(); f.setNow(NOW + 6 * 60000); hold = true;
    const reopening = api.open();
    assert.equal(host.querySelector('.wv-temperature-value').textContent, '35°', 'cached observation renders immediately during refresh');
    assert.equal(reads.length, 8);
    latest = observation(38, '2026-11-20T18:05:00Z');
    hold = false; delayed.splice(0).forEach((resolve) => resolve()); await reopening;
    assert.equal(api.getState().observedExtremes.high.sampleTime, highTime, 'new non-extreme report does not move high');
    assert.deepEqual(forecastMarks(), before, 'new observations never move forecast extrema');
    latest = observation(45, '2026-11-20T18:06:00Z'); await api.refresh();
    assert.equal(api.getState().observedExtremes.high.fahrenheit, 45);
    assert.deepEqual(forecastMarks(), before);
    reject = true; await api.refresh();
    assert.equal(host.querySelector('.wv-temperature-value').textContent, '45°', 'failed foreground refresh retains memory cache');
    assert.equal(api.getState().resources.observation, 'stale');
    const count = reads.length; api.close(); await api.refresh(); assert.equal(reads.length, count, 'closed view cannot fetch');
    assert.equal(api.getState().databaseCalls, 0);
    assert.equal(api.getState().scheduler, false);
  } finally { f.close(); }
});

test('existing foreground refresh rereads only due observations/history and skips fresh, pending, hidden and closed views', async () => {
  const f = fixture();
  try {
    let hidden = false;
    Object.defineProperty(f.window.document, 'hidden', { get: () => hidden });
    const observation = { status: 'live', data: { properties: { timestamp: '2026-11-20T17:53:00Z', temperature: { value: 35, unitCode: 'wmoUnit:degF' } } } };
    const reads = [], delayed = [];
    let hold = false;
    f.window.fetch = async (input) => {
      const part = new URL(input, f.window.location.href).searchParams.get('part'); reads.push(part);
      if (hold) await new Promise((resolve) => delayed.push(resolve));
      const resources = part === 'observation' ? { observation } : part === 'history' ? { history: { status: 'live', data: { features: [] } } } : part === 'alerts' ? { alerts: { status: 'live', data: { features: [] } } } : {
        hourly: { status: 'live', data: { properties: { periods: [] } } }, forecast: { status: 'live', data: { properties: { periods: [] } } }, grid: { status: 'live', data: { properties: {} } }, points: { status: 'live', data: { properties: {} } },
      };
      return { ok: true, json: async () => ({ resources }) };
    };
    f.window.eval(viewSource);
    const api = f.window.nwsLiveView;
    await api.refreshObservations(); assert.equal(reads.length, 0);
    await api.open(); await api.refreshObservations(); assert.equal(reads.length, 4);
    f.setNow(NOW + 6 * 60000); hidden = true;
    await api.refreshObservations(); assert.equal(reads.length, 4);
    hidden = false; hold = true;
    const refreshing = api.refreshObservations();
    await api.refreshObservations();
    assert.deepEqual(reads.slice(4).sort(), ['history', 'observation'], 'no duplicate, alert or forecast reads');
    hold = false; delayed.splice(0).forEach((resolve) => resolve()); await refreshing;
    api.close(); f.setNow(NOW + 12 * 60000);
    await api.refreshObservations(); assert.equal(reads.length, 6);
  } finally { f.close(); }
});

test('a failed alert check with a cached empty result visibly reports unknown status without an all-clear', async () => {
  const f = fixture();
  try {
    const doc = f.window.document;
    const section = doc.createElement('section'); section.id = 'officialAlertsSection';
    const alerts = doc.createElement('div'); alerts.id = 'liveAlertsHost'; section.append(alerts);
    const availability = doc.createElement('p'); availability.id = 'liveAlertAvailability';
    doc.body.append(section, availability);
    let fail = false;
    f.window.fetch = async (input) => {
      const part = new URL(input, f.window.location.href).searchParams.get('part');
      if (part === 'alerts' && fail) throw new Error('TEST NWS alert check failed');
      return { ok: true, json: async () => ({ resources: part === 'alerts' ? { alerts: { status: 'live', data: { type: 'FeatureCollection', features: [] } } } : {} }) };
    };
    f.window.eval(viewSource);
    await f.window.nwsLiveView.open();
    assert.equal(section.hidden, true);
    assert.equal(availability.hidden, true);
    fail = true; await f.window.nwsLiveView.refresh();
    assert.equal(f.window.nwsLiveView.getState().resources.alerts, 'stale');
    assert.equal(section.hidden, true, 'empty official alert section stays hidden');
    assert.equal(availability.hidden, false, 'unknown status is independently visible');
    assert.match(availability.textContent, /Cached alert data is stale/);
    assert.match(availability.textContent, /No all-clear is implied/);
  } finally { f.close(); }
});
