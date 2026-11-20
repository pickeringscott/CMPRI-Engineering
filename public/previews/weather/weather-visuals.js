/* Local weather data visuals; no requests or theme-palette dependency.
 * Hard-coded Fahrenheit colors approximate the user's reference screenshots.
 * They are not an authoritative reconstruction of the reference app's formula.
 * Numeric values always retain their actual value, including outside the ramp.
 */
(function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const MIN = -15, MAX = 110;
  const STOPS = Object.freeze([
    { fahrenheit: -15, color: '#00e7e5', name: 'cyan' },
    { fahrenheit: 0, color: '#00e7e5', name: 'cyan' },
    { fahrenheit: 5, color: '#23cef0', name: 'cyan blue' },
    { fahrenheit: 10, color: '#4baff6', name: 'sky blue' },
    { fahrenheit: 15, color: '#7784fa', name: 'periwinkle' },
    { fahrenheit: 20, color: '#a25afa', name: 'violet' },
    { fahrenheit: 25, color: '#c336ef', name: 'purple' },
    { fahrenheit: 32, color: '#e000ee', name: 'magenta' },
    { fahrenheit: 34, color: '#5600ee', name: 'deep violet' },
    { fahrenheit: 40, color: '#1700f5', name: 'deep blue' },
    { fahrenheit: 45, color: '#0065fb', name: 'blue' },
    { fahrenheit: 50, color: '#00b7ed', name: 'cyan blue' },
    { fahrenheit: 55, color: '#1beac5', name: 'mint' },
    { fahrenheit: 63, color: '#9bff54', name: 'lime green' },
    { fahrenheit: 70, color: '#d8ff13', name: 'yellow green' },
    { fahrenheit: 80, color: '#ffcc00', name: 'yellow' },
    { fahrenheit: 85, color: '#ff8900', name: 'orange' },
    { fahrenheit: 88, color: '#ff5b00', name: 'orange red' },
    { fahrenheit: 95, color: '#f40818', name: 'red' },
    { fahrenheit: 106, color: '#e92b95', name: 'hot pink' },
    { fahrenheit: 110, color: '#e92b95', name: 'hot pink' }
  ].map(Object.freeze));
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const position = (value) => (Math.max(MIN, Math.min(MAX, value)) - MIN) / (MAX - MIN) * 100;
  const gradient = 'linear-gradient(to right, ' + STOPS.map((stop) => stop.color + ' ' + position(stop.fahrenheit) + '%').join(', ') + ')';
  const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const compassPoints = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function shape(host, tag, attributes) {
    const result = document.createElementNS(SVG, tag);
    Object.entries(attributes).forEach(([name, value]) => result.setAttribute(name, String(value)));
    host.append(result);
    return result;
  }

  function colorAt(fahrenheit) {
    if (!finite(fahrenheit)) return null;
    const value = Math.max(MIN, Math.min(MAX, fahrenheit));
    const right = STOPS.findIndex((stop) => value <= stop.fahrenheit);
    if (right === 0) return STOPS[0].color;
    const low = STOPS[right - 1], high = STOPS[right];
    const ratio = (value - low.fahrenheit) / (high.fahrenheit - low.fahrenheit);
    const channels = [1, 3, 5].map((offset) => {
      const a = parseInt(low.color.slice(offset, offset + 2), 16);
      const b = parseInt(high.color.slice(offset, offset + 2), 16);
      return Math.round(a + (b - a) * ratio).toString(16).padStart(2, '0');
    });
    return '#' + channels.join('');
  }

  function temperature(fahrenheit) {
    const known = finite(fahrenheit);
    const root = node('span', 'wv-temperature');
    root.dataset.airTemperature = known ? String(fahrenheit) : 'unknown';
    root.dataset.scaleMin = String(MIN);
    root.dataset.scaleMax = String(MAX);
    root.setAttribute('aria-label', known ? 'Air temperature ' + formatNumber.format(fahrenheit) + ' degrees Fahrenheit' : 'Air temperature unavailable');
    root.append(node('strong', 'wv-temperature-value', known ? formatNumber.format(fahrenheit) + '°F' : '—'));

    const scale = node('span', 'wv-temperature-scale');
    scale.setAttribute('aria-hidden', 'true');
    const track = node('span', 'wv-temperature-track');
    track.style.background = gradient;
    if (known) {
      const color = colorAt(fahrenheit);
      root.dataset.temperatureColor = color;
      root.style.setProperty('--wv-temperature-color', color);
      const marker = node('span', 'wv-temperature-marker');
      marker.style.left = position(fahrenheit) + '%';
      track.append(marker);
      root.title = 'Air temperature ' + formatNumber.format(fahrenheit) + '°F · fixed reference colors, independent of the CMPRI theme';
    } else {
      root.classList.add('wv-unavailable');
      root.title = 'Air temperature unavailable';
    }
    const limits = node('span', 'wv-temperature-limits');
    limits.append(node('span', '', '−15'), node('span', '', '110°F'));
    scale.append(track, limits);
    root.append(scale);
    return root;
  }

  const HOUR = 3600000;
  const centralParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short'
  });
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
  function timeValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const result = typeof value === 'number' ? value : Date.parse(value);
    return finite(result) ? result : null;
  }
  function clockParts(time) {
    return Object.fromEntries(centralParts.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  }
  function dayKey(time) {
    const value = timeValue(time); if (value === null) return null;
    const parts = clockParts(value);
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function clockLabel(time) {
    const parts = clockParts(time);
    return parts.hour + ':' + parts.minute + ' ' + parts.timeZoneName;
  }
  function nextDay(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  }
  function midnight(key) {
    const target = Date.parse(key + 'T00:00:00Z');
    let guess = target + 6 * HOUR;
    // Resolve Central midnight rather than assuming every local day is 24 elapsed hours.
    for (let i = 0; i < 3; i += 1) {
      const p = clockParts(guess);
      const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      guess += target - local;
    }
    return guess;
  }
  function periodSpan(period) {
    const start = timeValue(period.startTime), end = timeValue(period.endTime);
    return start !== null && end !== null && end > start ? { start, end } : null;
  }
  function forecastDays(hourlyPeriods = [], extendedPeriods = []) {
    const days = new Map();
    function cover(period, hourly) {
      const span = periodSpan(period); if (!span) return;
      let key = dayKey(span.start);
      // Official forecasts cover roughly a week. Bound malformed input without creating an unbounded loop.
      for (let count = 0; count < 16; count += 1) {
        const start = midnight(key), end = midnight(nextDay(key));
        if (start >= span.end) break;
        if (!days.has(key)) days.set(key, { key, start, end, label: dayLabel.format(new Date(start + 12 * HOUR)), hourly: [], extended: [] });
        const day = days.get(key);
        if (hourly) {
          if (finite(period.fahrenheit)) day.hourly.push({ ...period, start: Math.max(start, span.start), end: Math.min(end, span.end), sampleTime: span.start });
        } else day.extended.push(period);
        key = nextDay(key);
      }
    }
    extendedPeriods.forEach((period) => cover(period, false));
    hourlyPeriods.forEach((period) => cover(period, true));
    return Array.from(days.values()).sort((a, b) => a.start - b.start).map((day) => {
      let previousEnd = day.start;
      const segments = [], occurrences = new Map();
      const samples = day.hourly.sort((a, b) => a.start - b.start).filter((period) => dayKey(period.sampleTime) === day.key);
      for (const period of day.hourly) {
        let start = Math.max(previousEnd, period.start);
        while (start < period.end) {
          const end = Math.min(period.end, start + HOUR);
          const p = clockParts(start), minute = Number(p.hour) * 60 + Number(p.minute);
          const minuteEnd = Math.min(1440, minute + (end - start) / 60000);
          const occurrence = occurrences.get(minute) || 0;
          occurrences.set(minute, occurrence + 1);
          segments.push({ start, end, minute, minuteEnd, fahrenheit: period.fahrenheit, label: clockLabel(start), repeated: occurrence > 0 });
          start = end;
        }
        previousEnd = Math.max(previousEnd, period.end);
      }
      const coverage = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
      const expectedHours = (day.end - day.start) / HOUR;
      const high = samples.reduce((best, sample) => !best || sample.fahrenheit > best.fahrenheit ? sample : best, null);
      const low = samples.reduce((best, sample) => !best || sample.fahrenheit < best.fahrenheit ? sample : best, null);
      return { ...day, segments, high, low, expectedHours, coverageHours: coverage / HOUR,
        partial: coverage < day.end - day.start - 1000,
        clockChange: expectedHours === 23 ? '23-hour Central day · 02:00 skipped' : expectedHours === 25 ? '25-hour Central day · 01:00 repeats; inset track shows the second hour' : '' };
    });
  }
  function dialPoint(minute, radius) {
    const angle = (120 + minute / 1440 * 300) * Math.PI / 180;
    return { x: 100 + Math.cos(angle) * radius, y: 99 + Math.sin(angle) * radius };
  }
  function dialArc(start, end, radius) {
    const a = dialPoint(start, radius), b = dialPoint(end, radius);
    return 'M' + a.x.toFixed(3) + ' ' + a.y.toFixed(3) + 'A' + radius + ' ' + radius + ' 0 ' + (end - start > 864 ? '1' : '0') + ' 1 ' + b.x.toFixed(3) + ' ' + b.y.toFixed(3);
  }
  function temperatureDial(day, { observedTemperature = null, current = false, pending = false, stale = false } = {}) {
    const root = node('div', 'wv-temperature-dial');
    root.dataset.day = day?.key || '';
    root.dataset.coverage = day?.segments.length ? day.partial ? 'partial' : 'complete' : 'unavailable';
    root.dataset.coverageHours = String(day?.coverageHours || 0);
    root.dataset.expectedHours = String(day?.expectedHours || 24);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 200 190');
    svg.setAttribute('class', 'wv-dial-ring');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    shape(svg, 'path', { d: dialArc(0, 1440, 73), class: 'wv-dial-track' });
    for (const segment of day?.segments || []) {
      const arc = shape(svg, 'path', { d: dialArc(segment.minute, segment.minuteEnd, segment.repeated ? 62 : 73), class: 'wv-dial-segment', stroke: colorAt(segment.fahrenheit) });
      arc.dataset.startTime = new Date(segment.start).toISOString(); arc.dataset.clockTime = segment.label;
      arc.dataset.airTemperature = String(segment.fahrenheit); arc.dataset.repeatedHour = String(segment.repeated);
      const title = shape(arc, 'title', {}); title.textContent = segment.label + ' · ' + formatNumber.format(segment.fahrenheit) + '°F forecast';
    }
    [0, 360, 720, 1080, 1440].forEach((minute) => {
      const point = dialPoint(minute, 91);
      const label = shape(svg, 'text', { x: point.x, y: point.y + 3, 'text-anchor': 'middle', class: 'wv-dial-clock' });
      label.textContent = String(minute / 60).padStart(2, '0');
    });
    const extrema = node('div', 'wv-dial-extrema');
    [['H', day?.high], ['L', day?.low]].forEach(([kind, sample]) => {
      const item = node('span', 'wv-dial-extreme'); item.dataset.extreme = kind;
      const known = sample && finite(sample.fahrenheit);
      if (known) {
        const time = clockParts(sample.sampleTime), minute = Number(time.hour) * 60 + Number(time.minute);
        const repeated = day.segments.find((segment) => segment.start === sample.sampleTime)?.repeated;
        const sameTime = kind === 'L' && day.high?.sampleTime === sample.sampleTime;
        const point = dialPoint(minute, repeated || sameTime ? 60 : 73);
        const mark = shape(svg, 'g', { class: 'wv-dial-marker' });
        mark.dataset.extreme = kind; mark.dataset.sampleTime = new Date(sample.sampleTime).toISOString();
        shape(mark, 'circle', { cx: point.x, cy: point.y, r: 7.5, fill: colorAt(sample.fahrenheit) });
        const label = shape(mark, 'text', { x: point.x, y: point.y + 2.7, 'text-anchor': 'middle' }); label.textContent = kind;
        const markerTitle = shape(mark, 'title', {}); markerTitle.textContent = kind + ' ' + formatNumber.format(sample.fahrenheit) + '°F at ' + clockLabel(sample.sampleTime) + ' · provided hourly forecast';
        const value = node('strong', 'wv-dial-extreme-value', kind + ' ' + formatNumber.format(sample.fahrenheit) + '°F');
        value.style.setProperty('--wv-temperature-color', colorAt(sample.fahrenheit));
        item.append(value, node('time', 'wv-dial-extreme-time', clockLabel(sample.sampleTime)));
        item.querySelector('time').dateTime = new Date(sample.sampleTime).toISOString();
      } else item.append(node('strong', 'wv-dial-extreme-value', kind + ' —'), node('span', 'wv-dial-extreme-time', 'Time unavailable'));
      extrema.append(item);
    });
    const face = node('div', 'wv-dial-face'); face.append(svg);
    const center = node('div', 'wv-dial-center');
    if (current) {
      const known = finite(observedTemperature);
      const value = node('strong', 'wv-temperature-value', known ? formatNumber.format(observedTemperature) + '°F' : '—');
      value.dataset.airTemperature = known ? String(observedTemperature) : 'unknown';
      if (known) value.style.setProperty('--wv-temperature-color', colorAt(observedTemperature));
      center.append(value, node('span', 'wv-dial-center-label', 'KCMI observed'));
    } else center.append(node('span', 'wv-dial-center-label', '24-hour'), node('strong', 'wv-dial-center-title', 'forecast'));
    face.append(center); root.append(face, extrema);
    const hasData = Boolean(day?.segments.length);
    const coverage = pending && !hasData ? 'Hourly forecast loading' : !hasData ? 'Hourly timeline unavailable' : (stale ? 'STALE · ' : '') + (day.partial ? 'Partial · ' : '') + formatNumber.format(day.coverageHours) + '/' + day.expectedHours + ' h supplied';
    root.append(node('p', 'wv-dial-coverage', coverage));
    root.append(node('p', 'wv-dial-caption', current ? 'Ring: today’s forecast · Central time' : 'Hourly forecast · Central time'));
    if (day?.partial && hasData) root.append(node('p', 'wv-dial-limit', 'H/L: supplied hours only · gaps unknown'));
    if (day?.clockChange) root.append(node('p', 'wv-dial-limit', day.clockChange));
    root.setAttribute('aria-label', (current ? 'Current observed temperature and today’s' : day?.label || 'Daily') + ' forecast temperature timeline. ' + coverage + '. ' + (day?.clockChange || ''));
    return root;
  }

  function iconCodes(icon) {
    if (typeof icon !== 'string') return [];
    return icon.split(/[/?]/).filter((part) => /^[a-z_]+(?:,\d+)?$/i.test(part)).map((part) => part.split(',')[0].toLowerCase());
  }

  function conditionType(description, codes) {
    const text = description.toLowerCase();
    if (/thunder|tstm|tornado/.test(text) || codes.some((code) => /^(tsra|tsra_sct|tsra_hi|tornado)$/.test(code))) return 'thunder';
    if (/snow|flurr|blizzard|sleet|ice pellets|freezing (rain|drizzle)|wintry/.test(text) || codes.some((code) => /snow|sleet|fzra|blizzard/.test(code))) return 'snow';
    if (/rain|drizzle|showers/.test(text) || codes.some((code) => /^rain/.test(code))) return 'rain';
    if (/fog|mist|haze|smoke|dust/.test(text) || codes.some((code) => /^(fog|haze|smoke|dust)$/.test(code))) return 'fog';
    if (/wind|breezy|hurricane|tropical storm/.test(text) || codes.some((code) => /^wind_|^(hurricane|tropical_storm)$/.test(code))) return 'wind';
    if (/cloud|overcast|mostly sunny|mostly clear/.test(text) || codes.some((code) => /^(few|sct|bkn|ovc)$/.test(code))) return 'cloud';
    if (/sunny|clear|fair/.test(text) || codes.includes('skc')) return 'sun';
    return 'unknown';
  }

  function drawSun(host, small) {
    const x = small ? 45 : 32, y = small ? 14 : 24, radius = small ? 7 : 10;
    const rays = [];
    for (let i = 0; i < 8; i += 1) {
      const angle = i * Math.PI / 4;
      const start = radius + 4, end = radius + (small ? 7 : 9);
      rays.push('M' + (x + Math.cos(angle) * start) + ' ' + (y + Math.sin(angle) * start) + 'L' + (x + Math.cos(angle) * end) + ' ' + (y + Math.sin(angle) * end));
    }
    shape(host, 'path', { d: rays.join(' '), class: 'wv-sun-rays' });
    shape(host, 'circle', { cx: x, cy: y, r: radius, class: 'wv-sun' });
  }

  function drawMoon(host, small) {
    const group = shape(host, 'g', { transform: small ? 'translate(25 -5) scale(.72)' : 'translate(8 1)' });
    shape(group, 'path', { d: 'M34 7A17 17 0 1 0 47 33A18 18 0 0 1 34 7Z', class: 'wv-moon' });
    shape(group, 'path', { d: 'M43 8v6M40 11h6', class: 'wv-star' });
  }

  function drawCloud(host) {
    shape(host, 'path', { d: 'M16 33h31a10 10 0 0 0 0-20c-1.5 0-3 .3-4.2.8A14 14 0 0 0 16 19a7 7 0 0 0 0 14Z', class: 'wv-cloud' });
  }

  function drawWind(host) {
    shape(host, 'path', { d: 'M8 17h31c10 0 10-12 2-12-5 0-6 3-6 5M5 25h43c10 0 11-12 4-13M12 33h24c10 0 10 10 3 10-4 0-5-3-5-4', class: 'wv-wind-lines' });
  }

  function condition(description, { icon, isDaytime } = {}) {
    const supplied = typeof description === 'string' ? description.trim() : '';
    const codes = iconCodes(icon);
    const kind = conditionType(supplied, codes);
    const daytime = typeof isDaytime === 'boolean' ? isDaytime : codes.includes('night') ? false : codes.includes('day') ? true : null;
    const labels = { sun: daytime === false ? 'Clear night' : 'Clear sky', cloud: 'Cloudy', rain: 'Rain', snow: 'Snow or ice', thunder: 'Thunderstorms', fog: 'Reduced visibility', wind: 'Windy', unknown: 'Conditions unavailable' };
    const label = supplied || labels[kind];
    const root = document.createElementNS(SVG, 'svg');
    root.setAttribute('viewBox', '0 0 64 48');
    root.setAttribute('class', 'wv-condition');
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', label);
    root.setAttribute('focusable', 'false');
    root.dataset.condition = kind;
    root.dataset.daytime = daytime === null ? 'unknown' : String(daytime);
    const title = shape(root, 'title', {});
    title.textContent = label;

    if (kind === 'sun') {
      if (daytime === false) drawMoon(root, false); else drawSun(root, false);
    } else if (kind === 'cloud') {
      if (/partly|mostly sunny|mostly clear/i.test(supplied) || codes.some((code) => /^(few|sct)$/.test(code))) {
        if (daytime === false) drawMoon(root, true); else drawSun(root, true);
      }
      drawCloud(root);
    } else if (kind === 'rain' || kind === 'snow' || kind === 'thunder' || kind === 'fog') {
      drawCloud(root);
      if (kind === 'rain') shape(root, 'path', { d: 'M20 37l-3 6M33 37l-3 6M46 37l-3 6', class: 'wv-rain' });
      if (kind === 'snow') [19, 34, 49].forEach((x) => shape(root, 'path', { d: 'M' + x + ' 36v9M' + (x - 4) + ' 38l8 5M' + (x - 4) + ' 43l8-5', class: 'wv-snow' }));
      if (kind === 'thunder') shape(root, 'path', { d: 'M35 25l-10 13h8l-3 10 16-17h-10l4-6Z', class: 'wv-lightning' });
      if (kind === 'fog') shape(root, 'path', { d: 'M11 35h36M18 40h36M8 45h32', class: 'wv-fog' });
    } else if (kind === 'wind') {
      drawWind(root);
    } else {
      shape(root, 'circle', { cx: 32, cy: 24, r: 17, class: 'wv-unknown-ring' });
      shape(root, 'path', { d: 'M27 18a5 5 0 0 1 10 0c0 4-5 4-5 8M32 32v1', class: 'wv-unknown-mark' });
    }
    return root;
  }

  function windDirection(value) {
    let degrees = null;
    if (finite(value)) degrees = value;
    if (typeof value === 'string') {
      const supplied = value.trim().toUpperCase();
      const index = compassPoints.indexOf(supplied);
      if (index !== -1) degrees = index * 22.5;
      else if (/^[+-]?\d+(?:\.\d+)?(?:°)?$/.test(supplied)) degrees = Number(supplied.replace('°', ''));
      else if (/^(VRB|VARIABLE)$/.test(supplied)) return { degrees: null, label: 'Variable' };
    }
    if (!finite(degrees)) return { degrees: null, label: '' };
    degrees = ((degrees % 360) + 360) % 360;
    return { degrees, label: compassPoints[Math.round(degrees / 22.5) % 16] };
  }

  function windText(value) {
    if (typeof value === 'string') return value.trim();
    return finite(value) ? String(value) : '';
  }

  function wind(speedText, direction, { forecast = false, gustText = null } = {}) {
    const speed = windText(speedText);
    const bearing = windDirection(direction);
    const calm = /^(?:0(?:\.0+)?\s*(?:mph|kt|knots|km\/h|m\/s)?|calm)$/i.test(speed);
    const root = node('span', 'wv-wind');
    root.dataset.windDirection = bearing.degrees === null ? 'unknown' : String(bearing.degrees);
    root.dataset.windConvention = 'from';
    if (!speed) root.classList.add('wv-unavailable');
    const compass = document.createElementNS(SVG, 'svg');
    compass.setAttribute('viewBox', '0 0 36 36');
    compass.setAttribute('class', 'wv-wind-compass');
    compass.setAttribute('aria-hidden', 'true');
    compass.setAttribute('focusable', 'false');
    shape(compass, 'circle', { cx: 18, cy: 20, r: 12, class: 'wv-wind-ring' });
    const north = shape(compass, 'text', { x: 18, y: 7, 'text-anchor': 'middle', class: 'wv-wind-north' });
    north.textContent = 'N';
    if (calm) {
      shape(compass, 'circle', { cx: 18, cy: 20, r: 3, class: 'wv-wind-calm' });
    } else if (speed && bearing.degrees !== null) {
      // NWS bearings name the source. A north wind points south into the compass.
      shape(compass, 'path', { d: 'M18 10v17M13 22l5 5 5-5', transform: 'rotate(' + bearing.degrees + ' 18 20)', class: 'wv-wind-arrow' });
    } else {
      shape(compass, 'path', { d: 'M14 16l8 8M22 16l-8 8', class: 'wv-wind-unknown' });
    }
    const copy = node('span', 'wv-wind-copy');
    const label = speed ? [calm ? '' : bearing.label, speed].filter(Boolean).join(' · ') : '—';
    const accessible = !speed ? 'Wind unavailable' : 'Wind ' + (!calm && bearing.label ? (bearing.label === 'Variable' ? 'variable, ' : 'from ' + bearing.label + ', ') : '') + speed;
    const value = node('span', 'wv-wind-value', label);
    value.setAttribute('aria-label', accessible);
    copy.append(value);
    const gust = windText(gustText);
    if (gust) copy.append(node('span', 'wv-wind-gust', (forecast ? 'Forecast gusts ' : 'Gusts ') + gust));
    root.title = accessible;
    root.append(compass, copy);
    return root;
  }

  window.cmpriWeatherVisuals = Object.freeze({ temperature, condition, wind, forecastDays, temperatureDial, dayKey, stops: STOPS, min: MIN, max: MAX, colorAt });
})();
