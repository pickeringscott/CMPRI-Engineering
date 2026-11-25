/* Local sky-event presentation. No requests, GPS, storage or notifications.
 * Estimated fallback: NASA's 2000-01-06 18:14 UT new moon and mean synodic month.
 * https://eclipse.gsfc.nasa.gov/phase/phases1901.html
 * Eight phase names: https://science.nasa.gov/moon/moon-phases/
 * The fallback is an estimate, not an ephemeris or an eclipse prediction.
 * Precise phase/local-event calculations are supplied separately by the host.
 */
(function () {
  'use strict';
  const DAY = 86400000;
  const MONTH = 29.530588;
  const NEW_MOON = Date.parse('2000-01-06T18:14:00Z');
  const PHASE_SOURCE = 'https://eclipse.gsfc.nasa.gov/phase/phases1901.html';
  const PHASE_NAMES = Object.freeze(['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent']);
  const TYPES = new Set(['solar-eclipse', 'lunar-eclipse', 'aurora']);
  const controllers = new WeakMap();
  let nextDialog = 0;

  function instant(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function sourceUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const official = ['nasa.gov', 'noaa.gov', 'weather.gov', 'navy.mil'].some((domain) => host === domain || host.endsWith('.' + domain));
      const calculation = host === 'github.com' && /^\/cosinekitty\/astronomy(?:\/|$)/.test(url.pathname);
      return url.protocol === 'https:' && !url.username && !url.password && (official || calculation) ? url.href : null;
    } catch { return null; }
  }
  function stamp(time) {
    if (window.cmpriWeatherClock) return window.cmpriWeatherClock.stamp(time);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(new Date(time));
  }
  function detailText(value) {
    return value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g, (token) => {
      const at = instant(token);
      return at === null ? 'Time unavailable' : stamp(at);
    });
  }
  function moonPhase(now = Date.now()) {
    const at = instant(now);
    if (at === null) return null;
    const cycle = (((at - NEW_MOON) / DAY / MONTH) % 1 + 1) % 1;
    return {
      label: PHASE_NAMES[Math.round(cycle * 8) % 8], angle: cycle * 360,
      illumination: (1 - Math.cos(cycle * 2 * Math.PI)) / 2,
      calculatedAt: new Date(at).toISOString(), sourceUrl: PHASE_SOURCE, approximate: true
    };
  }
  function precisePhase(value, now) {
    if (!value || now === null || !Number.isFinite(value.angle) || value.angle < 0 || value.angle >= 360) return null;
    const at = instant(value.calculatedAt), source = sourceUrl(value.sourceUrl);
    if (at === null || Math.abs(now - at) > DAY || !source) return null;
    const supplied = typeof value.label === 'string' ? value.label.replace(/third quarter/i, 'Last Quarter') : '';
    const label = PHASE_NAMES.find((name) => name.toLowerCase() === supplied.toLowerCase()) || PHASE_NAMES[Math.round(value.angle / 45) % 8];
    return { label, angle: value.angle, illumination: Number.isFinite(value.illumination) && value.illumination >= 0 && value.illumination <= 1 ? value.illumination : (1 - Math.cos(value.angle * Math.PI / 180)) / 2,
      calculatedAt: new Date(at).toISOString(), sourceUrl: source, approximate: false };
  }
  function localEvents(values, now) {
    if (!Array.isArray(values) || now === null) return [];
    return values.slice(0, 50).flatMap((value) => {
      if (!value || !TYPES.has(value.type) || typeof value.title !== 'string' || !value.title.trim()) return [];
      const start = instant(value.start), end = instant(value.end), peak = instant(value.peak), source = sourceUrl(value.sourceUrl);
      if (start === null || end === null || end <= start || end <= now || !source) return [];
      if (value.type === 'aurora' && start > now + 90 * 60000) return [];
      return [{ id: String(value.id || value.type + ':' + start).slice(0, 200), type: value.type, title: value.title.trim().slice(0, 200),
        summary: typeof value.summary === 'string' ? value.summary.slice(0, 2000) : '', start, end,
        peak: peak !== null && peak >= start && peak <= end ? peak : null,
        sourceUrl: source, calculated: value.calculated === true,
        details: Array.isArray(value.details) ? value.details.filter((item) => typeof item === 'string').slice(0, 12).map((item) => item.slice(0, 1000)) : [] }];
    }).sort((a, b) => Number(b.start <= now) - Number(a.start <= now) || a.start - b.start || a.id.localeCompare(b.id));
  }
  function eventCaption(event, now) {
    if (event.type === 'aurora' || event.start <= now + 6 * 3600000) return event.title;
    const year = new Date(now).getUTCFullYear() === new Date(event.start).getUTCFullYear() ? undefined : 'numeric';
    return event.title + ' · ' + new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', ...(year ? { year } : {}) }).format(new Date(event.start));
  }
  function link(label, href) {
    const result = node('a', '', label);
    result.href = href; result.target = '_blank'; result.rel = 'noopener noreferrer';
    result.setAttribute('data-weather-astronomy-source', '');
    return result;
  }

  function decorateCurrentIcon(slot, options = {}) {
    if (!slot?.querySelector) throw new TypeError('A current condition icon slot is required');
    if (controllers.has(slot)) { const existing = controllers.get(slot); existing.update(options); return existing; }
    const icon = slot.querySelector('.wv-condition');
    if (!icon) throw new TypeError('The current condition SVG is required');
    const button = node('button', 'wx-trigger'); button.type = 'button';
    button.setAttribute('data-weather-astronomy-trigger', ''); button.setAttribute('aria-haspopup', 'dialog');
    const caption = node('span', 'wx-caption'); caption.setAttribute('data-weather-astronomy-caption', '');
    icon.replaceWith(button); button.append(icon, caption);
    const dialogId = 'weather-astronomy-dialog-' + ++nextDialog;
    button.setAttribute('aria-controls', dialogId);
    let context = { now: Date.now(), events: [], moonPhase: null, ...options };
    let dialog = null, body = null, closeButton = null, previousFocus = null, expiryTimer = null;
    let destroyed = false, inactive = false, phase = null, events = [], now = null, captionKind = 'none';

    function stopExpiry() { if (expiryTimer !== null) { clearTimeout(expiryTimer); expiryTimer = null; } }
    function restoreFocus() {
      const target = previousFocus?.isConnected ? previousFocus : button.isConnected ? button : null;
      previousFocus = null; target?.focus({ preventScroll: true });
    }
    function closeDialog(suspend = false) {
      if (suspend) { inactive = true; stopExpiry(); }
      if (dialog?.open) dialog.close();
    }
    function ensureDialog() {
      if (dialog) return;
      dialog = node('dialog', 'wx-dialog'); dialog.id = dialogId;
      dialog.setAttribute('data-weather-astronomy-dialog', '');
      dialog.setAttribute('aria-labelledby', dialogId + '-title');
      const header = node('header', 'wx-dialog-header');
      const title = node('h2', '', 'Sky events · Champaign'); title.id = dialogId + '-title';
      closeButton = node('button', 'wx-close', '×'); closeButton.type = 'button';
      closeButton.setAttribute('aria-label', 'Close sky event details'); closeButton.setAttribute('data-weather-astronomy-close', '');
      closeButton.addEventListener('click', () => closeDialog());
      header.append(title, closeButton); body = node('div', 'wx-dialog-body');
      dialog.append(header, body); document.body.append(dialog);
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
      dialog.addEventListener('close', restoreFocus);
    }
    function renderDialog() {
      if (!body) return;
      const focused = document.activeElement;
      body.replaceChildren(node('p', 'wx-location', 'Residence Inn Champaign · Central time'));
      if (phase) {
        const section = node('section', 'wx-phase-details');
        section.append(node('h3', '', 'Moon phase · ' + phase.label));
        section.append(node('p', 'wx-method', phase.approximate ? 'Estimated from the mean lunar cycle; exact phase times vary.' : 'Calculated lunar phase · ' + stamp(instant(phase.calculatedAt))));
        section.append(link(phase.approximate ? 'NASA phase reference ↗' : 'Calculation source ↗', phase.sourceUrl));
        body.append(section);
      }
      if (!events.length) body.append(node('p', 'wx-unavailable', 'Local eclipse and northern-lights event details unavailable.'));
      for (const event of events) {
        const section = node('section', 'wx-event'); section.setAttribute('data-weather-astronomy-event', event.type);
        section.append(node('span', 'wx-event-kind', event.type === 'aurora' ? 'Potential northern lights · forecast guidance' : event.calculated ? 'Calculated for the hotel location' : 'Published event'));
        section.append(node('h3', '', event.title));
        if (event.summary) section.append(node('p', '', event.summary));
        const times = node('dl', 'wx-event-times');
        for (const [label, at] of [['Starts', event.start], ['Peak', event.peak], ['Ends', event.end]]) {
          if (at === null) continue;
          const entry = node('div', ''); entry.append(node('dt', '', label));
          const value = node('dd', ''), time = node('time', '', stamp(at)); time.dateTime = new Date(at).toISOString(); value.append(time); entry.append(value); times.append(entry);
        }
        section.append(times);
        for (const detail of event.details) section.append(node('p', 'wx-detail', detailText(detail)));
        section.append(link(event.type === 'aurora' ? 'NOAA source ↗' : 'Event source ↗', event.sourceUrl));
        body.append(section);
      }
      if (dialog.open && focused && !focused.isConnected) closeButton.focus({ preventScroll: true });
    }
    function scheduleExpiry() {
      stopExpiry();
      if (inactive || document.hidden || now === null) return;
      const next = events.filter((event) => event.type === 'aurora').reduce((end, event) => Math.min(end, event.end), Infinity);
      if (Number.isFinite(next)) expiryTimer = setTimeout(() => {
        expiryTimer = null;
        if (!destroyed && !inactive) update({ now: Date.now() });
      }, Math.max(1, Math.min(2147483647, next - now + 1)));
    }
    function update(next = {}) {
      if (destroyed) return;
      inactive = false; context = { ...context, ...next };
      now = instant(context.now); phase = precisePhase(context.moonPhase, now) || moonPhase(now);
      events = localEvents(context.events, now);
      const hasMoon = Boolean(icon.querySelector('.wv-moon'));
      const selected = events[0];
      captionKind = selected ? 'event' : hasMoon && phase ? 'moon-phase' : 'none';
      caption.hidden = captionKind === 'none';
      caption.textContent = selected ? eventCaption(selected, now) : hasMoon && phase ? phase.label : '';
      caption.dataset.kind = captionKind;
      button.classList.toggle('wx-has-event', Boolean(selected));
      const label = icon.getAttribute('aria-label') || 'Current conditions';
      button.setAttribute('aria-label', label + '. ' + (caption.textContent ? caption.textContent + '. ' : '') + 'Open local sky event details.');
      button.title = selected ? caption.textContent : hasMoon && phase ? (phase.approximate ? 'Estimated moon phase: ' : 'Calculated moon phase: ') + phase.label : 'Sun, Moon and potential northern-lights events for Champaign';
      renderDialog(); scheduleExpiry();
    }
    function openDialog() {
      if (destroyed || document.hidden) return;
      update({ now: Date.now() }); ensureDialog(); renderDialog();
      if (!dialog.open) { previousFocus = document.activeElement; dialog.showModal(); closeButton.focus({ preventScroll: true }); }
    }
    function visibility() {
      if (document.hidden) { closeDialog(); stopExpiry(); }
      else if (!inactive) update({ now: Date.now() });
    }
    function pageHide() { closeDialog(true); }
    button.addEventListener('click', openDialog);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    const unsubscribeClock = window.cmpriTimeFormat?.subscribe(renderDialog);
    const api = Object.freeze({
      update,
      close() { closeDialog(true); },
      getState: () => ({ captionKind, caption: caption.textContent, hasMoon: Boolean(icon.querySelector('.wv-moon')), approximatePhase: phase?.approximate ?? null,
        eventCount: events.length, dialogOpen: Boolean(dialog?.open), expiryPending: expiryTimer !== null, inactive, destroyed }),
      destroy() {
        if (destroyed) return;
        destroyed = true; closeDialog(true); stopExpiry();
        button.removeEventListener('click', openDialog);
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('pagehide', pageHide);
        unsubscribeClock?.();
        dialog?.remove();
        button.replaceWith(icon); controllers.delete(slot);
      }
    });
    controllers.set(slot, api); update();
    return api;
  }

  window.cmpriWeatherAstronomy = Object.freeze({ moonPhase, decorateCurrentIcon, phaseNames: PHASE_NAMES });
}());
