/* A display preference only. The host sets clock=24 for the Chief Engineer. */
(function () {
  'use strict';
  const timeZone = 'America/Chicago';
  const hour12 = new URLSearchParams(window.location.search).get('clock') !== '24';
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
  function time(input, { zone = true, weekday = false } = {}) {
    const timestamp = value(input); if (timestamp === null) return 'Unavailable';
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', ...(hour12 ? { hour12: true } : { hourCycle: 'h23' }), ...(zone ? { timeZoneName: 'short' } : {}), ...(weekday ? { weekday: 'short' } : {}) }).format(new Date(timestamp));
  }
  function stamp(input) {
    const key = dayKey(input); return key ? key + ' ' + time(input) : 'Unavailable';
  }
  function axis(hour) {
    return hour12 ? String(hour % 12 || 12) + (hour % 24 < 12 ? ' AM' : ' PM') : String(hour).padStart(2, '0');
  }
  window.cmpriWeatherClock = Object.freeze({ hour12, timeZone, time, stamp, parts, dayKey, axis, getState: () => ({ hour12, timeZone, format: hour12 ? '12-hour' : '24-hour' }) });
}());
