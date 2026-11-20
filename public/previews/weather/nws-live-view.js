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
    observation: 'Current station observation', alerts: 'Official property alerts'
  };
  const central = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
  const hourTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', timeZoneName: 'short'
  });
  let initialized = false, opened = false, generation = 0, alertExpiryTimer = null;
  const activeRequests = new Map(), pendingResources = new Set();
  const PARTS = { observation: ['observation'], alerts: ['alerts'], forecast: ['points', 'forecast', 'hourly', 'grid'] };
  const SOURCES = { observation: 'https://api.weather.gov/stations/KCMI/observations/latest', alerts: 'https://api.weather.gov/alerts/active?point=40.138080,-88.251416', points: 'https://api.weather.gov/points/40.1381,-88.2514' };
  const observationClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
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
  function observationStamp(value) {
    const time = date(value); if (time === null) return 'unavailable';
    const parts = Object.fromEntries(observationClock.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
    return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ' ' + parts.timeZoneName;
  }
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
    return { ...value, pending: pendingResources.has(name), status: ['live', 'stale'].includes(value.status) ? value.status : 'unavailable' };
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
    const windChill = available ? quantity(p.windChill, 'temperature') : null;
    const heatIndex = available ? quantity(p.heatIndex, 'temperature') : null;
    const feelsLike = windChill ?? heatIndex;
    const wind = available ? quantity(p.windSpeed, 'wind') : null;
    const gust = available ? quantity(p.windGust, 'wind') : null;
    const visibility = available ? quantity(p.visibility, 'visibility') : null;
    const visuals = window.cmpriWeatherVisuals;
    renderCurrentDial();
    const condition = available ? (p.textDescription || 'Condition not reported') : envelope.pending ? 'Waiting for Willard observation' : 'Current conditions unavailable';
    byId('liveConditionIcon')?.replaceChildren(...(visuals ? [visuals.condition(condition, { icon: available ? p.icon : null })] : []));
    text('liveFeelsLike', feelsLike === null ? 'Not reported' : round(feelsLike) + '°F');
    if (byId('liveFeelsLike')) byId('liveFeelsLike').title = windChill !== null ? 'Reported KCMI wind chill' : heatIndex !== null ? 'Reported KCMI heat index' : 'KCMI did not report wind chill or heat index; no forecast is substituted.';
    const windHost = byId('liveWind');
    if (windHost) windHost.replaceChildren(visuals ? visuals.wind(wind === null ? null : round(wind) + ' mph', p?.windDirection?.value) : node('strong', wind === null ? 'Unavailable' : [compass(p.windDirection?.value), round(wind) + ' mph'].filter(Boolean).join(' ')));
    text('liveGusts', gust === null ? 'Not reported' : round(gust) + ' mph');
    text('liveVisibility', visibility === null ? 'Unavailable' : (visibility > 0 && visibility < .1 ? '<0.1' : round(visibility, 1)) + ' mi');
    text('liveConditionText', condition);
    text('liveObservationTime', 'As of: ' + observationStamp(p?.timestamp));
    text('liveConditionsBadge', envelope.status === 'stale' ? 'STALE KCMI' : available ? 'KCMI' : envelope.pending ? 'Awaiting KCMI' : 'Unavailable');
    const host = byId('liveConditionSource');
    if (host) {
      host.replaceChildren(node('span', 'Willard (KCMI) · station observation · '), sourceLink(envelope.source || SOURCES.observation));
      if (envelope.error && !envelope.pending) host.append(document.createTextNode(' · ' + envelope.error));
    }
  }
  function renderCurrentForecastGust() {
    const host = byId('liveForecastGusts'); if (!host) return;
    const gridEnvelope = resource('grid'), hourly = resource('hourly');
    const grid = gridEnvelope.status === 'unavailable' ? null : gridEnvelope.data?.properties;
    let when = Date.now(), gust = gridAt(grid?.windGust, when, 'wind');
    if (gust === null) {
      const next = hourly.data?.properties?.periods?.find((period) => date(period.startTime) >= when && date(period.startTime) <= when + HOUR);
      if (next) { when = date(next.startTime); gust = gridAt(grid?.windGust, when, 'wind'); }
    }
    host.hidden = gust === null;
    host.textContent = gust === null ? '' : (gridEnvelope.status === 'stale' ? 'STALE · ' : '') + 'Forecast gusts ' + round(gust) + ' mph';
    host.title = gust === null ? '' : 'NWS forecast valid at ' + stamp(when) + '; separate from reported KCMI gusts.';
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
    const observation = resource('observation'), hourly = resource('hourly');
    const observed = observation.status === 'unavailable' ? null : quantity(observation.data?.properties?.temperature, 'temperature');
    const visuals = window.cmpriWeatherVisuals;
    if (!visuals) { host.replaceChildren(node('strong', observed === null ? '—' : round(observed) + '°F')); return; }
    host.classList.add('current-temperature-dial');
    const today = visuals.dayKey(Date.now());
    const day = forecastDayModels().find((item) => item.key === today);
    host.replaceChildren(visuals.temperatureDial(day, { current: true, observedTemperature: observed, pending: hourly.pending, stale: hourly.status === 'stale' }));
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
        const card = node('article', undefined, 'forecast-card');
        const start = date(period.startTime), end = date(period.endTime);
        const visuals = window.cmpriWeatherVisuals;
        const heading = node('div', undefined, 'forecast-card-heading');
        heading.append(node('h3', hourly && start !== null ? hourTime.format(new Date(start)) : period.name || 'NWS forecast period'));
        if (visuals) heading.append(visuals.condition(period.shortForecast || 'Condition not provided', { icon: period.icon, isDaytime: period.isDaytime }));
        card.append(heading);
        const temperature = periodTemperatureValue(period);
        card.append(visuals ? visuals.temperature(temperature) : node('strong', temperature === null ? '—' : round(temperature) + '°F', 'forecast-temperature'));
        card.append(node('p', period.shortForecast || 'Forecast description unavailable', 'forecast-detail'));
        const chance = period.probabilityOfPrecipitation?.value;
        const chanceText = node('p', finite(chance) ? '☂ ' + round(chance) + '%' : 'Precipitation unavailable', 'forecast-chance');
        chanceText.title = 'Forecast precipitation chance'; card.append(chanceText);
        const gust = gridAt(grid?.windGust, start, 'wind');
        if (visuals) card.append(visuals.wind(periodWindSpeed(period), period.windDirection, { forecast: true, gustText: gust === null ? null : round(gust) + ' mph' + (gridEnvelope.status === 'stale' ? ' · STALE grid' : '') }));
        else card.append(node('p', [period.windDirection, periodWindSpeed(period) || 'Wind unavailable'].filter(Boolean).join(' '), 'forecast-wind'));
        if (hourly) {
          const feels = gridAt(grid?.apparentTemperature, start, 'temperature');
          if (feels !== null) card.append(node('p', 'Feels ' + round(feels) + '°F' + (gridEnvelope.status === 'stale' ? ' · STALE grid' : ''), 'forecast-wind'));
        }
        const valid = node('p', hourly ? (start === null ? 'Time unavailable' : hourTime.format(new Date(start))) : 'Valid ' + stamp(start), 'forecast-validity');
        valid.title = 'Forecast valid ' + stamp(start) + ' → ' + stamp(end); card.append(valid);
        if (period.detailedForecast) {
          const detail = node('details'); detail.append(node('summary', 'NWS forecast text'));
          detail.append(node('p', period.detailedForecast, 'small')); card.append(detail);
        }
        if (envelope.status === 'stale') card.prepend(node('span', 'STALE FORECAST', 'badge warning'));
        host.append(card);
      });
    }
    if (hourly) {
      let timing = byId('nwsPrecipTiming');
      if (!timing) { timing = node('p', '', 'timing small muted'); timing.id = 'nwsPrecipTiming'; host.insertAdjacentElement('afterend', timing); }
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
      heading.append(node('h3', day.label), visuals.condition(representative?.shortForecast || 'Conditions unavailable', { icon: representative?.icon, isDaytime: representative?.isDaytime }));
      card.append(heading, visuals.temperatureDial(day, { stale: hourly.status === 'stale', pending: hourly.pending }));
      if (envelope.status === 'stale') card.prepend(node('span', 'STALE DAILY FORECAST', 'badge warning'));
      if (representative) card.append(node('p', representative.shortForecast || 'Forecast description unavailable', 'forecast-detail'));
      // Only source-provided day/night values are called highs/lows. Timeline extrema come from the supplied hourly values above.
      if (daytime || night) {
        const values = node('div', undefined, 'wv-official-day-values');
        [[daytime, 'NWS day high'], [night, 'NWS night low']].forEach(([period, label]) => {
          if (!period) return;
          const row = node('span', undefined, 'wv-official-day-value'); row.append(node('span', label));
          row.append(visuals.temperature(periodTemperatureValue(period))); values.append(row);
        });
        card.append(values);
      }
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
      availability.hidden = !opened || envelope.pending || envelope.status !== 'unavailable';
      availability.textContent = availability.hidden ? '' : 'Official NWS alert status is unavailable. No all-clear is implied; check the official NWS bulletin source.';
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
    if (!part || part === 'forecast') {
      renderForecast('hourly', 'hourlyForecast', true);
      renderDailyForecast(); renderCurrentDial();
      renderAccumulations(); renderCurrentForecastGust();
    }
    if (!part || part === 'alerts') renderAlerts();
  }
  function getState() {
    return { initialized, opened, loading, pendingRequests: activeRequests.size, requests, checkedAt, error: lastError,
      resources: Object.fromEntries(Object.keys(RESOURCE_NAMES).map((key) => [key, resource(key).status])),
      observationTimestamp: resource('observation').data?.properties?.timestamp || null,
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
      for (const name of names) resources[name] = result.resources[name] || { status: 'unavailable', source: SOURCES[name] || null, data: null, error: 'Expected NWS resource was not returned.' };
      checkedAt = result.checkedAt || checkedAt;
    } catch (error) {
      if (ticket !== generation || !opened) return;
      const message = error.name === 'AbortError' ? 'NWS read timed out; reopen Weather to retry.' : error.message;
      lastError = message;
      for (const name of names) resources[name] = { status: 'unavailable', source: SOURCES[name] || null, data: null, error: message };
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
  async function refresh() {
    if (!opened) return getState();
    const ticket = ++generation; abortReads();
    Object.keys(RESOURCE_NAMES).forEach((name) => pendingResources.add(name));
    loading = true; lastError = ''; render();
    await Promise.allSettled(Object.keys(PARTS).map((part) => readPart(part, ticket)));
    return getState();
  }
  function init() {
    if (initialized) return getState();
    initialized = true;
    render(); return getState();
  }
  function open() {
    init(); if (opened) return Promise.resolve(getState());
    opened = true; return refresh();
  }
  function close() {
    opened = false; generation += 1; abortReads(); loading = false;
    if (alertExpiryTimer !== null) clearTimeout(alertExpiryTimer);
    alertExpiryTimer = null;
    return getState();
  }
  window.addEventListener('pagehide', close);
  window.nwsLiveView = { init, open, close, getState };
}());
