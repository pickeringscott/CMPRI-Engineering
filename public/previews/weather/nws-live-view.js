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
  const fetchedParts = new Map(), observedReports = new Map();
  let observedExtremes = null;
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
  function forecastDayModels() {
    const hourly = resource('hourly'), extended = resource('forecast');
    const hours = hourly.status === 'unavailable' ? [] : hourly.data?.properties?.periods;
    const days = extended.status === 'unavailable' ? [] : extended.data?.properties?.periods;
    return window.cmpriWeatherVisuals?.forecastDays(
      (Array.isArray(hours) ? hours : []).map((period) => ({ ...period, fahrenheit: periodTemperatureValue(period) })),
      Array.isArray(days) ? days : []
    ) || [];
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
    const day = forecastDayModels().find((item) => item.key === today);
    const wind = available ? quantity(p.windSpeed, 'wind') : null, gust = available ? quantity(p.windGust, 'wind') : null;
    const visibility = available ? quantity(p.visibility, 'visibility') : null;
    const feels = available ? quantity(p.windChill, 'temperature') ?? quantity(p.heatIndex, 'temperature') : null;
    host.replaceChildren(visuals.temperatureDial(day, { current: true, observedTemperature: observed, observedDay,
      pending: hourly.pending, stale: hourly.status === 'stale',
      conditionText: available ? p.textDescription || 'Condition not reported' : observation.pending ? 'Awaiting observation' : 'Conditions unavailable',
      icon: available ? p.icon : null, windSpeed: wind === null ? null : round(wind) + ' MPH', windDirection: p?.windDirection?.value,
      gustText: gust === null ? null : round(gust), visibility: visibility === null ? null : visibility > 0 && visibility < .1 ? '<0.1' : round(visibility, 1), feelsLike: feels }));
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
      card.append(detail); host.append(card);
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
      renderForecast('hourly', 'hourlyForecast', true);
      renderDailyForecast(); renderCurrentDial();
      renderAccumulations();
    }
    if (!part || part === 'alerts') renderAlerts();
  }
  function getState() {
    return { initialized, opened, loading, pendingRequests: activeRequests.size, requests, checkedAt, error: lastError,
      resources: Object.fromEntries(Object.keys(RESOURCE_NAMES).map((key) => [key, resource(key).status])),
      observationTimestamp: resource('observation').data?.properties?.timestamp || null,
      observedExtremes, observedReports: observedReports.size, cachedParts: Array.from(fetchedParts.keys()), cacheTtlMs: CACHE_TTL,
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
    return getState();
  }
  window.addEventListener('pagehide', close);
  window.nwsLiveView = { init, open, close, refresh, refreshObservations, getState };
}());
