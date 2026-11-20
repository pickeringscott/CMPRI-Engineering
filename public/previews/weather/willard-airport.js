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
  const TRACKER_SOURCE = 'https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9';
  // Official AvioADSB iframe template with its documented map-center options.
  // The fixed center is the official KCMI observation geometry, not the hotel.
  // Retain the provider's controls/banner; the widget is not a flight-board API.
  const TRACKER_MARKUP = '<iframe src="https://avioadsb.org/embed/map?lat=40.03&amp;lon=-88.28&amp;zoom=9" width="100%" height="450" style="border:0;max-width:100%" title="Live flight tracker map by AvioADSB" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function board(kind) {
    const section = element('section', 'wa-flight-panel');
    section.setAttribute('data-willard-' + kind, '');
    const heading = element('h3', 'wa-flight-heading', kind === 'arrivals' ? 'Arrivals' : 'Departures');
    const table = element('table', 'wa-flight-table');
    table.setAttribute('aria-label', 'Willard Airport ' + kind);
    const head = table.createTHead().insertRow();
    for (const label of ['Time', 'Flight', kind === 'arrivals' ? 'From' : 'To', 'Status']) {
      const cell = element('th', '', label);
      cell.scope = 'col';
      head.append(cell);
    }
    const cell = table.createTBody().insertRow().insertCell();
    cell.colSpan = 4;
    cell.className = 'wa-unavailable';
    cell.textContent = 'Flight data unavailable';
    section.append(heading, table);
    return section;
  }

  function create(details, options = {}) {
    if (!details || details.tagName !== 'DETAILS') throw new TypeError('Willard Airport requires a details element');
    if (instances.has(details)) return instances.get(details);
    const use24HourTime = options.use24HourTime === undefined
      ? window.cmpriWeatherClock?.hour12 === false
      : options.use24HourTime === true;
    const clockFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: use24HourTime ? '2-digit' : 'numeric', minute: '2-digit',
      ...(use24HourTime ? { hourCycle: 'h23' } : { hour12: true }), timeZoneName: 'short'
    });
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
    boards.append(board('arrivals'), board('departures'));
    london.append(header, boards);
    const trackerHost = element('div', 'wa-tracker');
    trackerHost.setAttribute('data-willard-tracker', '');
    content.append(london, trackerHost);
    details.append(content);

    let active = false, destroyed = false, timer = null, tracker = null;
    let iframeNavigations = 0, iframeUnloads = 0, trackerStatus = 'not-requested';
    let lastDocumentLoadedAt = null;
    const canRun = () => !destroyed && active && details.open && !document.hidden;

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
      timer = setTimeout(() => {
        timer = null;
        if (canRun()) startClock();
      }, 60000 - Date.now() % 60000 + 25);
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
      record.error = () => {
        if (tracker === record && canRun()) trackerStatus = 'unavailable';
      };
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
      // Removing its browsing context unloads the provider and cancels its reads.
      record.frame.remove();
      iframeUnloads += 1;
      trackerStatus = 'inactive';
    }

    function sync() {
      if (canRun()) { startClock(); mountTracker(); }
      else { stopClock(); unmountTracker(); }
    }

    function pageHide() { active = false; sync(); }
    details.addEventListener('toggle', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', pageHide);

    const api = Object.freeze({
      setActive(value) { active = value === true; sync(); },
      getState() {
        return {
          active, expanded: details.open, visible: canRun(), destroyed,
          style: 'london', airport: 'KCMI', iata: 'CMI', timeZone: 'America/Chicago',
          timeFormat: use24HourTime ? '24-hour' : '12-hour',
          boardStatus: 'unavailable', arrivals: null, departures: null,
          trackerSource: TRACKER_SOURCE, trackerStatus, iframeMounted: Boolean(tracker),
          iframeNavigations, iframeUnloads, lastDocumentLoadedAt, aircraftCoverageVerified: false,
          clockRunning: timer !== null, flightRequests: 0, backgroundPolling: false, notifications: 0
        };
      },
      destroy() {
        active = false; destroyed = true; sync();
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
