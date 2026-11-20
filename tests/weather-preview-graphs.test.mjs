import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const graphSource = readFileSync(new URL('../public/previews/weather/weather-graphs.js', import.meta.url), 'utf8');
const clockSource = readFileSync(new URL('../public/previews/weather/weather-clock.js', import.meta.url), 'utf8');
const START = Date.parse('2026-11-20T06:00:00Z');
const HOUR = 3600000;
function fixture(chief = true) {
  const dom = new JSDOM('<!doctype html>', { url: 'https://cmpri.example/previews/cmpri-weather-preview.html' + (chief ? '?clock=24' : ''), runScripts: 'outside-only' });
  dom.window.fetch = () => { throw new Error('Graphs must not make requests'); };
  dom.window.eval(clockSource); dom.window.eval(graphSource);
  return { window: dom.window, graphs: dom.window.cmpriWeatherGraphs, close: () => dom.window.close() };
}
function period(index, temperature, chance) {
  return { startTime: new Date(START + index * HOUR).toISOString(), endTime: new Date(START + (index + 1) * HOUR).toISOString(), temperature, temperatureUnit: 'F', probabilityOfPrecipitation: { value: chance } };
}
function pathSegments(path) {
  const tokens = path.match(/[MCL]|-?\d+(?:\.\d+)?/g) || [];
  const readPoint = () => ({ x: Number(tokens.shift()), y: Number(tokens.shift()) });
  let point = null;
  const segments = [];
  while (tokens.length) {
    const command = tokens.shift();
    if (command === 'M') point = readPoint();
    else if (command === 'L') { const end = readPoint(); segments.push({ start: point, end }); point = end; }
    else if (command === 'C') {
      const first = readPoint(), second = readPoint(), end = readPoint();
      segments.push({ start: point, first, second, end }); point = end;
    } else assert.fail(`Unexpected path command: ${command}`);
  }
  return segments;
}
function verifyCurve(graph, name) {
  const dots = Array.from(graph.querySelectorAll(`.wg-${name}-point`), (point) => ({ x: Number(point.getAttribute('cx')), y: Number(point.getAttribute('cy')) }));
  let offset = 0;
  for (const line of graph.querySelectorAll(`.wg-${name}`)) {
    const count = Number(line.dataset.samples), segments = pathSegments(line.getAttribute('d'));
    const expected = dots.slice(offset, offset + count); offset += count;
    assert.equal(segments.length, count - 1);
    segments.forEach((segment, index) => {
      for (const key of ['x', 'y']) {
        assert.ok(Math.abs(segment.start[key] - expected[index][key]) < 0.000002, 'curve starts at the actual source point');
        assert.ok(Math.abs(segment.end[key] - expected[index + 1][key]) < 0.000002, 'curve ends at the actual source point');
      }
      const low = Math.min(segment.start.y, segment.end.y), high = Math.max(segment.start.y, segment.end.y);
      let previous = segment.start.x;
      for (let step = 0; step <= 100; step += 1) {
        const t = step / 100, u = 1 - t;
        const at = (key) => segment.first ? u ** 3 * segment.start[key] + 3 * u ** 2 * t * segment.first[key] + 3 * u * t ** 2 * segment.second[key] + t ** 3 * segment.end[key] : u * segment.start[key] + t * segment.end[key];
        const x = at('x'), y = at('y');
        assert.ok(x >= previous - 0.000002, 'time stays monotone'); previous = x;
        assert.ok(y >= low - 0.000002 && y <= high + 0.000002, 'shape-preserving curve stays between neighboring actual values');
        if (name === 'precipitation') assert.ok(y >= 17 - 0.000002 && y <= 88 + 0.000002, 'chance curve stays within0–100%');
      }
    });
  }
  assert.equal(offset, dots.length, 'every actual source point is retained');
}

test('hourly graph preserves valid zero/negative values, converts Celsius, and rejects invalid chance rather than inventing an amount', () => {
  const f = fixture();
  try {
    const rows = [period(0, 0, 0), period(1, -12, 100), period(2, null, null), { ...period(3, null, 101), temperature: { value: 0, unitCode: 'wmoUnit:degC' } }, { ...period(4, null, -1), fahrenheit: 40 }];
    const data = f.graphs.model(rows);
    assert.deepEqual(Array.from(data.samples, (sample) => sample.temperature), [0, -12, null, 32, 40]);
    assert.deepEqual(Array.from(data.samples, (sample) => sample.precipitation), [0, 100, null, null, null]);
    const graph = f.graphs.hourly(rows);
    assert.match(graph.getAttribute('aria-label'), /Precipitation is chance, not accumulation/);
    assert.equal(graph.querySelectorAll('.wg-precipitation-point').length, 2);
    assert.equal(graph.querySelectorAll('.wg-temperature-point').length, 4);
    assert.match(graph.querySelector('.wg-precipitation-point title').textContent, /0% precipitation chance/);
    assert.match(graph.querySelector('.wg-temperature-point title').textContent, /0°F air temperature/);
    assert.equal(graph.querySelector('.wg-precipitation').getAttribute('stroke'), '#20d8ed');
    assert.equal(graph.querySelector('.wg-temperature').getAttribute('stroke'), '#ff991f');
  } finally { f.close(); }
});

