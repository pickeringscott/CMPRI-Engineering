/* Independent foreground astronomy read. Page-memory cache only; no polling. */
(function () {
  'use strict';
  const ENDPOINT = '/api/weather-preview/astronomy', TTL = 5 * 60000;
  let opened = false, generation = 0, record = null, cached = null, fetchedAt = null;
  let requests = 0, status = 'unavailable', error = '';
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  function time(value) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value ? Date.parse(value) : NaN;
    return finite(parsed) ? parsed : null;
  }
  function official(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname.endsWith('.noaa.gov') || url.hostname.endsWith('.nasa.gov') ||
          url.hostname === 'github.com' && /^\/cosinekitty\/astronomy(?:\/|$)/.test(url.pathname));
    } catch { return false; }
  }
  function getData() {
    const now = Date.now();
    const phase = cached?.moonPhase;
    const calculatedAt = time(phase?.calculatedAt);
    const moonPhase = phase && typeof phase.label === 'string' && phase.label.length <= 40 &&
      calculatedAt !== null && calculatedAt <= now + 5 * 60000 && now - calculatedAt <= 3600000 &&
      finite(phase.angle) && phase.angle >= 0 && phase.angle < 360 && finite(phase.illumination) && phase.illumination >= 0 && phase.illumination <= 1
      ? phase : null;
    const events = (Array.isArray(cached?.events) ? cached.events : []).slice(0, 20).filter((event) => {
      const start = time(event?.start), end = time(event?.end);
      return ['solar-eclipse', 'lunar-eclipse', 'aurora'].includes(event?.type) && typeof event.title === 'string' &&
        event.title.length > 0 && event.title.length <= 120 && start !== null && end !== null && end > start && end > now &&
        start <= now + 7 * 86400000 && official(event.sourceUrl) &&
        (event.type !== 'aurora' || status === 'live' && start <= now + 90 * 60000 && end - start <= 2 * 3600000);
    });
    return { moonPhase, events, aurora: cached?.aurora || { status: 'unavailable' }, status };
  }
  function getState() {
    return { opened, status, error, pendingRequests: record ? 1 : 0, requests, fetchedAt, cacheTtlMs: TTL,
      events: getData().events.length, databaseCalls: 0, scheduler: false, backgroundPolling: false };
  }
  function publish() { window.dispatchEvent(new CustomEvent('cmpri-weather-astronomy', { detail: getState() })); }
  async function open() {
    opened = true;
    if (document.hidden || record) return getState();
    if (cached && status === 'live' && Date.now() - fetchedAt < TTL) { publish(); return getState(); }
    const ticket = ++generation;
    const current = { controller: new AbortController(), timeout: null };
    current.timeout = setTimeout(() => current.controller.abort(), 15000);
    record = current; requests += 1; error = '';
    publish();
    try {
      const response = await fetch(ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: current.controller.signal });
      if (!response.ok) throw new Error('Astronomy read returned HTTP ' + response.status);
      const body = await response.json(), resource = body?.resources?.astronomy;
      if (ticket !== generation || !opened) return getState();
      if (!resource?.data || !['live', 'stale'].includes(resource.status)) throw new Error(resource?.error || 'Astronomy data unavailable');
      cached = resource.data; fetchedAt = Date.now(); status = resource.status;
    } catch (failure) {
      if (ticket !== generation || !opened) return getState();
      status = cached ? 'stale' : 'unavailable'; error = failure.name === 'AbortError' ? 'Astronomy read timed out' : failure.message;
    } finally {
      clearTimeout(current.timeout);
      if (record === current) record = null;
      if (ticket === generation && opened) publish();
    }
    return getState();
  }
  function close() {
    opened = false; generation += 1;
    if (record) { record.controller.abort(); clearTimeout(record.timeout); record = null; }
    return getState();
  }
  window.addEventListener('pagehide', close);
  window.cmpriWeatherAstronomyFeed = Object.freeze({ open, close, getData, getState });
}());
