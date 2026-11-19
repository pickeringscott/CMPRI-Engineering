/* Branch review: display the fixed property's actual NWS responses.
 * One foreground request per open/manual refresh. No database, geolocation,
 * notification permission, push delivery, or background scheduler is used.
 */
(function () {
  'use strict';
  const ENDPOINT = '/api/weather-preview';
  const HOUR = 3600000;
  const RESOURCE_NAMES = {
    points: 'Property point', forecast: 'Extended forecast', hourly: 'Hourly forecast',
    grid: 'Forecast grid / accumulations', stations: 'Nearby observation stations',
    observation: 'Current station observation', alerts: 'Official property alerts'
  };
  const central = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
  const hourTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', timeZoneName: 'short'
  });
  let initialized = false, opened = false, controller = null, timeout = null, generation = 0;
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
  function stamp(value) { const time = date(value); return time === null ? 'Unavailable' : central.format(new Date(time)); }
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
      data: null, error: value?.error || (loading ? 'Loading NWS response' : 'No usable NWS response') };
    return { ...value, status: ['live', 'stale'].includes(value.status) ? value.status : 'unavailable' };
  }
  function statusLabel(value) { return value.status === 'live' ? 'LIVE NWS RESPONSE' : value.status === 'stale' ? 'STALE NWS DATA' : loading ? 'LOADING' : 'UNAVAILABLE'; }
  function paragraphAfter(anchorId, id) {
    if (byId(id)) return byId(id);
    const anchor = byId(anchorId); if (!anchor) return null;
    const p = node('p', '', 'small muted'); p.id = id;
    anchor.insertAdjacentElement('afterend', p); return p;
  }
  function addProvenance(host, envelope, data, extra) {
    if (!host) return;
    host.replaceChildren(node('strong', statusLabel(envelope) + ' · '));
    host.append(sourceLink(envelope.source));
    const issue = data?.updated || data?.updateTime || envelope.sourceTimestamp;
    host.append(document.createTextNode(' · Issued/updated: ' + stamp(issue) +
      (data?.generatedAt ? ' · NWS generation time: ' + stamp(data.generatedAt) : '') +
      ' · Retrieved: ' + stamp(envelope.receivedAt || checkedAt) + (extra ? ' · ' + extra : '')));
    if (envelope.error) host.append(document.createTextNode(' · ' + envelope.error));
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
  function compass(value) {
    if (!finite(value)) return '';
    return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((value % 360) + 360) % 360 / 22.5) % 16];
  }
  function renderObservation() {
    const envelope = resource('observation'), p = envelope.data?.properties;
    const available = envelope.status !== 'unavailable' && p;
    const temperature = available ? quantity(p.temperature, 'temperature') : null;
    const feelsLike = available ? quantity(p.windChill, 'temperature') ?? quantity(p.heatIndex, 'temperature') : null;
    const wind = available ? quantity(p.windSpeed, 'wind') : null;
    const gust = available ? quantity(p.windGust, 'wind') : null;
    const visibility = available ? quantity(p.visibility, 'visibility') : null;
    text('liveTemperature', temperature === null ? 'Unavailable' : round(temperature) + '°F');
    text('liveFeelsLike', feelsLike === null ? 'Unavailable' : round(feelsLike) + '°F');
    text('liveWind', wind === null ? 'Unavailable' : [compass(p.windDirection?.value), round(wind) + ' mph'].filter(Boolean).join(' '));
    text('liveGusts', gust === null ? 'Unavailable' : round(gust) + ' mph');
    text('liveVisibility', visibility === null ? 'Unavailable' : (visibility > 0 && visibility < .1 ? '<0.1' : round(visibility, 1)) + ' mi');
    text('liveConditionText', available ? (p.textDescription || 'Condition description not reported') : 'Current conditions unavailable');
    text('liveObservationTime', statusLabel(envelope) + ' · Observed: ' + stamp(p?.timestamp));
    const host = byId('liveConditionSource');
    if (host) {
      const station = envelope.station;
      const stationId = station?.id || p?.station?.split('/').pop();
      const stationName = station?.name || stationId || 'Station not identified';
      const distance = finite(station?.distanceMeters) ? ' · ' + round(station.distanceMeters / 1609.344, 1) + ' mi from hotel' : '';
      host.replaceChildren(node('span', stationName + distance + ' · station observation, not a hotel sensor · '), sourceLink(envelope.source));
      if (envelope.error) host.append(document.createTextNode(' · ' + envelope.error));
    }
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
  function periodTemperature(period) {
    if (period.temperature && typeof period.temperature === 'object') {
      const value = quantity(period.temperature, 'temperature');
      return value === null ? 'Temperature unavailable' : round(value) + '°F';
    }
    return finite(period.temperature) && ['F', 'C'].includes(period.temperatureUnit)
      ? round(period.temperature) + '°' + period.temperatureUnit : 'Temperature unavailable';
  }
  function periodWind(period) {
    if (typeof period.windSpeed === 'string' && period.windSpeed) return [period.windDirection, period.windSpeed].filter(Boolean).join(' ');
    const speed = quantity(period.windSpeed, 'wind');
    return speed === null ? 'Wind unavailable' : [period.windDirection, round(speed) + ' mph'].filter(Boolean).join(' ');
  }
  function renderForecast(name, hostId, provenanceId, hourly) {
    const host = byId(hostId); if (!host) return;
    const envelope = resource(name), properties = envelope.data?.properties;
    const periods = Array.isArray(properties?.periods) ? properties.periods : [];
    host.replaceChildren();
    if (envelope.status === 'unavailable' || !periods.length) {
      host.append(node('p', (loading ? 'Loading official NWS forecast…' : 'Forecast unavailable. No sample values are substituted.'), 'small muted'));
    } else {
      const gridEnvelope = resource('grid');
      const grid = gridEnvelope.status === 'unavailable' ? null : gridEnvelope.data?.properties;
      periods.forEach((period) => {
        const card = node('article', undefined, 'forecast-card');
        const start = date(period.startTime), end = date(period.endTime);
        card.append(node('h3', hourly && start !== null ? hourTime.format(new Date(start)) : period.name || 'NWS forecast period'));
        card.append(node('strong', periodTemperature(period), 'forecast-temperature'));
        card.append(node('p', period.shortForecast || 'Forecast description unavailable', 'forecast-detail'));
        const chance = period.probabilityOfPrecipitation?.value;
        card.append(node('p', finite(chance) ? round(chance) + '% precip.' : 'Precipitation chance unavailable', 'forecast-chance'));
        card.append(node('p', periodWind(period), 'forecast-wind'));
        if (hourly) {
          const gust = gridAt(grid?.windGust, start, 'wind');
          const feels = gridAt(grid?.apparentTemperature, start, 'temperature');
          if (gust !== null) card.append(node('p', 'Forecast gusts ' + round(gust) + ' mph' + (gridEnvelope.status === 'stale' ? ' · STALE grid' : ''), 'forecast-wind'));
          if (feels !== null) card.append(node('p', 'Forecast feels like ' + round(feels) + '°F' + (gridEnvelope.status === 'stale' ? ' · STALE grid' : ''), 'forecast-wind'));
        }
        card.append(node('p', 'Valid: ' + stamp(start) + ' → ' + stamp(end), 'forecast-wind'));
        if (period.detailedForecast) {
          const detail = node('details'); detail.append(node('summary', 'NWS forecast text'));
          detail.append(node('p', period.detailedForecast, 'small')); card.append(detail);
        }
        if (envelope.status === 'stale') card.prepend(node('span', 'STALE FORECAST', 'badge warning'));
        host.append(card);
      });
    }
    const valid = periods.length ? 'Period coverage: ' + stamp(periods[0].startTime) + ' → ' + stamp(periods[periods.length - 1].endTime) : 'No forecast periods available';
    addProvenance(paragraphAfter(hostId, provenanceId), envelope, properties, valid);
    if (hourly) {
      const timing = paragraphAfter(hostId, 'nwsPrecipTiming');
      if (timing) {
        const future = periods.filter((p) => date(p.endTime) !== null && date(p.endTime) > Date.now());
        const next = future.find((p) => finite(p.probabilityOfPrecipitation?.value) && p.probabilityOfPrecipitation.value > 0);
        timing.textContent = envelope.status === 'unavailable' || !future.length ? 'Precipitation timing unavailable.' : next
          ? (envelope.status === 'stale' ? 'STALE forecast · ' : 'Forecast · ') + 'first provided hour with a precipitation chance: ' + stamp(next.startTime) + ' · ' + round(next.probabilityOfPrecipitation.value) + '% · ' + (next.shortForecast || 'Type not specified') + '. Hourly chance is guidance, not a precise arrival time.'
          : future.every((p) => finite(p.probabilityOfPrecipitation?.value)) ? 'Forecast · available hourly periods report 0% precipitation chance; this is not an official alert status or a guarantee of dry conditions.'
            : 'Precipitation timing unavailable for periods with missing precipitation chance.';
      }
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
    const anchor = byId('liveSnow')?.closest('section') || byId('liveSnow')?.parentElement;
    if (anchor && !byId('nwsAccumulationSource')) { const p = node('p', '', 'small muted'); p.id = 'nwsAccumulationSource'; anchor.append(p); }
    addProvenance(byId('nwsAccumulationSource'), envelope, p,
      'Forecast amounts, not observations · next 24h window: ' + stamp(now) + ' → ' + stamp(now + 24 * HOUR) +
      ' · Whole NWS intervals counted once; partial edge intervals are not prorated. ' +
      (snow.span ? 'Snow provided intervals: ' + snow.span + '. ' : '') + (ice.span ? 'Ice provided intervals: ' + ice.span + '.' : ''));
  }
  function renderAlerts() {
    const host = byId('liveAlertsHost'); if (!host) return;
    const envelope = resource('alerts'), features = envelope.data?.features;
    host.replaceChildren();
    if (envelope.status === 'unavailable' || !Array.isArray(features)) {
      host.append(node('strong', loading ? 'Loading official property alerts…' : 'Official alert status unknown', 'small'));
      host.append(node('p', 'NWS alert data is unavailable; no all-clear is implied.', 'small muted'));
    } else if (!features.length) {
      host.append(node('p', envelope.status === 'stale' ? 'STALE alert response · current alert status unknown. Last response contained no alerts.' :
        'No active alerts returned by NWS for the property at ' + stamp(envelope.receivedAt || checkedAt) + '.', 'small'));
    } else {
      features.forEach((feature) => {
        const p = feature.properties || {}, article = node('article', undefined, 'alert-example');
        const expired = date(p.expires) !== null && date(p.expires) <= Date.now();
        article.append(node('span', (envelope.status === 'stale' ? 'STALE · ' : '') + (expired ? 'EXPIRED · ' : '') + 'OFFICIAL NWS ALERT' + (p.status && p.status !== 'Actual' ? ' · ' + p.status.toUpperCase() : ''), 'badge warning'));
        article.append(node('h3', p.event || 'NWS alert'));
        if (p.headline) article.append(node('p', p.headline, 'small'));
        article.append(node('p', 'Residence Inn Champaign · NWS fixed-property point match' + (!feature.geometry ? ' · no polygon supplied; applicable county/zone alert retained' : '') + (p.areaDesc ? ' · ' + p.areaDesc : ''), 'small muted'));
        article.append(node('p', 'Effective: ' + stamp(p.effective) + ' · Expires: ' + stamp(p.expires) + (p.ends ? ' · Ends: ' + stamp(p.ends) : ''), 'small'));
        const bulletin = sourceUrl(p['@id']) || sourceUrl(feature.id) || sourceUrl(p.web);
        article.append(bulletin ? sourceLink(bulletin, 'Read official bulletin') : node('p', 'Official bulletin link unavailable', 'small muted'));
        if (p.description || p.instruction) {
          const details = node('details'); details.append(node('summary', 'NWS bulletin text'));
          if (p.description) details.append(node('p', p.description, 'small'));
          if (p.instruction) details.append(node('p', p.instruction, 'small'));
          article.append(details);
        }
        host.append(article);
      });
    }
    const provenance = node('p', '', 'small muted');
    addProvenance(provenance, envelope, null, 'Point query: 40.138080, −88.251416 · no notification or safety auto-open is triggered by this live display');
    host.append(provenance);
  }
  function renderDiagnostics() {
    const host = byId('liveFeedStatus'); if (!host) return;
    host.replaceChildren(node('p', loading ? 'Retrieving official NWS data for Residence Inn Champaign…' :
      'NWS request completed: ' + stamp(checkedAt) + (lastError ? ' · ' + lastError : ''), 'small'));
    const list = node('ul', undefined, 'guideline-list');
    Object.entries(RESOURCE_NAMES).forEach(([key, label]) => {
      const value = resource(key), item = node('li');
      item.append(node('strong', label + ' · ' + statusLabel(value) + ' · '), sourceLink(value.source));
      item.append(document.createTextNode(' · Source timestamp: ' + stamp(value.sourceTimestamp) +
        ' · Retrieved: ' + stamp(value.receivedAt) + (value.error ? ' · ' + value.error : '')));
      list.append(item);
    });
    host.append(list);
  }
  function render() {
    text('liveConditionsBadge', statusLabel(resource('observation')));
    text('liveAlertsBadge', statusLabel(resource('alerts')));
    renderObservation(); renderForecast('hourly', 'hourlyForecast', 'nwsHourlySource', true);
    renderForecast('forecast', 'extendedForecast', 'nwsExtendedSource', false);
    renderAccumulations(); renderAlerts(); renderDiagnostics();
    window.cmpriWeatherMap?.setAlerts?.(resource('alerts'));
    const button = byId('refreshNws'); if (button) button.disabled = loading || !opened;
  }
  function getState() {
    return { initialized, opened, loading, pendingRequests: controller ? 1 : 0, requests, checkedAt, error: lastError,
      resources: Object.fromEntries(Object.keys(RESOURCE_NAMES).map((key) => [key, resource(key).status])),
      databaseCalls: 0, pushes: 0, scheduler: false };
  }
  async function refresh() {
    if (!opened) return getState();
    controller?.abort(); if (timeout !== null) clearTimeout(timeout);
    const ticket = ++generation;
    const current = new AbortController(); controller = current;
    loading = true; resources = {}; lastError = ''; checkedAt = null; requests += 1; render();
    timeout = setTimeout(() => current.abort(), 45000);
    try {
      const response = await fetch(ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: current.signal });
      if (!response.ok) throw new Error('Weather preview API returned HTTP ' + response.status);
      const result = await response.json();
      if (ticket !== generation || !opened) return getState();
      if (!result.resources || typeof result.resources !== 'object') throw new Error('NWS response resources unavailable');
      resources = result.resources; checkedAt = result.checkedAt || new Date().toISOString();
    } catch (error) {
      if (ticket !== generation || !opened) return getState();
      lastError = error.name === 'AbortError' ? 'NWS request timed out; retry manually.' : error.message;
      resources = {}; checkedAt = new Date().toISOString();
    } finally {
      if (ticket === generation) {
        if (timeout !== null) clearTimeout(timeout);
        timeout = null; controller = null; loading = false;
        if (opened) render();
      }
    }
    return getState();
  }
  function init() {
    if (initialized) return getState();
    initialized = true;
    byId('refreshNws')?.addEventListener('click', () => { void refresh(); });
    render(); return getState();
  }
  function open() {
    init(); if (opened) return Promise.resolve(getState());
    opened = true; return refresh();
  }
  function close() {
    opened = false; generation += 1; controller?.abort(); controller = null;
    if (timeout !== null) clearTimeout(timeout); timeout = null; loading = false;
    const button = byId('refreshNws'); if (button) button.disabled = true;
    return getState();
  }
  window.addEventListener('pagehide', close);
  window.nwsLiveView = { init, open, close, getState };
}());