test('independent missing samples and missing hours break each smoothed series without interpolation overshoot', () => {
  const f = fixture();
  try {
    const rows = [period(0, 20, 0), period(1, 35, 100), period(2, null, 50), period(4, 45, 25), period(5, 50, null)];
    const data = f.graphs.model(rows);
    assert.deepEqual(Array.from(data.series.temperature, (run) => run.length), [2, 2]);
    assert.deepEqual(Array.from(data.series.precipitation, (run) => run.length), [3, 1]);
    const graph = f.graphs.hourly(rows, { height: 112 });
    verifyCurve(graph, 'temperature'); verifyCurve(graph, 'precipitation');
    assert.match(graph.querySelector('.wg-precipitation').getAttribute('d'), /C/, 'three supplied points use a smooth curve');
    assert.doesNotMatch(graph.querySelector('.wg-temperature').getAttribute('d'), /C/, 'a two-point run can remain straight');
    for (const point of graph.querySelectorAll('.wg-precipitation-point')) {
      const y = Number(point.getAttribute('cy'));
      assert.ok(y >= 17 && y <= 88, `chance remains within0–100% plot: ${y}`);
    }
    const unknown = f.graphs.hourly([period(0, null, null)]);
    assert.equal(unknown.dataset.status, 'unavailable');
    assert.equal(unknown.querySelector('.wg-series'), null);
    assert.match(unknown.textContent, /unavailable/);
  } finally { f.close(); }
});

test('monotone smoothing preserves plateaus, turning points and uneven time spacing with the same curve used for chance fill', () => {
  const f = fixture();
  try {
    const cases = [
      { values: [0, 0, 100, 100, 0, 0], offsets: [0, 1, 2, 3, 4, 5] },
      { values: [0, 100, 0, 100, 25, 25, 100], offsets: [0, 1, 2, 3, 4, 5, 6] },
      { values: [0, 10, 80, 100, 100, 20], offsets: [0, .25, 1.25, 2, 2.25, 3.5] },
    ];
    for (const { values, offsets } of cases) {
      const rows = values.map((chance, index) => ({ ...period(index, chance - 40, chance), startTime: new Date(START + offsets[index] * HOUR).toISOString(), endTime: new Date(START + (offsets[index] + 1.5) * HOUR).toISOString() }));
      const graph = f.graphs.hourly(rows, { width: 440, height: 112 });
      verifyCurve(graph, 'precipitation'); verifyCurve(graph, 'temperature');
      assert.match(graph.querySelector('.wg-precipitation').getAttribute('d'), /C/);
      const line = graph.querySelector('.wg-precipitation').getAttribute('d'), area = graph.querySelector('.wg-precipitation-area').getAttribute('d');
      assert.ok(area.startsWith(line + 'L'), 'area follows exactly the same smooth upper boundary');
      assert.equal(graph.querySelectorAll('.wg-sr-only tr').length, values.length + 1, 'raw source table is retained');
    }
    const gaps = f.graphs.hourly([period(0, 10, 0), period(1, 20, 50), period(2, 30, 100), period(3, null, null), period(5, 40, 100), period(6, 20, 50), period(7, 0, 0)]);
    assert.equal(gaps.querySelectorAll('.wg-temperature').length, 2);
    assert.equal(gaps.querySelectorAll('.wg-precipitation').length, 2);
    verifyCurve(gaps, 'temperature'); verifyCurve(gaps, 'precipitation');
    const cards = f.graphs.hourly([period(0, 20, 0), period(1, 30, 100), period(2, 20, 0), period(3, 35, 100)], { layout: 'cards', columnWidth: 158, cardWidth: 150, width: 624 });
    verifyCurve(cards, 'temperature'); verifyCurve(cards, 'precipitation');
    assert.deepEqual(Array.from(cards.querySelectorAll('.wg-temperature-point'), (point) => Number(point.getAttribute('cx'))), [75, 233, 391, 549]);
  } finally { f.close(); }
});

