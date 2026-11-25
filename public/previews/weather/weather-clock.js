/* Display labels follow the account preference; date math stays in Central time. */
(function () {
  'use strict';
  const timeZone = 'America/Chicago';
  const legacyClock = new URLSearchParams(window.location.search).get('clock');
  const hour12 = () => window.cmpriTimeFormat ? window.cmpriTimeFormat.value === '12h' : legacyClock !== '24';
  const partsFormatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  function value(input) {
    if (input === null || input === undefined || input === '') return null;
    const result = typeof input === 'number' ? input : Date.parse(input);
    return Number.isFinite(result) ? result : null;
  }
  function parts(input) {
    const timestamp = value(input);
    return timestamp === null ? null : Object.fromEntries(partsFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  }
  function dayKey(input) {
    const p = parts(input); return p ? p.year + '-' + p.month + '-' + p.day : null;
  }
  function format(input, fields = {}) {
    const timestamp = value(input); if (timestamp === null) return 'Unavailable';
    const clock = window.cmpriTimeFormat?.options() || { hour: hour12() ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: hour12() ? 'h12' : 'h23' };
    return new Intl.DateTimeFormat('en-US', { timeZone, ...clock, ...fields }).format(new Date(timestamp));
  }
  function time(input, { zone = true, weekday = false } = {}) {
    return format(input, { ...(zone ? { timeZoneName: 'short' } : {}), ...(weekday ? { weekday: 'short' } : {}) });
  }
  function stamp(input) {
    const key = dayKey(input); return key ? key + ' ' + time(input) : 'Unavailable';
  }
  function axis(hour) {
    return hour12() ? String(hour % 12 || 12) + (hour % 24 < 12 ? ' AM' : ' PM') : String(hour).padStart(2, '0');
  }
  window.cmpriWeatherClock = Object.freeze({
    get hour12() { return hour12(); }, timeZone, format, time, stamp, parts, dayKey, axis,
    getState: () => ({ hour12: hour12(), timeZone, format: hour12() ? '12-hour' : '24-hour' }),
  });
}());
