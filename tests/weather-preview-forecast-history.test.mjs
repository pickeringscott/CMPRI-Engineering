import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = name => readFileSync(new URL('../public/previews/weather/' + name, import.meta.url), 'utf8');
const viewSource = source('nws-live-view.js');
const HOUR = 3600000;
const DAY = Date.parse('2026-11-20T00:00:00-06:00');
const NOW = Date.parse('2026-11-20T12:00:00-06:00');
const iso = time => new Date(time).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const hourly = (hour, temperature, chance, start = DAY) => ({
  startTime: iso(start + hour * HOUR), endTime: iso(start + (hour + 1) * HOUR),
  temperature, temperatureUnit: 'F', probabilityOfPrecipitation: { value: chance },
  shortForecast: 'Partly Cloudy', windSpeed: '5 mph', windDirection: 'W', isDaytime: true,
});
const gridSeries = (uom, values) => ({ uom, values });
const valid = (hour, value, duration = 'PT1H', start = DAY) => ({ validTime: iso(start + hour * HOUR) + '/' + duration, value });

function fixture(initialNow = NOW) {
  const dom = new JSDOM('<!doctype html><section id="currentConditionsSection"><span id="liveTemperature"></span></section>'
    + '<div id="currentConditionsGraphs"></div><div id="hourlyForecast"><div id="hourlyForecastCards" style="column-gap:12px"></div>'
    + '<div id="hourlyForecastGraphs"></div></div><div id="extendedForecast"></div>', {
    url: 'https://preview.example/previews/cmpri-weather-preview.html?clock=24', runScripts: 'outside-only',
  });
  const { window } = dom;
  let now = initialNow;
  const OriginalDate = window.Date;
  window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const forbidden = [];
  const reject = name => () => { forbidden.push(name); throw new Error('Forecast rendering must not call ' + name); };
  window.fetch = reject('network');
  window.setInterval = reject('background scheduler');
  window.Notification = { requestPermission: reject('notification permission') };
  window.supabase = { from: reject('database'), rpc: reject('database') };
  const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('hourly-forecast-card')
      ? { width: 132, height: 180, x: 0, y: 0, top: 0, left: 0, right: 132, bottom: 180 }
      : originalBounds.call(this);
  };
  for (const name of ['weather-clock.js', 'weather-visuals.js', 'weather-graphs.js']) window.eval(source(name));
  const seam = '  window.nwsLiveView = {';
  assert.equal(viewSource.split(seam).length, 2, 'one integration export provides the bounded test seam');
  window.eval(viewSource.replace(seam, `  window.forecastHistoryProbe = {
    set(name, envelope) { resources[name] = envelope; },
    timeline: forecastTimelinePeriods,
    days: forecastDayModels,
    raw: providedHourlyPeriods,
    current: renderCurrentDial,
    cards() { renderForecast('hourly', 'hourlyForecastCards', true); },
    daily: renderDailyForecast
  };
${seam}`));
  const probe = window.forecastHistoryProbe;
  const envelope = (data, extra = {}) => ({ status: 'live', sourceTimestamp: iso(now), data, ...extra });
  return {
    window, setNow(value) { now = value; },
    setHours(periods, extra) { probe.set('hourly', envelope({ properties: { periods } }, extra)); },
    setGrid(properties, extra) { probe.set('grid', envelope({ properties }, extra)); },
    set(name, data, extra) { probe.set(name, envelope(data, extra)); },
    timeline: () => plain(probe.timeline()), days: () => plain(probe.days()),
    current: () => probe.current(), cards: () => probe.cards(), daily: () => probe.daily(),
    raw: () => plain(probe.raw()), state: () => plain(window.nwsLiveView.getState()),
    close() {
      window.nwsLiveView.close();
      assert.equal(window.nwsLiveView.getState().requests, 0);
      assert.equal(window.nwsLiveView.getState().databaseCalls, 0);
      assert.equal(window.nwsLiveView.getState().pushes, 0);
      assert.equal(window.nwsLiveView.getState().scheduler, false);
      assert.deepEqual(forbidden, []);
      window.close();
    },
  };
}
const at = (periods, hour, start = DAY) => periods.find(period => Date.parse(period.startTime) <= start + hour * HOUR && Date.parse(period.endTime) > start + hour * HOUR);