test('freezing reference is at32°F on the actual temperature scale and forecast windows exclude unrelated hours', () => {
  const f = fixture();
  try {
    const rows = [period(0, -10, 30), period(1, 20, 40), period(2, 50, 60), period(3, 100, 80)];
    const graph = f.graphs.hourly(rows, { start: START + HOUR, end: START + 3 * HOUR, currentTime: START + 2 * HOUR, width: 440, height: 112 });
    assert.equal(graph.querySelectorAll('.wg-temperature-point').length, 2);
    const min = Number(graph.dataset.temperatureMin), max = Number(graph.dataset.temperatureMax);
    const expected = 88 - (32 - min) / (max - min) * 71;
    assert.equal(Number(graph.querySelector('.wg-freezing-line').getAttribute('y1')), expected);
    assert.equal(graph.querySelector('.wg-freezing-label').textContent, '32°');
    assert.ok(graph.querySelector('.wg-now'));
    assert.equal(graph.dataset.start, new Date(START + HOUR).toISOString());
    assert.equal(graph.dataset.end, new Date(START + 3 * HOUR).toISOString());
  } finally { f.close(); }
});

test('card layout uses the same slot centers/width as hourly cards while preserving gaps in real forecast time', () => {
  const f = fixture();
  try {
    const graph = f.graphs.hourly([period(0, 20, 10), period(1, 30, 20), period(3, 40, 30)], { layout: 'cards', columnWidth: 158, cardWidth: 150, width: 466 });
    assert.equal(graph.style.width, '466px');
    assert.deepEqual(Array.from(graph.querySelectorAll('.wg-temperature-point'), (point) => Number(point.getAttribute('cx'))), [75, 233, 391]);
    assert.equal(graph.querySelectorAll('.wg-temperature').length, 2, 'missing actual hour is not connected even though cards occupy adjacent slots');
    assert.deepEqual(Array.from(graph.querySelectorAll('.wg-time'), (tick) => Number(tick.getAttribute('x'))), [75, 233, 391], 'card clock labels remain at actual card centers');
  } finally { f.close(); }
});

test('graph clock labels honor Chief24-hour versus other users12-hour and retain Central DST distinctions in accessible values', () => {
  const chief = fixture(true), staff = fixture(false);
  try {
    const data = [period(0, 32, 0), period(1, 34, 10)];
    assert.equal(chief.graphs.hourly(data).querySelector('.wg-time').textContent, '00:00');
    assert.equal(staff.graphs.hourly(data).querySelector('.wg-time').textContent, '12:00 AM');
    const repeated = [{ ...period(0, 30, 20), startTime: '2026-11-01T01:00:00-05:00', endTime: '2026-11-01T01:00:00-06:00' },
      { ...period(1, 31, 30), startTime: '2026-11-01T01:00:00-06:00', endTime: '2026-11-01T02:00:00-06:00' }];
    const graph = staff.graphs.hourly(repeated, { stale: true });
    const labels = Array.from(graph.querySelectorAll('.wg-temperature-point'), (point) => point.getAttribute('aria-label'));
    assert.match(labels[0], /1:00 AM CDT/); assert.match(labels[1], /1:00 AM CST/);
    assert.equal(graph.dataset.status, 'stale'); assert.match(graph.textContent, /STALE/);
  } finally { chief.close(); staff.close(); }
});

test('sparse daily coverage keeps evenly distributed domain ticks with enough spacing for12-hour labels, without inventing samples', () => {
  const chief = fixture(true), staff = fixture(false);
  try {
    const rows = [period(0, 30, 20), period(1, 32, 30), period(2, 34, 40)].map((row) => ({
      ...row, startTime: new Date(Date.parse(row.startTime) + 40 * 60000).toISOString(), endTime: new Date(Date.parse(row.endTime) + 40 * 60000).toISOString(),
    }));
    const options = { start: START, end: START + 24 * HOUR, width: 245 };
    const graph = chief.graphs.hourly(rows, options);
    assert.deepEqual(Array.from(graph.querySelectorAll('.wg-time'), (tick) => tick.textContent), ['00:00', '06:00', '12:00', '18:00', '00:00']);
    assert.equal(graph.querySelectorAll('.wg-temperature-point').length, 3);
    assert.equal(graph.querySelectorAll('.wg-precipitation-point').length, 3);
    assert.ok(Array.from(graph.querySelectorAll('.wg-temperature-point'), (point) => Number(point.getAttribute('cx'))).every((x) => x < 50), 'the actual early-hour data stays near its true time');
    for (const width of [180, 225, 245, 440]) {
      const small = staff.graphs.hourly(rows, { ...options, width });
      const ticks = Array.from(small.querySelectorAll('.wg-time'), (tick) => ({ x: Number(tick.getAttribute('x')), text: tick.textContent }));
      assert.equal(ticks[0].text, '12:00 AM'); assert.equal(ticks.at(-1).text, '12:00 AM');
      for (let index = 1; index < ticks.length; index += 1) {
        const gap = ticks[index].x - ticks[index - 1].x;
        assert.ok(gap >= 40, `clock labels have at least40px center spacing at${width}px`);
        assert.ok(gap >= (ticks[index].text.length + ticks[index - 1].text.length) * 2.4 + 8, 'AM/PM text has a visible gap');
      }
      assert.equal(small.querySelectorAll('.wg-temperature-point').length, 3);
    }
  } finally { chief.close(); staff.close(); }
});
