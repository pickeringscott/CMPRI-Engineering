/* Compact plots of supplied NWS hourly guidance. Colors describe these data
 * series and are deliberately independent of CMPRI's seasonal theme. */
(function () {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const COLORS = Object.freeze({ precipitation: '#20d8ed', temperature: '#ff991f', freezing: '#a9cce3' });
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  let graphId = 0;
  function timestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const result = typeof value === 'number' ? value : Date.parse(value);
    return finite(result) ? result : null;
  }
  function airTemperature(period) {
    if (finite(period.fahrenheit)) return period.fahrenheit;
    const quantity = period.temperature;
    const value = quantity && typeof quantity === 'object' ? quantity.value : quantity;
    const unit = String(quantity && typeof quantity === 'object' ? quantity.unitCode || quantity.unit || '' : period.temperatureUnit || '').split(':').pop();
    if (!finite(value)) return null;
    if (['F', 'degF'].includes(unit)) return value;
    if (['C', 'degC'].includes(unit)) return value * 9 / 5 + 32;
    if (unit === 'K') return (value - 273.15) * 9 / 5 + 32;
    return null;
  }
  function clock(value, full = false) {
    const helper = window.cmpriWeatherClock;
    if (helper) return full ? helper.stamp(value) : helper.time(value, { zone: false });
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ...(full ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
  }
  function model(periods = [], options = {}) {
    const rows = (Array.isArray(periods) ? periods : []).map((period) => {
      const start = timestamp(period.startTime), end = timestamp(period.endTime);
      const rawChance = period.probabilityOfPrecipitation?.value;
      return { start, end, temperature: airTemperature(period), precipitation: finite(rawChance) && rawChance >= 0 && rawChance <= 100 ? rawChance : null };
    }).filter((row) => row.start !== null && row.end !== null && row.end > row.start).sort((a, b) => a.start - b.start)
      .filter((row, index, all) => !index || row.start !== all[index - 1].start);
    const requestedStart = timestamp(options.start), requestedEnd = timestamp(options.end);
    const start = requestedStart ?? rows[0]?.start ?? null, end = requestedEnd ?? rows.at(-1)?.end ?? null;
    const valid = start !== null && end !== null && end > start;
    const samples = valid ? rows.filter((row) => row.start >= start && row.start < end) : [];
    const series = {};
    for (const name of ['precipitation', 'temperature']) {
      const segments = []; let run = [];
      samples.forEach((sample) => {
        const previous = run.at(-1), connected = !previous || sample.start - previous.start <= 90 * 60000 && sample.start <= previous.end;
        if (!finite(sample[name]) || !connected) { if (run.length) segments.push(run); run = []; }
        if (finite(sample[name])) run.push(sample);
      });
      if (run.length) segments.push(run);
      series[name] = segments;
    }
    const temperatures = samples.map((sample) => sample.temperature).filter(finite);
    let minimum = Math.floor(Math.min(32, ...temperatures) / 5) * 5, maximum = Math.ceil(Math.max(32, ...temperatures) / 5) * 5;
    if (maximum - minimum < 20) { const middle = (minimum + maximum) / 2; minimum = Math.floor((middle - 10) / 5) * 5; maximum = minimum + 20; }
    return { start, end, valid, samples, series, temperatureDomain: [minimum, maximum] };
  }
  function html(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function shape(parent, tag, attributes, text) {
    const node = document.createElementNS(SVG, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    parent.append(node); return node;
  }
  function hourly(periods, options = {}) {
    const data = model(periods, options), cards = options.layout === 'cards';
    const columnWidth = finite(options.columnWidth) && options.columnWidth > 0 ? options.columnWidth : 150;
    const cardWidth = finite(options.cardWidth) && options.cardWidth > 0 ? options.cardWidth : columnWidth;
    const width = finite(options.width) ? Math.max(180, Math.min(100000, options.width)) : cards ? Math.max(180, Math.max(0, data.samples.length - 1) * columnWidth + cardWidth) : 360;
    const height = finite(options.height) ? Math.max(88, Math.min(240, options.height)) : 112;
    const left = cards ? 0 : 25, right = cards ? width : width - 34, top = 17, bottom = height - 24;
    const root = html('figure', 'wg-hourly-graph');
    const hasValues = data.samples.some((sample) => finite(sample.temperature) || finite(sample.precipitation));
    root.dataset.layout = cards ? 'cards' : 'time'; root.dataset.status = hasValues ? options.stale ? 'stale' : 'live' : 'unavailable';
    root.dataset.start = data.start === null ? '' : new Date(data.start).toISOString(); root.dataset.end = data.end === null ? '' : new Date(data.end).toISOString();
    root.dataset.temperatureMin = String(data.temperatureDomain[0]); root.dataset.temperatureMax = String(data.temperatureDomain[1]);
    if (cards) root.style.width = width + 'px';
    const legend = html('figcaption', 'wg-legend');
    legend.append(html('span', 'wg-precipitation-label', 'Precip chance %'), html('span', 'wg-temperature-label', 'Air temp °F'));
    if (options.stale) legend.append(html('span', 'wg-stale', 'STALE'));
    root.append(legend);
    const label = options.title || 'Hourly NWS forecast: precipitation chance and air temperature';
    root.setAttribute('aria-label', label + '. Precipitation is chance, not accumulation. Air temperature is Fahrenheit. Lines connect supplied hourly values; missing hours are gaps.');
    if (!data.valid || root.dataset.status === 'unavailable') {
      root.append(html('p', 'wg-empty', 'Hourly graph unavailable')); return root;
    }
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); svg.setAttribute('class', 'wg-plot'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
    svg.style.height = height + 'px';
    svg.setAttribute('preserveAspectRatio', 'none');
    const clipId = 'wg-clip-' + ++graphId, defs = shape(svg, 'defs', {}), clip = shape(defs, 'clipPath', { id: clipId });
    shape(clip, 'rect', { x: left, y: top, width: right - left, height: bottom - top });
    const x = (sample) => cards ? data.samples.indexOf(sample) * columnWidth + cardWidth / 2 : left + (sample.start - data.start) / (data.end - data.start) * (right - left);
    const yChance = (value) => bottom - value / 100 * (bottom - top);
    const yTemperature = (value) => bottom - (value - data.temperatureDomain[0]) / (data.temperatureDomain[1] - data.temperatureDomain[0]) * (bottom - top);
    [0, 50, 100].forEach((chance) => {
      shape(svg, 'line', { x1: left, x2: right, y1: yChance(chance), y2: yChance(chance), class: 'wg-grid' });
      if (!cards) shape(svg, 'text', { x: left - 4, y: yChance(chance) + 3, 'text-anchor': 'end', class: 'wg-chance-axis' }, String(chance));
    });
    const freezing = yTemperature(32);
    shape(svg, 'line', { x1: left, x2: right, y1: freezing, y2: freezing, class: 'wg-freezing-line', stroke: COLORS.freezing });
    shape(svg, 'text', { x: cards ? 6 : right + 4, y: freezing - 3, class: 'wg-freezing-label' }, '32°');
    if (!cards) [data.temperatureDomain[0], data.temperatureDomain[1]].filter((value) => value !== 32).forEach((value) => shape(svg, 'text', { x: right + 4, y: yTemperature(value) + 3, class: 'wg-temperature-axis' }, number.format(value) + '°'));
    const plots = shape(svg, 'g', { 'clip-path': 'url(#' + clipId + ')' });
    for (const name of ['precipitation', 'temperature']) {
      const y = name === 'precipitation' ? yChance : yTemperature;
      for (const run of data.series[name]) {
        const path = run.map((sample, index) => (index ? 'L' : 'M') + x(sample).toFixed(2) + ' ' + y(sample[name]).toFixed(2)).join(' ');
        if (name === 'precipitation' && run.length > 1) shape(plots, 'path', { d: path + 'L' + x(run.at(-1)).toFixed(2) + ' ' + bottom + 'L' + x(run[0]).toFixed(2) + ' ' + bottom + 'Z', class: 'wg-precipitation-area', fill: COLORS.precipitation });
        const line = shape(plots, 'path', { d: path, class: 'wg-series wg-' + name, stroke: COLORS[name] });
        line.dataset.samples = String(run.length);
        for (const sample of run) {
          const point = shape(plots, 'circle', { cx: x(sample), cy: y(sample[name]), r: 2, class: 'wg-point wg-' + name + '-point', fill: COLORS[name], tabindex: 0 });
          point.dataset.time = new Date(sample.start).toISOString(); point.dataset.value = String(sample[name]);
          const text = clock(sample.start, true) + ' · ' + (name === 'precipitation' ? number.format(sample[name]) + '% precipitation chance' : number.format(sample[name]) + '°F air temperature');
          point.setAttribute('aria-label', text); shape(point, 'title', {}, text);
        }
      }
    }
    const now = timestamp(options.currentTime);
    if (now !== null && now >= data.start && now < data.end && !cards) {
      const position = left + (now - data.start) / (data.end - data.start) * (right - left);
      shape(svg, 'line', { x1: position, x2: position, y1: top, y2: bottom, class: 'wg-now' });
    }
    if (cards) {
      const step = finite(options.labelStep) && options.labelStep >= 1 ? Math.floor(options.labelStep) : 1;
      data.samples.forEach((sample, index) => {
        if (index % step && index !== data.samples.length - 1) return;
        shape(svg, 'text', { x: x(sample), y: height - 7, 'text-anchor': 'middle', class: 'wg-time', 'data-time': new Date(sample.start).toISOString() }, clock(sample.start));
      });
    } else {
      // Axis ticks describe the whole requested window, independently of sparse
      // source coverage. They never add samples or connect a missing interval.
      const candidates = Array.from({ length: 5 }, (_, index) => {
        const time = data.start + (data.end - data.start) * index / 4;
        return { time, x: left + (right - left) * index / 4, label: clock(time) };
      });
      const distance = (a, b) => Math.max(40, (a.label.length + b.label.length) * 2.4 + 8);
      const ticks = [candidates[0]], last = candidates.at(-1);
      candidates.slice(1, -1).forEach((candidate) => {
        const previous = ticks.at(-1);
        if (candidate.x - previous.x >= distance(previous, candidate) && last.x - candidate.x >= distance(candidate, last)) ticks.push(candidate);
      });
      ticks.push(last);
      ticks.forEach((tick) => shape(svg, 'text', { x: tick.x, y: height - 7, 'text-anchor': 'middle', class: 'wg-time', 'data-axis-tick': 'domain', 'data-time': new Date(tick.time).toISOString() }, tick.label));
    }
    root.append(svg);
    const table = html('table', 'wg-sr-only'), head = html('tr');
    ['Central time', 'Precipitation chance', 'Air temperature'].forEach((label) => head.append(html('th', '', label))); table.append(head);
    data.samples.forEach((sample) => { const row = html('tr'); row.append(html('td', '', clock(sample.start, true)), html('td', '', sample.precipitation === null ? 'Unavailable' : number.format(sample.precipitation) + '%'), html('td', '', sample.temperature === null ? 'Unavailable' : number.format(sample.temperature) + '°F')); table.append(row); });
    root.append(table); return root;
  }
  window.cmpriWeatherGraphs = Object.freeze({ hourly, model, colors: COLORS });
}());