test('Current forecast ring clips actual grid intervals at Central midnight and never substitutes KCMI observations', () => {
  const f = fixture();
  try {
    f.setHours([]);
    f.setGrid({
      temperature: gridSeries('wmoUnit:degC', [valid(-.5, -5, 'PT2H'), valid(2, 0), valid(3, null)]),
      probabilityOfPrecipitation: gridSeries('wmoUnit:percent', [valid(0, 0), valid(1, null), valid(2, 100), valid(3, null)]),
    });
    const reports = [
      { properties: { timestamp: iso(DAY + .9 * HOUR), temperature: { value: 70, unitCode: 'wmoUnit:degF' } } },
      { properties: { timestamp: iso(DAY + 11 * HOUR), temperature: { value: 80, unitCode: 'wmoUnit:degF' } } },
    ];
    f.set('history', { features: reports });
    f.set('observation', { properties: { timestamp: iso(NOW - 7 * 60000), temperature: { value: 99, unitCode: 'wmoUnit:degF' }, textDescription: 'Clear' } });
    const periods = f.timeline();
    assert.deepEqual(periods.map(period => [period.startTime, period.endTime, period.fahrenheit, period.probabilityOfPrecipitation.value]), [
      [iso(DAY), iso(DAY + HOUR), 23, 0],
      [iso(DAY + HOUR), iso(DAY + 1.5 * HOUR), 23, null],
      [iso(DAY + 2 * HOUR), iso(DAY + 3 * HOUR), 32, 100],
    ]);
    assert.ok(periods.every(period => /grid valid interval/.test(period.forecastTemperatureSource)));
    assert.equal(at(periods, 1.75), undefined, 'unprovided forecast time stays a gap');
    assert.equal(at(periods, 3), undefined, 'a null forecast is not replaced by a station reading');
    f.current();
    const dial = f.window.document.querySelector('#liveTemperature .wv-temperature-dial');
    assert.equal(dial.querySelector('.wv-temperature-value').textContent, '99°', 'center retains actual observation');
    assert.deepEqual(Array.from(dial.querySelectorAll('.wv-dial-segment'), segment => [segment.dataset.startTime, Number(segment.dataset.airTemperature)]), [
      [iso(DAY), 23], [iso(DAY + HOUR), 23], [iso(DAY + 2 * HOUR), 32],
    ]);
    assert.equal(f.state().observedReports, 3, 'forecast intervals do not manufacture observation reports');
    assert.equal(reports.length, 2);
    const graph = f.window.document.querySelector('#currentConditionsGraphs .wg-hourly-graph');
    assert.equal(graph.dataset.start, iso(DAY));
    assert.equal(graph.dataset.end, iso(DAY + 24 * HOUR));
    assert.match(graph.getAttribute('aria-label'), /published NWS forecast/);
    assert.equal(graph.querySelector('.wg-precipitation-point').dataset.value, '0');
  } finally { f.close(); }
});

test('each missing hourly metric independently falls back to valid grid guidance while finite hourly zero retains priority', () => {
  const f = fixture();
  try {
    f.setHours([hourly(0, 45, null), hourly(1, null, 0), hourly(2, null, 101), hourly(3, null, null)]);
    f.setGrid({ temperature: gridSeries('wmoUnit:degC', [valid(0, 20), valid(1, 0), valid(2, null), valid(3, null)]),
      probabilityOfPrecipitation: gridSeries('wmoUnit:percent', [valid(0, 0), valid(1, 70), valid(2, 25), valid(3, null)]) });
    const periods = f.timeline();
    assert.equal(at(periods, 0).fahrenheit, 45);
    assert.equal(at(periods, 0).probabilityOfPrecipitation.value, 0);
    assert.match(at(periods, 0).forecastTemperatureSource, /hourly/);
    assert.match(at(periods, 0).forecastPrecipitationSource, /grid/);
    assert.equal(at(periods, 1).fahrenheit, 32);
    assert.equal(at(periods, 1).probabilityOfPrecipitation.value, 0, 'valid zero must not be replaced by grid70%');
    assert.match(at(periods, 1).forecastTemperatureSource, /grid/);
    assert.match(at(periods, 1).forecastPrecipitationSource, /hourly/);
    assert.equal(at(periods, 2).fahrenheit, null);
    assert.equal(at(periods, 2).probabilityOfPrecipitation.value, 25, 'invalid101% is not considered published guidance');
    assert.equal(at(periods, 3), undefined, 'both metrics missing remains unknown');
  } finally { f.close(); }
});

test('grid precipitation preserves0% but null, out-of-range, and unknown-unit values stay unknown', () => {
  const f = fixture();
  try {
    f.setHours([]);
    f.setGrid({ temperature: gridSeries('wmoUnit:degF', [valid(0, 32, 'PT4H')]),
      probabilityOfPrecipitation: gridSeries('wmoUnit:percent', [valid(0, 0), valid(1, null), valid(2, -1), valid(3, 101)]) });
    assert.deepEqual(f.timeline().map(period => period.probabilityOfPrecipitation.value), [0, null, null, null]);
    f.setGrid({ temperature: gridSeries('wmoUnit:degF', [valid(0, 32)]),
      probabilityOfPrecipitation: gridSeries('wmoUnit:unrecognized', [valid(0, 0)]) });
    assert.equal(at(f.timeline(), 0).probabilityOfPrecipitation.value, null);
  } finally { f.close(); }
});

