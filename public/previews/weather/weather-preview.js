/* Weather content hosted by the existing CMPRI desktop window in embedded mode. */
'use strict';
(() => {
  const byId = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const embedded = query.get('embedded') === '1' && window.parent !== window;
  if (embedded) {
    document.documentElement.classList.add('cmpri-weather-embedded');
    byId('weatherWindow').removeAttribute('role');
    byId('weatherWindow').removeAttribute('aria-modal');
  }
  let opened = false;
  const activeTab = 'weather';
  let returnFocus = null;
  const map = window.cmpriWeatherMap;
  map.init();
  window.nwsLiveView.init();
  window.initNotificationPreview();
  window.initWeatherSimulation();
  const airport = window.cmpriWillardAirport?.create(byId('willardAirport'), {
    use24HourTime: window.cmpriWeatherClock?.hour12 === false,
  });
  function airportLifecycle() { airport?.setActive(opened && !document.hidden); }

  function lifecycle() {
    const state = map.getState();
    const lifecycleHost = byId('lifecycleStatus');
    if (lifecycleHost) lifecycleHost.textContent = !opened
      ? 'Weather closed · playback and pending map requests stopped'
      : state.playing ? 'Map playback running · no background scheduler'
      : 'Official NOAA / NWS feeds · foreground requests only · no scheduler';
    const badge = byId('mapModeBadge');
    if (badge) badge.textContent = state.mode === 'live' ? 'NOAA feed status below' : 'Unavailable';
  }
  function setTab(name, focus = false, resetScroll = true) {
    // Kept as a narrow compatibility hook; Weather has a single visible view.
    if (name !== 'weather') return false;
    if (opened && !document.hidden) map.resume();
    else map.pause();
    airportLifecycle();
    if (focus) byId('radarCanvas').focus({ preventScroll: true });
    if (resetScroll) byId('windowBody').scrollTop = 0;
    lifecycle();
  }
  function open() {
    if (opened) return;
    returnFocus = document.activeElement;
    opened = true;
    byId('weatherWindow').hidden = false;
    document.body.classList.add('weather-open');
    byId('dashboard').inert = true;
    byId('weatherLauncher').dataset.open = 'true';
    map.open();
    window.nwsLiveView.open();
    setTab(activeTab, false, false);
    if (!embedded) byId('closeWeather').focus();
  }
  function close(notifyParent = true) {
    window.notificationPreview?.closeSafety?.();
    map.close();
    window.nwsLiveView.close();
    opened = false;
    airportLifecycle();
    byId('weatherWindow').hidden = true;
    document.body.classList.remove('weather-open');
    byId('dashboard').inert = false;
    byId('weatherLauncher').dataset.open = 'false';
    lifecycle();
    returnFocus?.focus();
    if (embedded && notifyParent) window.parent.postMessage({ type: 'cmpri-modal-close', modalToken: query.get('modalToken') }, location.origin);
  }
  byId('weatherLauncher').addEventListener('click', () => opened ? close() : open());
  byId('openWeather').addEventListener('click', open);
  byId('closeWeather').addEventListener('click', () => close());
  document.addEventListener('cmpri-modal-cancel-request', () => close(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened && !event.defaultPrevented
      && !document.querySelector('dialog[open]') && !document.fullscreenElement
      && !byId('mapShell').classList.contains('expanded')) close();
  });
  window.addEventListener('message', (event) => {
    if (!embedded || event.origin !== location.origin || event.source !== window.parent
      || event.data?.modalToken !== query.get('modalToken') || event.data?.type !== 'cmpri-weather-view-state') return;
    if (event.data.visible === true) open();
    else close(false);
  });
  window.addEventListener('cmpri-weather-map-state', lifecycle);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !opened || activeTab !== 'weather') map.pause();
    else map.resume();
    airportLifecycle();
  });
  window.addEventListener('pagehide', () => close(false));

  document.querySelectorAll('[data-scroll-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const strip = byId(button.dataset.scrollTarget);
      strip.scrollBy({ left: strip.clientWidth * .75 * Number(button.dataset.direction),
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
  });
  function modeTiles() {
    const minutes = window.weatherSim.snapshot().mode.minutes;
    ['Clear', 'Watch', 'Warning'].forEach((name, i) => { byId('mode' + name).dataset.active = String(minutes === [5, 2, 1][i]); });
  }
  document.querySelectorAll('#panel-checks button').forEach((button) => button.addEventListener('click', modeTiles));
  modeTiles();
  window.weatherPreview = { open, close, setTab, layer: map.selectLayer,
    getState: () => ({ ...map.getState(), opened, activeTab, airport: airport?.getState(), databaseCalls: 0, pushes: 0 }) };
  if (embedded || query.get('weather') === 'open') open();
})();
