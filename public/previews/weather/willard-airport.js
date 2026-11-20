/*
 * Compact London-style flight board adapted from Flight Board Card v1.4.0.
 * https://github.com/pmnilsson/flight-board-card
 * Pinned source: 09ba0438bb6af800478033c8cab556962955627b.
 * No Home Assistant code, airport database or fictional flight rows are included.
 *
 * MIT License
 *
 * Copyright (c) 2026 P-M Nilsson
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function () {
  'use strict';

  const instances = new WeakMap();
  const FLIGHT_SOURCE = '/api/willard-flights';
  const CACHE_MS = 60000;
  const flightData = { value: null, at: 0, day: null, pending: null, controller: null, generation: 0, requests: 0, consumers: new Set() };
  const TRACKER_SOURCE = 'https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9&compact=1';
  // compact=1 is the provider builder's own setting; its bottom banner remains.
  // https://avioadsb.org/js/widget-builder.js?v=b7f82c07f3 (verified 2026-11-20).
  const TRACKER_MARKUP = '<iframe src="https://avioadsb.org/embed/map?lat=40.03&amp;lon=-88.28&amp;zoom=9&amp;compact=1" width="100%" height="450" style="border:0;max-width:100%" title="Live flight tracker map by AvioADSB" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function centralDay() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  function sourceUrl(kind, value, allowWidget) {
    const fallback = 'https://www.avionio.com/en/airport/cmi/' + kind;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['www.avionio.com', 'avionio.com'].includes(url.hostname)
        && (url.pathname === '/en/airport/cmi/' + kind || (allowWidget && url.pathname === '/widget/en/cmi/' + kind)) ? url.href : fallback;
    } catch { return fallback; }
  }
  function boardResult(kind, input, prior) {
    const raw = input && typeof input === 'object' ? input : {};
    const rows = Array.isArray(raw.flights) ? raw.flights : null;
    const valid = rows && rows.every(row => row && typeof row === 'object'
      && typeof row.flight === 'string' && row.flight.trim());
    // An empty parse is unknown unless the source explicitly confirms no flights.
    if (raw.status === 'live' && valid && (rows.length > 0 || raw.explicitEmpty === true)) {
      return { status: 'live', flights: rows.map(row => ({ ...row })), empty: rows.length === 0,
        sourceUrl: sourceUrl(kind, raw.sourceUrl, true), retrievedAt: raw.retrievedAt || null,
        providerDate: raw.providerDate || null, error: null };
    }
    const error = typeof raw.error === 'string' && raw.error ? raw.error : 'Flight data unavailable';
    if (prior && Array.isArray(prior.flights)) return { ...prior, status: 'stale', error };
    return { status: 'unavailable', flights: null, empty: false, sourceUrl: sourceUrl(kind, raw.sourceUrl, true),
      retrievedAt: raw.retrievedAt || null, providerDate: raw.providerDate || null, error };
  }
  function notifyFlights(refreshing) {
    for (const consumer of flightData.consumers) consumer(flightData.value, refreshing === true);
  }
  function requestFlights(consumer) {
    flightData.consumers.add(consumer);
    const fresh = flightData.value && Date.now() - flightData.at < CACHE_MS && flightData.day === centralDay();
    consumer(flightData.value, !fresh);
    if (fresh || flightData.pending) return;
    const generation = ++flightData.generation;
    const controller = new AbortController();
    flightData.controller = controller;
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Flight request stopped');
      flightData.requests += 1;
      return fetch(FLIGHT_SOURCE, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    }).then(response => {
      if (!response.ok) throw new Error('Flight source unavailable (HTTP ' + response.status + ')');
      return response.json();
    }).then(body => {
      if (generation !== flightData.generation || controller.signal.aborted || !flightData.consumers.size) return;
      if (!body || body.airport !== 'KCMI' || body.timeZone !== 'America/Chicago' || !body.boards) throw new Error('Flight response could not be verified');
      const previous = flightData.value;
      flightData.value = Object.fromEntries(['arrivals', 'departures'].map(kind => [kind,
        boardResult(kind, body.boards[kind], previous && previous[kind])]));
      flightData.at = Date.now();
      flightData.day = centralDay();
      notifyFlights(false);
    }).catch(error => {
      if (generation !== flightData.generation || controller.signal.aborted || !flightData.consumers.size) return;
      const previous = flightData.value;
      flightData.value = Object.fromEntries(['arrivals', 'departures'].map(kind => [kind,
        boardResult(kind, { error: error instanceof Error ? error.message : 'Flight data unavailable' }, previous && previous[kind])]));
      flightData.at = Date.now();
      flightData.day = centralDay();
      notifyFlights(false);
    }).finally(() => {
      if (generation === flightData.generation) { flightData.pending = null; flightData.controller = null; }
    });
    flightData.pending = pending;
  }
  function releaseFlights(consumer) {
    flightData.consumers.delete(consumer);
    if (!flightData.consumers.size && flightData.pending) {
      flightData.generation += 1;
      flightData.controller?.abort();
      flightData.pending = null;
      flightData.controller = null;
    }
  }
  function board(kind) {
    const section = element('section', 'wa-flight-panel');
    section.setAttribute('data-willard-' + kind, '');
    const heading = element('h3', 'wa-flight-heading', kind === 'arrivals' ? 'Arrivals' : 'Departures');
    const status = element('p', 'wa-board-status', 'Flight data unavailable');
    status.setAttribute('aria-live', 'polite');
    const table = element('table', 'wa-flight-table');
    table.setAttribute('aria-label', 'Willard Airport ' + kind);
    const head = table.createTHead().insertRow();
    for (const label of ['Time', 'Flight', kind === 'arrivals' ? 'From' : 'To', 'Status']) {
      const cell = element('th', '', label);
      cell.scope = 'col';
      if (label === 'Time') cell.title = 'Provider-published Central time';
      head.append(cell);
    }
    const body = table.createTBody();
    const emptyCell = body.insertRow().insertCell();
    emptyCell.colSpan = 4;
    emptyCell.className = 'wa-unavailable';
    emptyCell.textContent = 'Flight data unavailable';
    const footer = element('p', 'wa-source');
    const link = element('a', '', 'Avionio');
    link.href = sourceUrl(kind);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const retrieved = element('span', '', 'Retrieved: unavailable');
    footer.append(link, document.createTextNode(' · '), retrieved);
    section.append(heading, status, table, footer);
    return { section, status, body, link, retrieved };
  }

  function create(details, options = {}) {
    if (!details || details.tagName !== 'DETAILS') throw new TypeError('Willard Airport requires a details element');
    if (instances.has(details)) return instances.get(details);
    const use24HourTime = options.use24HourTime === undefined
      ? window.cmpriWeatherClock?.hour12 === false : options.use24HourTime === true;
    const clockFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: use24HourTime ? '2-digit' : 'numeric', minute: '2-digit',
      ...(use24HourTime ? { hourCycle: 'h23' } : { hour12: true }), timeZoneName: 'short'
    });
    const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
    function publishedTime(value) {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return '—';
      if (use24HourTime) return value;
      const hour = Number(value.slice(0, 2));
      return (hour % 12 || 12) + value.slice(2) + (hour < 12 ? ' AM' : ' PM');
    }
    function publishedStatus(value) {
      if (typeof value !== 'string' || !value) return '—';
      return value.replace(/\b(?:[01]\d|2[0-3]):[0-5]\d\b(?!\s*[AP]M\b)/g, publishedTime);
    }
    function publishedDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
      const date = new Date(value + 'T12:00:00Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? dateFormat.format(date) : '';
    }
    function retrievedStamp(value) {
      if (!value || !Number.isFinite(Date.parse(value))) return 'unavailable';
      const date = new Date(value);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
      return day + ' ' + clockFormat.format(date);
    }
    details.classList.add('wa-airport');
    details.open = false;
    const content = element('div', 'wa-content');
    content.setAttribute('data-willard-airport', '');
    const london = element('div', 'wa-board');
    london.setAttribute('data-willard-board', '');
    london.dataset.style = 'london';
    london.dataset.timeFormat = use24HourTime ? '24h' : '12h';
    london.dataset.availability = 'unavailable';
    const header = element('div', 'wa-board-header');
    const airport = element('strong', 'wa-airport-code', 'CMI / KCMI');
    const clockGroup = element('div', 'wa-clock-group');
    const clockLabel = element('span', 'wa-clock-label', 'Central time');
    const clock = element('time', 'wa-clock');
    clock.setAttribute('data-willard-clock', '');
    clockGroup.append(clockLabel, clock);
    header.append(airport, clockGroup);
    const boards = element('div', 'wa-boards');
    const views = { arrivals: board('arrivals'), departures: board('departures') };
    boards.append(views.arrivals.section, views.departures.section);
    london.append(header, boards);
    const trackerHost = element('div', 'wa-tracker');
    trackerHost.setAttribute('data-willard-tracker', '');
    content.append(london, trackerHost);
    details.append(content);

    let active = false, destroyed = false, timer = null, tracker = null, running = false;
    let iframeNavigations = 0, iframeUnloads = 0, trackerStatus = 'not-requested';
    let lastDocumentLoadedAt = null, models = { arrivals: null, departures: null };
    const canRun = () => !destroyed && active && details.open && details.isConnected && !document.hidden;

    function renderFlights(snapshot, refreshing) {
      if (!canRun()) return;
      for (const kind of ['arrivals', 'departures']) {
        const view = views[kind], model = snapshot && snapshot[kind];
        const stale = model && (model.status === 'stale' || (refreshing && Array.isArray(model.flights)));
        const status = stale ? 'stale' : model?.status || (refreshing ? 'loading' : 'unavailable');
        models[kind] = model ? { ...model, status } : { status, flights: null };
        view.section.dataset.availability = status;
        view.status.textContent = status === 'loading' ? 'Loading flight data…'
          : status === 'stale' ? 'Last known · unverified'
          : status === 'live' ? publishedDate(model.providerDate) + (publishedDate(model.providerDate) ? ' · ' : '') + 'Central time'
          : 'Flight data unavailable';
        view.status.title = model?.error || '';
        view.body.replaceChildren();
        if (model && Array.isArray(model.flights) && model.flights.length) {
          for (const flight of model.flights) {
            const row = view.body.insertRow();
            row.dataset.flight = typeof flight.id === 'string' ? flight.id : flight.flight;
            const timeCell = row.insertCell();
            const time = element('time', 'wa-flight-time', publishedTime(flight.time));
            if (publishedDate(flight.date) && publishedTime(flight.time) !== '—') time.dateTime = flight.date + 'T' + flight.time;
            time.title = 'Provider-published Central time';
            timeCell.append(time);
            if (flight.date !== model.providerDate && publishedDate(flight.date)) timeCell.append(element('small', 'wa-flight-date', publishedDate(flight.date)));
            const flightCell = row.insertCell();
            flightCell.append(element('span', 'wa-flight-number', flight.flight));
            if (typeof flight.airline === 'string' && flight.airline) flightCell.append(element('small', 'wa-airline', flight.airline));
            const location = row.insertCell();
            location.append(element('span', '', typeof flight.location === 'string' && flight.location ? flight.location : '—'));
            if (typeof flight.iata === 'string' && flight.iata) location.append(element('small', 'wa-airport-iata', flight.iata));
            row.insertCell().textContent = publishedStatus(flight.status);
          }
        } else {
          const cell = view.body.insertRow().insertCell();
          cell.colSpan = 4;
          cell.className = 'wa-unavailable';
          cell.textContent = model?.empty ? 'No flights listed by source' : status === 'loading' ? 'Loading…' : 'Flight data unavailable';
        }
        view.link.href = sourceUrl(kind, model?.sourceUrl);
        view.retrieved.textContent = 'Retrieved: ' + retrievedStamp(model?.retrievedAt);
      }
      const statuses = Object.values(models).map(model => model.status);
      london.dataset.availability = statuses.every(status => status === 'live') ? 'live'
        : statuses.includes('stale') ? 'stale' : statuses.includes('live') ? 'partial'
        : statuses.includes('loading') ? 'loading' : 'unavailable';
    }
    renderFlights(null, false);
    function updateClock() {
      const now = new Date();
      clock.dateTime = now.toISOString();
      clock.textContent = clockFormat.format(now);
      clock.setAttribute('aria-label', 'Current Central time: ' + clock.textContent);
    }
    function stopClock() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }
    function startClock() {
      updateClock();
      if (timer !== null || !canRun()) return;
      // Display-only clock: no network request, flight check or notification.
      timer = setTimeout(() => { timer = null; if (canRun()) startClock(); }, 60000 - Date.now() % 60000 + 25);
    }
    function mountTracker() {
      if (tracker || !canRun()) return;
      const template = document.createElement('template');
      template.innerHTML = TRACKER_MARKUP;
      const frame = template.content.firstElementChild;
      const record = { frame, load: null, error: null };
      record.load = () => {
        if (tracker !== record || !canRun()) return;
        trackerStatus = 'document-loaded';
        // A cross-origin load event does not verify live aircraft coverage.
        lastDocumentLoadedAt = new Date().toISOString();
      };
      record.error = () => { if (tracker === record && canRun()) trackerStatus = 'unavailable'; };
      frame.addEventListener('load', record.load);
      frame.addEventListener('error', record.error);
      tracker = record;
      trackerStatus = 'loading';
      iframeNavigations += 1;
      trackerHost.append(frame);
    }
    function unmountTracker() {
      if (!tracker) return;
      const record = tracker;
      tracker = null;
      record.frame.removeEventListener('load', record.load);
      record.frame.removeEventListener('error', record.error);
      record.frame.remove();
      iframeUnloads += 1;
      trackerStatus = 'inactive';
    }
    function sync() {
      if (canRun()) {
        startClock(); mountTracker();
        if (!running) { running = true; requestFlights(renderFlights); }
      } else {
        stopClock(); unmountTracker();
        if (running) { running = false; releaseFlights(renderFlights); }
      }
    }
    function pageHide() { active = false; sync(); }
    details.addEventListener('toggle', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', pageHide);
    let connected = details.isConnected;
    const observer = new MutationObserver(() => {
      if (connected !== details.isConnected) { connected = details.isConnected; sync(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const api = Object.freeze({
      setActive(value) { active = value === true; sync(); },
      getState() {
        return {
          active, expanded: details.open, visible: canRun(), destroyed,
          style: 'london', airport: 'KCMI', iata: 'CMI', timeZone: 'America/Chicago',
          timeFormat: use24HourTime ? '24-hour' : '12-hour', boardStatus: london.dataset.availability,
          arrivals: models.arrivals, departures: models.departures,
          trackerSource: TRACKER_SOURCE, trackerStatus, iframeMounted: Boolean(tracker),
          iframeNavigations, iframeUnloads, lastDocumentLoadedAt, aircraftCoverageVerified: false,
          clockRunning: timer !== null, flightRequests: flightData.requests,
          flightPending: running && flightData.pending !== null, backgroundPolling: false, notifications: 0
        };
      },
      destroy() {
        active = false; destroyed = true; sync();
        observer.disconnect();
        details.removeEventListener('toggle', sync);
        document.removeEventListener('visibilitychange', sync);
        window.removeEventListener('pagehide', pageHide);
        content.remove();
        details.classList.remove('wa-airport');
        instances.delete(details);
      }
    });
    instances.set(details, api);
    return api;
  }

  window.cmpriWillardAirport = Object.freeze({ create });
}());