test('advancing raw hourly forecasts retains earlier published guidance only for Current, leaving Extended and hourly cards raw', () => {
  const f = fixture();
  try {
    f.setHours([hourly(0, 10, 0), hourly(1, 20, 10), hourly(2, 30, 20)]);
    f.setGrid({});
    assert.equal(f.timeline().length, 3);
    const advanced = [hourly(2, 35, 25), hourly(3, 40, 30)];
    f.setHours(advanced);
    const periods = f.timeline();
    assert.deepEqual(periods.map(period => period.fahrenheit), [10, 20, 35, 40]);
    assert.equal(f.state().cachedForecastHours, 4);
    assert.match(at(periods, 0).forecastTemperatureSource, /hourly forecast retained in memory/);
    assert.deepEqual(f.raw().map(period => period.startTime), advanced.map(period => period.startTime));
    const [extended] = f.days();
    assert.deepEqual(extended.hourly.map(period => period.sampleTime), [DAY + 2 * HOUR, DAY + 3 * HOUR]);
    assert.equal(extended.coverageHours, 2);
    f.current(); f.daily(); f.cards();
    const document = f.window.document;
    assert.equal(document.querySelectorAll('#liveTemperature .wv-dial-segment').length, 4);
    assert.equal(document.querySelectorAll('#extendedForecast .wv-dial-segment').length, 2, 'daily ring does not inherit retained/grid backfill');
    assert.equal(document.querySelectorAll('#hourlyForecastCards .hourly-forecast-card').length, 2);
    for (const selector of ['#hourlyForecastGraphs', '#extendedForecast .daily-forecast-graphs']) {
      assert.deepEqual(Array.from(document.querySelectorAll(selector + ' .wg-temperature-point'), point => point.dataset.time), advanced.map(period => period.startTime));
    }
  } finally { f.close(); }
});

test('RAM history prunes at Central midnight rather than UTC and does not fabricate the new day', () => {
  const f = fixture(Date.parse('2026-11-20T23:30:00Z'));
  try {
    f.setHours([hourly(0, 10, 0), hourly(23, 20, 30), hourly(24, 35, 40)]);
    f.setGrid({});
    f.timeline();
    assert.equal(f.state().cachedForecastHours, 3);
    f.setHours([]);
    f.setNow(Date.parse('2026-11-21T00:05:00Z'));
    assert.equal(f.timeline().length, 2, 'UTC date change is still the same Central day');
    assert.equal(f.state().cachedForecastHours, 3, 'valid next-day guidance can be retained before midnight');
    f.setNow(Date.parse('2026-11-21T00:05:00-06:00'));
    const tomorrow = f.timeline();
    assert.equal(f.state().cachedForecastHours, 1, 'previous-day intervals are cleared while a real future publication remains valid');
    assert.deepEqual(tomorrow.map(period => [period.startTime, period.fahrenheit]), [[iso(DAY + 24 * HOUR), 35]]);
    assert.equal(f.days().length, 0, 'Extended still has no raw hourly data after its source window clears');
    f.setNow(Date.parse('2026-11-22T00:05:00-06:00'));
    assert.deepEqual(f.timeline(), []);
    assert.equal(f.state().cachedForecastHours, 0);
  } finally { f.close(); }
});

test('hourly graph points share raw card slots and timestamps without pulling retained earlier hours into the strip', () => {
  const f = fixture();
  try {
    f.setHours([hourly(0, -10, 10)]); f.setGrid({}); f.timeline();
    const raw = [hourly(4, 10, 0), hourly(5, null, null), hourly(7, 30, 20)];
    f.setHours(raw); f.timeline(); f.cards();
    const document = f.window.document;
    const cards = document.querySelectorAll('#hourlyForecastCards .hourly-forecast-card');
    assert.equal(cards.length, 3);
    const graph = document.querySelector('#hourlyForecastGraphs .wg-hourly-graph');
    assert.equal(graph.style.width, '420px', '132px cards plus two12px gaps');
    assert.deepEqual(Array.from(graph.querySelectorAll('.wg-temperature-point'), point => [point.dataset.time, Number(point.getAttribute('cx'))]), [
      [raw[0].startTime, 66], [raw[2].startTime, 354],
    ]);
    assert.deepEqual(Array.from(graph.querySelectorAll('.wg-time'), label => label.textContent), ['04:00', '05:00', '07:00']);
    assert.match(cards[0].querySelector('h3').textContent, /04:00/);
    assert.match(cards[1].querySelector('h3').textContent, /05:00/);
    assert.match(cards[2].querySelector('h3').textContent, /07:00/);
    assert.equal(graph.querySelectorAll('.wg-temperature').length, 2, 'unknown and missing actual hours remain broken series');
  } finally { f.close(); }
});
