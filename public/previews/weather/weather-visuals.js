/* Shared visual vocabulary for actual NWS values; no requests or inferred values.
 * Every air-temperature display uses this fixed Fahrenheit scale:
 * -15 white, 0 purple, 15 dark blue, 32 light blue, 50 green,
 * 70 yellow, 90 red, 110 brown. Values outside it keep their actual label.
 */
(function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const MIN = -15, MAX = 110;
  const STOPS = Object.freeze([
    { fahrenheit: -15, color: '#ffffff', name: 'white' },
    { fahrenheit: 0, color: '#a35bcb', name: 'purple' },
    { fahrenheit: 15, color: '#2449a3', name: 'dark blue' },
    { fahrenheit: 32, color: '#7cccf2', name: 'light blue' },
    { fahrenheit: 50, color: '#52ad68', name: 'green' },
    { fahrenheit: 70, color: '#f5d642', name: 'yellow' },
    { fahrenheit: 90, color: '#e44a3f', name: 'red' },
    { fahrenheit: 110, color: '#8b4d2a', name: 'brown' }
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
      root.title = 'Air temperature ' + formatNumber.format(fahrenheit) + '°F · fixed −15 to 110°F scale';
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

  window.cmpriWeatherVisuals = Object.freeze({ temperature, condition, wind, stops: STOPS, min: MIN, max: MAX, colorAt });
})();
