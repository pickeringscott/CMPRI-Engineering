/* Branch review: display the fixed property's actual NWS responses.
 * Independent foreground observation, alert and forecast reads when opened. No database, geolocation,
 * notification permission, push delivery, or background scheduler is used.
 */
(function () {
  'use strict';
  const ENDPOINT = '/api/weather-preview';
  const HOUR = 3600000;
  const RESOURCE_NAMES = {
    points: 'Property point', forecast: 'Extended forecast', hourly: 'Hourly forecast',
    grid: 'Forecast grid / accumulations',
    observation: 'Current station observation', history: 'Observed temperatures since local midnight', alerts: 'Official property alerts'
  };
  const clock = window.cmpriWeatherClock;
  const hourTime = { format: (value) => clock ? clock.time(value.valueOf(), { weekday: true }) : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(value) };
  let initialized = false, opened = false, generation = 0, alertExpiryTimer = null;
  const activeRequests = new Map(), pendingResources = new Set();
  const PARTS = { observation: ['observation'], history: ['history'], alerts: ['alerts'], forecast: ['points', 'forecast', 'hourly', 'grid'] };
  const SOURCES = { history: 'https://api.weather.gov/stations/KCMI/observations', observation: 'https://api.weather.gov/stations/KCMI/observations/latest', alerts: 'https://api.weather.gov/alerts/active?point=40.138080,-88.251416', points: 'https://api.weather.gov/points/40.1381,-88.2514' };
  const CACHE_TTL = 5 * 60000;
  const fetchedParts = new Map(), observedReports = new Map(), forecastHours = new Map();
  let observedExtremes = null;
  let astronomyDecoration = null;
  let requests = 0, checkedAt = null, resources = {}, lastError = '', loading = false;
  const byId = (id) => document.getElementById(id);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  function node(tag, value, className) {
    const result = document.createElement(tag);
    if (value !== undefined) result.textContent = value;
    if (className) result.className = className;
    return result;
  }
  function text(id, value) { if (byId(id)) byId(id).textContent = value; }
  function date(value) {
    if (value === null || value === undefined || value === '') return null;
    const result = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  function stamp(value) { const time = date(value); return time === null ? 'Unavailable' : clock ? clock.stamp(time) : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(new Date(time)); }
  function round(value, digits = 0) { return Number(value.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits }); }
  function sourceUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'weather.gov' || url.hostname.endsWith('.weather.gov')) ? url.href : null;
    } catch { return null; }
  }
  function sourceLink(value, label = 'Official NWS source') {
    const url = sourceUrl(value);
    if (!url) return node('span', label + ' unavailable');
    const link = node('a', label + ' ↗');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  }
  function resource(name) {
    const value = resources[name];
    if (!value || !value.data) return { status: 'unavailable', source: value?.source || null,
      receivedAt: value?.receivedAt || null, sourceTimestamp: value?.sourceTimestamp || null,
      data: null, pending: pendingResources.has(name), error: value?.error || (pendingResources.has(name) ? 'Awaiting official NWS data' : 'No usable NWS data') };
    const sourceTime = date(value.sourceTimestamp), maxAge = ['observation', 'history', 'alerts'].includes(name) ? 90 * 60000 : 6 * HOUR;
    const aged = sourceTime !== null && Date.now() - sourceTime > maxAge;
    return { ...value, pending: pendingResources.has(name), status: ['live', 'stale'].includes(value.status) ? aged ? 'stale' : value.status : 'unavailable' };
  }
  function quantity(input, kind) {
    if (!input || !finite(input.value)) return null;
    const value = input.value, unit = String(input.unitCode || input.unit || '').split(':').pop();
    if (kind === 'temperature') {
      if (['degF', 'F'].includes(unit)) return value;
      if (['degC', 'C'].includes(unit)) return value * 9 / 5 + 32;
      if (unit === 'K') return (value - 273.15) * 9 / 5 + 32;
    }
    if (kind === 'wind') {
      if (['mi_h-1', 'mph'].includes(unit)) return value;
      if (['km_h-1', 'km/h'].includes(unit)) return value / 1.609344;
      if (['m_s-1', 'm/s'].includes(unit)) return value * 2.2369362921;
      if (['kn', 'kt'].includes(unit)) return value * 1.150779448;
    }
    if (kind === 'visibility') {
      if (['m', 'meter'].includes(unit)) return value / 1609.344;
      if (unit === 'km') return value / 1.609344;
      if (['mi', 'mile'].includes(unit)) return value;
    }
    if (kind === 'accumulation') {
      if (['in', '[in_i]'].includes(unit)) return value;
      if (unit === 'mm') return value / 25.4;
      if (unit === 'cm') return value / 2.54;
      if (unit === 'm') return value / .0254;
    }
    if (kind === 'percent' && ['percent', '%'].includes(unit) && value >= 0 && value <= 100) return value;
    return null;
  }
  function rememberObservations() {
    const features = resource('history').data?.features;
    const latest = resource('observation').data;
    const all = [...(Array.isArray(features) ? features : []), ...(latest ? [latest] : [])];
    const today = window.cmpriWeatherVisuals?.dayKey(Date.now());
    for (const feature of all) {
      const p = feature?.properties || {}, timestamp = date(p.timestamp);
      if (timestamp === null || timestamp > Date.now()) continue;
      const value = quantity(p.temperature, 'temperature');
      const prior = observedReports.get(timestamp);
      if (!prior || prior.fahrenheit === null && value !== null) observedReports.set(timestamp, { timestamp, fahrenheit: value });
    }
    // The cache is memory-only, retaining today's reports and one bounded pre-midnight anchor.
    const rows = Array.from(observedReports.values()).sort((a, b) => a.timestamp - b.timestamp);
    const anchor = rows.filter((row) => window.cmpriWeatherVisuals?.dayKey(row.timestamp) !== today).at(-1);
    for (const row of rows) if (window.cmpriWeatherVisuals?.dayKey(row.timestamp) !== today && row !== anchor) observedReports.delete(row.timestamp);
  }
  function renderObservation() {
    const envelope = resource('observation'), p = envelope.data?.properties;
    const available = envelope.status !== 'unavailable' && p;
    renderCurrentDial();
    text('liveObservationTime', 'As of: ' + stamp(p?.timestamp) + ' · Willard (KCMI)');
    text('liveConditionsBadge', envelope.status === 'stale' ? 'STALE KCMI' : available ? 'KCMI' : envelope.pending ? 'Awaiting KCMI' : 'Unavailable');
  }
  function interval(value) {
    if (typeof value !== 'string') return null;
    const [startValue, endValue] = value.split('/'), start = date(startValue);
    if (start === null || !endValue) return null;
    let end = date(endValue);
    if (endValue.startsWith('P')) {
      const match = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(endValue);
      if (!match || !match.slice(1).some(Boolean)) return null;
      end = start + ((Number(match[1] || 0) * 7 + Number(match[2] || 0)) * 24 * 3600 + Number(match[3] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[5] || 0)) * 1000;
    }
    return end !== null && end > start ? { start, end } : null;
  }
  function gridAt(series, when, kind) {
    if (!series || !Array.isArray(series.values) || when === null) return null;
    const item = series.values.find((row) => { const span = interval(row.validTime); return span && span.start <= when && span.end > when; });
    return item ? quantity({ value: item.value, unitCode: series.uom }, kind) : null;
  }
  function periodTemperatureValue(period) {
    if (period.temperature && typeof period.temperature === 'object') return quantity(period.temperature, 'temperature');
    if (!finite(period.temperature)) return null;
    return period.temperatureUnit === 'F' ? period.temperature : period.temperatureUnit === 'C' ? period.temperature * 9 / 5 + 32 : null;
  }
  function periodWindSpeed(period) {
    if (typeof period.windSpeed === 'string' && period.windSpeed) return period.windSpeed;
    const speed = quantity(period.windSpeed, 'wind');
    return speed === null ? null : round(speed) + ' mph';
  }
  function rememberForecasts() {
    const envelope = resource('hourly');
    const periods = envelope.status === 'unavailable' ? [] : envelope.data?.properties?.periods;
    const start = window.cmpriWeatherVisuals?.observationDay([], Date.now()).start;
    if (!finite(start)) return;
    for (const period of Array.isArray(periods) ? periods : []) {
      const from = date(period.startTime), to = date(period.endTime);
      if (from !== null && to !== null && to > from && to > start && from < start + 9 * 24 * HOUR) {
        forecastHours.set(from, { ...period, forecastSourceTimestamp: envelope.sourceTimestamp });
      }
    }
    for (const [key, period] of forecastHours) if (date(period.endTime) <= start || key >= start + 9 * 24 * HOUR) forecastHours.delete(key);
    while (forecastHours.size > 512) forecastHours.delete(forecastHours.keys().next().value);
  }
  function forecastTimelinePeriods() {
    // Preserve earlier published forecast hours in RAM. The official grid can
    // supply valid earlier intervals on a first visit; observations never fill
    // an unknown forecast interval or masquerade as a historical forecast.
    rememberForecasts();
    const visuals = window.cmpriWeatherVisuals;
    if (!visuals) return [];
    const today = visuals.observationDay([], Date.now());
    const envelope = resource('grid'), grid = envelope.status === 'unavailable' ? null : envelope.data?.properties;
    const cached = Array.from(forecastHours.values()).sort((a, b) => date(a.startTime) - date(b.startTime));
    const boundaries = new Set([today.start, today.end]);
    for (let at = today.start; at < today.end; at += HOUR) boundaries.add(at);
    for (const period of cached) {
      for (const at of [date(period.startTime), date(period.endTime)]) if (at !== null && at > today.start && at < today.end) boundaries.add(at);
    }
    for (const series of [grid?.temperature, grid?.probabilityOfPrecipitation]) {
      for (const row of Array.isArray(series?.values) ? series.values.slice(0, 2000) : []) {
        const span = interval(row.validTime); if (!span) continue;
        for (const at of [span.start, span.end]) if (at > today.start && at < today.end) boundaries.add(at);
      }
    }
    const times = Array.from(boundaries).sort((a, b) => a - b), result = [];
    for (let index = 0; index < times.length - 1; index += 1) {
      const from = times[index], to = times[index + 1];
      const published = cached.find((period) => date(period.startTime) <= from && date(period.endTime) >= to);
      const publishedTemperature = published ? periodTemperatureValue(published) : null;
      const fahrenheit = publishedTemperature ?? gridAt(grid?.temperature, from, 'temperature');
      const rawChance = published?.probabilityOfPrecipitation?.value;
      const publishedChance = finite(rawChance) && rawChance >= 0 && rawChance <= 100 ? rawChance : null;
      const chance = publishedChance ?? gridAt(grid?.probabilityOfPrecipitation, from, 'percent');
      if (fahrenheit === null && chance === null) continue;
      result.push({ ...published, startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString(),
        fahrenheit, probabilityOfPrecipitation: { value: chance },
        forecastTemperatureSource: publishedTemperature === null ? 'NWS forecast grid valid interval' : 'NWS hourly forecast retained in memory',
        forecastPrecipitationSource: publishedChance === null ? 'NWS forecast grid valid interval' : 'NWS hourly forecast retained in memory' });
    }
    return result;
  }
  function providedHourlyPeriods() {
    const envelope = resource('hourly');
    const periods = envelope.status === 'unavailable' ? [] : envelope.data?.properties?.periods;
    return Array.isArray(periods) ? periods : [];
  }
  function renderCurrentGraphs(periods, day) {
    const host = byId('currentConditionsGraphs'), graphs = window.cmpriWeatherGraphs;
    if (!host || !graphs) return;
    host.replaceChildren(graphs.hourly(periods, { start: day.start, end: day.end,
      width: host.clientWidth || 440, currentTime: Date.now(), height: 116,
      stale: resource('hourly').status === 'stale' || resource('grid').status === 'stale',
      title: 'Today’s published NWS forecast in Central time; earlier forecast intervals remain forecast guidance' }));
  }
  function renderHourlyGraphs() {
    const host = byId('hourlyForecastGraphs'), cards = byId('hourlyForecastCards'), graphs = window.cmpriWeatherGraphs;
    if (!host || !cards || !graphs) return;
    const first = cards.querySelector('.hourly-forecast-card'), periods = providedHourlyPeriods();
    const cardWidth = first?.getBoundingClientRect().width || 148;
    const gap = Number.parseFloat(getComputedStyle(cards).columnGap) || 8;
    const width = Math.max(cardWidth, periods.length * cardWidth + Math.max(0, periods.length - 1) * gap);
    host.replaceChildren(graphs.hourly(periods, { layout: 'cards', cardWidth, columnWidth: cardWidth + gap, width,
      height: 116, labelStep: 1, stale: resource('hourly').status === 'stale', title: 'Hourly precipitation chance and temperature, aligned with the forecast cards above' }));
  }
  function renderDailyGraphs(day, host) {
    const graphs = window.cmpriWeatherGraphs;
    if (!graphs || !host) return;
    host.replaceChildren(graphs.hourly(providedHourlyPeriods(), { start: day.start, end: day.end,
      width: host.clientWidth || 240, height: 104, stale: resource('hourly').status === 'stale',
      title: day.label + ' hourly precipitation chance and temperature · Central time' }));
  }
  function resizeGraphs() {
    if (!opened) return;
    const visuals = window.cmpriWeatherVisuals;
    if (!visuals) return;
    renderCurrentGraphs(forecastTimelinePeriods(), visuals.observationDay([], Date.now()));
    renderHourlyGraphs();
    for (const day of forecastDayModels()) renderDailyGraphs(day, byId('extendedForecast')?.querySelector('[data-day="' + day.key + '"] .daily-forecast-graphs'));
  }
  function forecastDayModels() {
    const hourly = resource('hourly'), extended = resource('forecast');
    const hours = hourly.status === 'unavailable' ? [] : hourly.data?.properties?.periods;
    const days = extended.status === 'unavailable' ? [] : extended.data?.properties?.periods;
    const daysWithForecasts = window.cmpriWeatherVisuals?.forecastDays(
      (Array.isArray(hours) ? hours : []).map((period) => ({ ...period, fahrenheit: periodTemperatureValue(period) })),
      Array.isArray(days) ? days : []
    ) || [];
    return daysWithForecasts.map(fillTodayHistory);
  }
  function clipRingSegment(segment, from, to) {
    const duration = segment.end - segment.start;
    const last = finite(segment.endFahrenheit) ? segment.endFahrenheit : segment.fahrenheit;
    const interpolate = (at) => segment.fahrenheit + (last - segment.fahrenheit) * (at - segment.start) / duration;
    const parts = clock.parts(from), minute = Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60;
    return { ...segment, start: from, end: to, minute, minuteEnd: Math.min(1440, minute + (to - from) / 60000),
      fahrenheit: interpolate(from), endFahrenheit: interpolate(to) };
  }
  function fillTodayHistory(day) {
    const now = Date.now(), visuals = window.cmpriWeatherVisuals;
    if (!visuals || day.key !== visuals.dayKey(now)) return day;
    rememberObservations();
    const timeline = forecastTimelinePeriods();
    const forecast = visuals.forecastDays(timeline).find((item) => item.key === day.key);
    const observed = visuals.observationDay(Array.from(observedReports.values()), now);
    const segments = day.segments.map((segment) => ({ ...segment, sourceKind: 'forecast', source: 'NWS hourly forecast' }));
    function addAvailable(candidate) {
      const start = Math.max(candidate.start, day.start), end = Math.min(candidate.end, now, day.end);
      if (end <= start) return;
      let uncovered = [[start, end]];
      for (const existing of segments) {
        uncovered = uncovered.flatMap(([from, to]) => existing.end <= from || existing.start >= to ? [[from, to]]
          : [[from, Math.min(to, existing.start)], [Math.max(from, existing.end), to]].filter(([a, b]) => b > a));
        if (!uncovered.length) break;
      }
      for (const [from, to] of uncovered) segments.push(clipRingSegment(candidate, from, to));
    }
    (forecast?.segments || []).forEach((segment, index, all) => {
      const period = timeline.find((item) => date(item.startTime) <= segment.start && date(item.endTime) >= segment.end);
      const following = all[index + 1];
      const endFahrenheit = following?.start === segment.end ? following.fahrenheit : segment.fahrenheit;
      addAvailable({ ...segment, endFahrenheit, sourceKind: 'forecast', source: period?.forecastTemperatureSource || 'NWS forecast grid valid interval' });
    });
    // Reports fill only remaining past gaps, on the outer track with explicit
    // observed provenance. They never change forecast H/L values or future hours.
    for (const segment of observed.segments) addAvailable({ ...segment, sourceKind: 'observed', source: 'KCMI observations' });
    segments.sort((a, b) => a.start - b.start);
    const coverage = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    return { ...day, segments, coverageHours: coverage / HOUR, partial: coverage < day.end - day.start - 1000,
      historicalObserved: segments.some((segment) => segment.sourceKind === 'observed') };
  }
  function decorateAstronomy() {
    const slot = byId('liveConditionIcon');
    if (!slot || !window.cmpriWeatherAstronomy) return;
    const sky = window.cmpriWeatherAstronomyFeed?.getData() || {};
    const options = { now: Date.now(), moonPhase: sky.moonPhase, events: sky.events || [] };
    if (astronomyDecoration) astronomyDecoration.update(options);
    else astronomyDecoration = window.cmpriWeatherAstronomy.decorateCurrentIcon(slot, options);
  }
  function renderCurrentDial() {
    const host = byId('liveTemperature'); if (!host) return;
    const observation = resource('observation'), hourly = resource('hourly'), p = observation.data?.properties;
    const available = observation.status !== 'unavailable' && p;
    const observed = available ? quantity(p.temperature, 'temperature') : null;
    const visuals = window.cmpriWeatherVisuals;
    if (!visuals) { host.replaceChildren(node('strong', observed === null ? '—' : round(observed) + '°')); return; }
    rememberObservations();
    const observedDay = visuals.observationDay(Array.from(observedReports.values()), Date.now(), observedExtremes);
    observedExtremes = { key: observedDay.key, high: observedDay.high, low: observedDay.low };
    host.classList.add('current-temperature-dial');
    const today = visuals.dayKey(Date.now());
    const timeline = forecastTimelinePeriods();
    const forecastDay = visuals.forecastDays(timeline, resource('forecast').data?.properties?.periods || []).find((item) => item.key === today);
    // Preserve every supplied forecast value/mark. A cold opening can use real
    // KCMI history for uncovered past color intervals, with observed provenance;
    // it never invents an earlier forecast or fills unknown/future observations.
    const day = fillTodayHistory(forecastDay || { ...observedDay, label: 'Today', segments: [], high: null, low: null, hourly: [], extended: [] });
    const wind = available ? quantity(p.windSpeed, 'wind') : null, gust = available ? quantity(p.windGust, 'wind') : null;
    const visibility = available ? quantity(p.visibility, 'visibility') : null;
    const feels = available ? quantity(p.windChill, 'temperature') ?? quantity(p.heatIndex, 'temperature') : null;
    astronomyDecoration?.destroy(); astronomyDecoration = null;
    host.replaceChildren(visuals.temperatureDial(day, { current: true, observedTemperature: observed, observedDay,
      pending: hourly.pending, stale: hourly.status === 'stale' || resource('grid').status === 'stale',
      conditionText: available ? p.textDescription || 'Condition not reported' : observation.pending ? 'Awaiting observation' : 'Conditions unavailable',
      icon: available ? p.icon : null, windSpeed: wind === null ? null : round(wind) + ' MPH', windDirection: p?.windDirection?.value,
      gustText: gust === null ? null : round(gust), visibility: visibility === null ? null : visibility > 0 && visibility < .1 ? '<0.1' : round(visibility, 1), feelsLike: feels }));
    decorateAstronomy();
    renderCurrentGraphs(timeline, observedDay);
  }
  function renderForecast(name, hostId, hourly) {
    const host = byId(hostId); if (!host) return;
    const envelope = resource(name), properties = envelope.data?.properties;
    const periods = Array.isArray(properties?.periods) ? properties.periods : [];
    host.replaceChildren();
    if (envelope.status === 'unavailable' || !periods.length) {
      host.append(node('p', (envelope.pending ? 'Loading official NWS forecast…' : 'Forecast unavailable. No sample values are substituted.'), 'small muted'));
    } else {
      const gridEnvelope = resource('grid');
      const grid = gridEnvelope.status === 'unavailable' ? null : gridEnvelope.data?.properties;
      periods.forEach((period) => {
        const card = node('article', undefined, 'forecast-card hourly-forecast-card');
        const start = date(period.startTime), end = date(period.endTime);
        const visuals = window.cmpriWeatherVisuals;
        const heading = node('div', undefined, 'forecast-card-heading');
        heading.title = 'Forecast valid ' + stamp(start) + ' → ' + stamp(end);
        heading.append(node('h3', hourly && start !== null ? hourTime.format(new Date(start)) : period.name || 'NWS forecast period'));
        card.append(heading);
        if (visuals) { const main = node('div', undefined, 'hourly-condition-main'); main.append(visuals.condition(period.shortForecast || 'Condition not provided', { icon: period.icon, isDaytime: period.isDaytime })); card.append(main); }
        const temperature = periodTemperatureValue(period);
        card.append(visuals ? visuals.temperature(temperature) : node('strong', temperature === null ? '—' : round(temperature) + '°', 'forecast-temperature'));
        card.append(node('p', period.shortForecast || 'Forecast description unavailable', 'forecast-detail'));
        const chance = period.probabilityOfPrecipitation?.value;
        const chanceText = node('p', finite(chance) ? '☂ ' + round(chance) + '%' : 'Precipitation unavailable', 'forecast-chance');
        chanceText.title = 'Forecast precipitation chance'; card.append(chanceText);
        const gust = gridAt(grid?.windGust, start, 'wind');
        if (visuals) card.append(visuals.wind(periodWindSpeed(period), period.windDirection, { forecast: true, gustLabel: 'Gusts', gustText: gust === null ? null : round(gust) + ' mph' + (gridEnvelope.status === 'stale' ? ' · STALE grid' : '') }));
        else card.append(node('p', [period.windDirection, periodWindSpeed(period) || 'Wind unavailable'].filter(Boolean).join(' '), 'forecast-wind'));
        if (hourly) {
          const feels = gridAt(grid?.apparentTemperature, start, 'temperature');
          if (feels !== null) card.append(node('p', 'Feels ' + round(feels) + '°' + (gridEnvelope.status === 'stale' ? ' · STALE grid' : ''), 'forecast-wind'));
        }
        if (period.detailedForecast) {
          const detail = node('details'); detail.append(node('summary', 'NWS forecast text'));
          detail.append(node('p', period.detailedForecast, 'small')); card.append(detail);
        }
        if (envelope.status === 'stale') card.prepend(node('span', 'STALE FORECAST', 'badge warning'));
        host.append(card);
      });
    }
    if (hourly) renderHourlyGraphs();
  }
  function renderDailyForecast() {
    const host = byId('extendedForecast'); if (!host) return;
    const envelope = resource('forecast'), hourly = resource('hourly'), visuals = window.cmpriWeatherVisuals;
    const days = forecastDayModels();
    host.classList.add('daily-forecast-strip');
    host.replaceChildren();
    if (!days.length || !visuals) {
      host.append(node('p', envelope.pending || hourly.pending ? 'Loading official NWS daily forecast…' : 'Daily forecast unavailable. No sample values are substituted.', 'small muted'));
      return;
    }
    for (const day of days) {
      const card = node('article', undefined, 'forecast-card daily-forecast-card'); card.dataset.day = day.key;
      const daytime = day.extended.find((period) => period.isDaytime === true && visuals.dayKey(period.startTime) === day.key);
      const night = day.extended.find((period) => period.isDaytime === false && visuals.dayKey(period.startTime) === day.key);
      const representative = daytime || day.hourly.find((period) => period.isDaytime === true) || night || day.hourly[0] || day.extended[0];
      const heading = node('div', undefined, 'forecast-card-heading');
      heading.append(node('h3', day.label));
      card.append(heading, visuals.temperatureDial(day, { stale: hourly.status === 'stale', pending: hourly.pending,
        conditionText: representative?.shortForecast || 'Conditions unavailable', icon: representative?.icon, isDaytime: representative?.isDaytime,
        windSpeed: periodWindSpeed(representative || {}), windDirection: representative?.windDirection,
        officialHigh: daytime ? periodTemperatureValue(daytime) : null, officialLow: night ? periodTemperatureValue(night) : null }));
      if (envelope.status === 'stale') card.prepend(node('span', 'STALE DAILY FORECAST', 'badge warning'));
      const detail = node('details'); detail.append(node('summary', 'NWS forecast details'));
      if (!day.extended.length) detail.append(node('p', 'Extended forecast text unavailable for this date.', 'small muted'));
      const periods = day.extended.filter((period, index, all) => all.indexOf(period) === index);
      for (const period of periods) {
        detail.append(node('strong', period.name || 'NWS forecast period'));
        detail.append(node('p', period.detailedForecast || period.shortForecast || 'Description unavailable', 'small'));
        const chance = period.probabilityOfPrecipitation?.value;
        detail.append(node('p', finite(chance) ? 'Precipitation chance ' + round(chance) + '%' : 'Precipitation chance unavailable', 'forecast-chance'));
        detail.append(visuals.wind(periodWindSpeed(period), period.windDirection, { forecast: true }));
      }
      card.append(detail);
      const graphs = node('div', undefined, 'daily-forecast-graphs'); card.append(graphs); host.append(card);
      renderDailyGraphs(day, graphs);
    }
  }
  function accumulation(series, now) {
    if (!series || !Array.isArray(series.values)) return { text: 'Unavailable · NWS accumulation field not supplied' };
    const windowEnd = now + 24 * HOUR;
    const rows = series.values.map((row) => ({ ...interval(row.validTime), value: quantity({ value: row.value, unitCode: series.uom }, 'accumulation') }))
      .filter((row) => finite(row.start) && finite(row.end) && row.value !== null && row.value >= 0 && row.start >= now && row.end <= windowEnd)
      .sort((a, b) => a.start - b.start);
    if (!rows.length) return { text: 'Unavailable · no complete provided accumulation intervals inside the next 24 hours' };
    if (rows.some((row, i) => i > 0 && row.start < rows[i - 1].end)) return { text: 'Unavailable · overlapping NWS accumulation intervals cannot be safely totaled' };
    const coverage = rows.reduce((sum, row) => sum + row.end - row.start, 0);
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const partial = coverage < 24 * HOUR - 1000;
    return { text: (total > 0 && total < .01 ? '<0.01' : round(total, 2)) + ' in · ' + (partial ? 'PARTIAL coverage: ' + round(coverage / HOUR, 1) + ' of 24 hours; remaining time unknown' : 'provided 24-hour coverage'),
      span: stamp(rows[0].start) + ' → ' + stamp(rows[rows.length - 1].end), intervals: rows.length };
  }
  function renderAccumulations() {
    const envelope = resource('grid'), p = envelope.data?.properties;
    const now = Date.now();
    const snow = envelope.status === 'unavailable' ? { text: 'Unavailable' } : accumulation(p?.snowfallAmount, now);
    const ice = envelope.status === 'unavailable' ? { text: 'Unavailable' } : accumulation(p?.iceAccumulation, now);
    text('liveSnow', (envelope.status === 'stale' ? 'STALE · ' : '') + snow.text);
    text('liveIce', (envelope.status === 'stale' ? 'STALE · ' : '') + ice.text);
  }
  function alertId(value) {
    if (typeof value !== 'string') return '';
    const id = value.includes('/alerts/') ? value.split('/alerts/').pop() : value;
    try { return decodeURIComponent(id); } catch { return id; }
  }
  function activeAlertFeatures() {
    const envelope = resource('alerts');
    const features = Array.isArray(envelope.data?.features) ? envelope.data.features : [];
    const canceled = new Set();
    for (const feature of features) {
      if (String(feature.properties?.messageType).toLowerCase() !== 'cancel') continue;
      const references = feature.properties.references;
      const items = Array.isArray(references) ? references : typeof references === 'string' ? references.split(/\s+/) : [];
      for (const reference of items) {
        const ids = typeof reference === 'string' ? reference.split(/[,\s]+/) : [reference?.identifier, reference?.id];
        for (const id of ids) if (alertId(id)) canceled.add(alertId(id));
      }
    }
    return features.filter((feature) => {
      const p = feature.properties || {};
      if (String(p.messageType).toLowerCase() === 'cancel' || p.status && p.status !== 'Actual'
        || [feature.id, p.id, p['@id']].some((id) => canceled.has(alertId(id)))) return false;
      const times = [date(p.expires), date(p.ends)].filter((time) => time !== null);
      return !times.some((time) => time <= Date.now());
    });
  }
  function renderAlerts() {
    const host = byId('liveAlertsHost'); if (!host) return;
    const envelope = resource('alerts'), features = activeAlertFeatures();
    const section = byId('officialAlertsSection');
    if (section) section.hidden = !features.length;
    section?.closest('.priority-row')?.classList.toggle('has-active-alerts', features.length > 0);
    text('liveAlertsBadge', features.length + ' active');
    host.replaceChildren();
    for (const feature of features) {
      const p = feature.properties || {}, article = node('article', undefined, 'alert-example');
      article.append(node('span', (envelope.status === 'stale' ? 'STALE · ' : '') + 'OFFICIAL NWS ALERT', 'badge warning'));
      article.append(node('h3', p.event || 'NWS alert'));
      if (p.headline) article.append(node('p', p.headline, 'small'));
      article.append(node('p', 'Residence Inn Champaign · applicable NWS property alert' + (!feature.geometry ? ' · no polygon supplied; county/zone alert retained' : ''), 'small muted'));
      article.append(node('p', 'Effective: ' + stamp(p.effective) + ' · Expires: ' + stamp(p.expires), 'small'));
      const bulletin = sourceUrl(p['@id']) || sourceUrl(feature.id) || sourceUrl(p.web);
      article.append(bulletin ? sourceLink(bulletin, 'Read official bulletin') : node('p', 'Official bulletin link unavailable', 'small muted'));
      if (p.description || p.instruction) {
        const details = node('details'); details.append(node('summary', 'NWS bulletin text'));
        if (p.description) details.append(node('p', p.description, 'small'));
        if (p.instruction) details.append(node('p', p.instruction, 'small'));
        article.append(details);
      }
      host.append(article);
    }
    const availability = byId('liveAlertAvailability');
    if (availability) {
      const failedCheck = envelope.status === 'unavailable' || envelope.status === 'stale' && Boolean(envelope.error);
      availability.hidden = !opened || envelope.pending || !failedCheck;
      availability.textContent = availability.hidden ? '' : 'Official NWS alert status is unavailable.' + (envelope.status === 'stale' ? ' Cached alert data is stale after the latest check failed.' : '') + ' No all-clear is implied; check the official NWS bulletin source.';
    }
    if (alertExpiryTimer !== null) clearTimeout(alertExpiryTimer);
    alertExpiryTimer = null;
    const nextExpiry = features.flatMap((feature) => [date(feature.properties?.expires), date(feature.properties?.ends)]).filter((value) => value !== null && value > Date.now()).sort((a, b) => a - b)[0];
    if (opened && nextExpiry) alertExpiryTimer = setTimeout(() => { alertExpiryTimer = null; renderAlerts(); publishAlerts(); }, Math.min(2147483647, Math.max(1, nextExpiry - Date.now() + 25)));
  }
  function publishAlerts() {
    const envelope = resource('alerts');
    window.cmpriWeatherMap?.setAlerts?.(envelope);
    document.dispatchEvent(new CustomEvent('cmpri:official-weather-alerts', { detail: {
      status: envelope.status, checkedAt: envelope.receivedAt || checkedAt, source: envelope.source,
      error: envelope.error, alerts: Array.isArray(envelope.data?.features) ? envelope.data.features : []
    } }));
  }
  function render(part) {
    if (!part || part === 'observation') renderObservation();
    if (part === 'history') renderCurrentDial();
    if (!part || part === 'forecast') {
      renderForecast('hourly', byId('hourlyForecastCards') ? 'hourlyForecastCards' : 'hourlyForecast', true);
      renderDailyForecast(); renderCurrentDial();
      renderAccumulations();
    }
    if (!part || part === 'alerts') renderAlerts();
  }
  function getState() {
    return { initialized, opened, loading, pendingRequests: activeRequests.size, requests, checkedAt, error: lastError,
      resources: Object.fromEntries(Object.keys(RESOURCE_NAMES).map((key) => [key, resource(key).status])),
      observationTimestamp: resource('observation').data?.properties?.timestamp || null,
      observedExtremes, observedReports: observedReports.size, cachedForecastHours: forecastHours.size, cachedParts: Array.from(fetchedParts.keys()), cacheTtlMs: CACHE_TTL,
      activeAlerts: activeAlertFeatures().length, databaseCalls: 0, pushes: 0, scheduler: false };
  }
  function abortReads() {
    activeRequests.forEach((record) => { record.controller.abort(); clearTimeout(record.timeout); });
    activeRequests.clear(); pendingResources.clear();
  }
  async function readPart(part, ticket) {
    const names = PARTS[part], record = { controller: new AbortController(), timeout: null };
    record.timeout = setTimeout(() => record.controller.abort(), part === 'forecast' ? 40000 : 15000);
    activeRequests.set(part, record); requests += 1;
    try {
      const response = await fetch(ENDPOINT + '?part=' + part, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: record.controller.signal });
      if (!response.ok) throw new Error('NWS preview read returned HTTP ' + response.status);
      const result = await response.json();
      if (ticket !== generation || !opened) return;
      if (!result.resources || typeof result.resources !== 'object') throw new Error('Official NWS resources unavailable');
      for (const name of names) {
        const next = result.resources[name] || { status: 'unavailable', source: SOURCES[name] || null, data: null, error: 'Expected NWS resource was not returned.' };
        resources[name] = next.data ? next : resources[name]?.data ? { ...resources[name], status: 'stale', error: next.error || 'Latest read unavailable; displaying cached data.' } : next;
      }
      fetchedParts.set(part, Date.now());
      checkedAt = result.checkedAt || checkedAt;
    } catch (error) {
      if (ticket !== generation || !opened) return;
      const message = error.name === 'AbortError' ? 'NWS read timed out; reopen Weather to retry.' : error.message;
      lastError = message;
      for (const name of names) resources[name] = resources[name]?.data ? { ...resources[name], status: 'stale', error: message } : { status: 'unavailable', source: SOURCES[name] || null, data: null, error: message };
    } finally {
      clearTimeout(record.timeout);
      if (activeRequests.get(part) === record) activeRequests.delete(part);
      if (ticket === generation) {
        for (const name of names) pendingResources.delete(name);
        loading = activeRequests.size > 0;
        if (opened) { render(part); if (part === 'alerts') publishAlerts(); }
      }
    }
  }
  async function refresh(force = true) {
    if (!opened) return getState();
    const parts = Object.keys(PARTS).filter((part) => force || !fetchedParts.has(part) || Date.now() - fetchedParts.get(part) >= CACHE_TTL || PARTS[part].every((name) => !resources[name]?.data));
    if (!parts.length) return getState();
    const ticket = ++generation; abortReads();
    parts.forEach((part) => PARTS[part].forEach((name) => pendingResources.add(name)));
    loading = true; lastError = ''; render();
    await Promise.allSettled(parts.map((part) => readPart(part, ticket)));
    return getState();
  }
  async function refreshObservations() {
    if (!opened || document.hidden) return getState();
    const parts = ['observation', 'history'].filter((part) => !activeRequests.has(part) &&
      (!fetchedParts.has(part) || Date.now() - fetchedParts.get(part) >= CACHE_TTL));
    if (!parts.length) return getState();
    parts.forEach((part) => PARTS[part].forEach((name) => pendingResources.add(name)));
    loading = true;
    await Promise.allSettled(parts.map((part) => readPart(part, generation)));
    return getState();
  }
  function init() {
    if (initialized) return getState();
    initialized = true;
    if (typeof ResizeObserver === 'function') {
      const widths = new WeakMap(); let pending = false;
      const observer = new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const width = Math.round(entry.contentRect.width);
          if (widths.get(entry.target) !== width) { widths.set(entry.target, width); changed = true; }
        }
        if (changed && opened && !pending) {
          pending = true;
          requestAnimationFrame(() => { pending = false; resizeGraphs(); });
        }
      });
      for (const id of ['currentConditionsGraphs', 'hourlyForecast', 'extendedForecast']) if (byId(id)) observer.observe(byId(id));
    }
    render(); return getState();
  }
  function open() {
    init(); if (opened) return Promise.resolve(getState());
    opened = true; render(); publishAlerts(); return refresh(false);
  }
  function close() {
    opened = false; generation += 1; abortReads(); loading = false;
    if (alertExpiryTimer !== null) clearTimeout(alertExpiryTimer);
    alertExpiryTimer = null;
    astronomyDecoration?.close();
    return getState();
  }
  window.addEventListener('cmpri-weather-astronomy', () => { if (opened) decorateAstronomy(); });
  window.addEventListener('pagehide', close);
  window.nwsLiveView = { init, open, close, refresh, refreshObservations, getState };
}());
