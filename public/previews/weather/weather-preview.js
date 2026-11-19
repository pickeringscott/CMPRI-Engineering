/* Isolated branch review shell. It never imports or contacts the CMPRI app. */
'use strict';
(() => {
  const byId = (id) => document.getElementById(id);
  let opened = false;
  let activeTab = 'weather';
  let returnFocus = null;
  const map = window.cmpriWeatherMap;
  map.init();
  window.initNotificationPreview();
  window.initWeatherSimulation();

  function lifecycle() {
    const state = map.getState();
    byId('lifecycleStatus').textContent = !opened
      ? 'Weather closed · playback and pending map requests stopped'
      : state.playing ? 'Map playback running · no background scheduler'
      : 'Map paused · official feeds load only on explicit request · no scheduler';
    const badge = byId('mapModeBadge');
    if (badge) badge.textContent = state.mode === 'live' ? 'See layer status' : 'Simulated map';
  }
  function setTab(name, focus = false) {
    activeTab = name;
    ['weather', 'notifications', 'checks', 'sources'].forEach((id) => {
      const selected = id === name;
      const button = byId('tab-' + id);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      byId('panel-' + id).hidden = !selected;
    });
    if (opened && name === 'weather') map.resume();
    else map.pause();
    if (focus) byId('tab-' + name).focus();
    byId('windowBody').scrollTop = 0;
    lifecycle();
  }
  function open() {
    if (opened) { byId('tab-' + activeTab).focus(); return; }
    returnFocus = document.activeElement;
    opened = true;
    byId('weatherWindow').hidden = false;
    document.body.classList.add('weather-open');
    byId('dashboard').inert = true;
    byId('weatherLauncher').dataset.open = 'true';
    map.open();
    setTab('weather');
    byId('closeWeather').focus();
  }
  function close() {
    window.notificationPreview?.closeSafety?.();
    map.close();
    opened = false;
    byId('weatherWindow').hidden = true;
    document.body.classList.remove('weather-open');
    byId('dashboard').inert = false;
    byId('weatherLauncher').dataset.open = 'false';
    lifecycle();
    returnFocus?.focus();
  }
  byId('weatherLauncher').addEventListener('click', () => opened ? close() : open());
  byId('openWeather').addEventListener('click', open);
  byId('closeWeather').addEventListener('click', close);
  document.querySelectorAll('[role="tab"]').forEach((button, index, all) => {
    button.addEventListener('click', () => setTab(button.id.slice(4)));
    button.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % all.length;
      if (event.key === 'ArrowLeft') next = (index + all.length - 1) % all.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = all.length - 1;
      if (next !== undefined) { event.preventDefault(); setTab(all[next].id.slice(4), true); }
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened && !event.defaultPrevented
      && !document.querySelector('dialog[open]') && !document.fullscreenElement
      && !byId('mapShell').classList.contains('expanded')) close();
  });
  byId('openMapReference').addEventListener('click', (event) => {
    event.preventDefault();
    setTab('sources');
    byId('map-control-reference').scrollIntoView({ block: 'start' });
  });
  window.addEventListener('cmpri-weather-map-state', lifecycle);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !opened || activeTab !== 'weather') map.pause();
    else map.resume();
  });
  window.addEventListener('pagehide', () => map.close());

  const hours = [
    ['5 PM', '☁', '29°F', 'Cloudy', '30%', 'NE 10 mph'],
    ['6 PM', '❄', '28°F', 'Snow possible', '50%', 'NE 11 mph'],
    ['7 PM', '❄', '27°F', 'Snow likely', '70%', 'NE 12 mph'],
    ['8 PM', '❄', '26°F', 'Snow likely', '80%', 'NE 12 mph'],
    ['9 PM', '❄', '25°F', 'Snow likely', '80%', 'N 13 mph'],
    ['10 PM', '❄', '25°F', 'Snow likely', '70%', 'N 12 mph'],
    ['11 PM', '❄', '24°F', 'Snow possible', '50%', 'N 11 mph'],
    ['12 AM', '☁', '24°F', 'Mostly cloudy', '30%', 'N 10 mph'],
    ['1 AM', '☁', '23°F', 'Mostly cloudy', '20%', 'N 9 mph'],
    ['2 AM', '☁', '23°F', 'Mostly cloudy', '10%', 'N 9 mph'],
    ['3 AM', '☁', '23°F', 'Mostly cloudy', '10%', 'NW 8 mph'],
    ['4 AM', '☁', '23°F', 'Mostly cloudy', '10%', 'NW 8 mph']
  ];
  const days = [
    ['Tonight', '❄', '29° / 23°F', 'Snow likely', '80%', 'NE 12 mph'],
    ['Friday', '❄', '30° / 18°F', 'Snow ending early', '40%', 'N 11 mph'],
    ['Saturday', '☁', '27° / 16°F', 'Mostly cloudy', '10%', 'N 8 mph'],
    ['Sunday', '☀', '31° / 21°F', 'Partly sunny', '10%', 'SE 7 mph'],
    ['Monday', '☁', '34° / 25°F', 'Mostly cloudy', '20%', 'S 8 mph'],
    ['Tuesday', '❄', '36° / 26°F', 'Chance rain / snow', '40%', 'W 9 mph'],
    ['Wednesday', '☀', '33° / 22°F', 'Partly sunny', '20%', 'NW 8 mph']
  ];
  function cards(host, values, hourly) {
    values.forEach((entry) => {
      const card = document.createElement('article');
      card.className = 'forecast-card';
      const label = document.createElement('h3'); label.textContent = entry[0] + (hourly ? ' CST' : '');
      const icon = document.createElement('span'); icon.className = 'forecast-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = entry[1];
      const temp = document.createElement('strong'); temp.className = 'forecast-temperature'; temp.textContent = entry[2];
      const detail = document.createElement('p'); detail.className = 'forecast-detail'; detail.textContent = entry[3];
      const chance = document.createElement('p'); chance.className = 'forecast-chance'; chance.textContent = entry[4] + ' precip.';
      const wind = document.createElement('p'); wind.className = 'forecast-wind'; wind.textContent = entry[5];
      card.append(label, icon, temp, detail, chance, wind);
      host.append(card);
    });
  }
  cards(byId('hourlyForecast'), hours, true);
  cards(byId('extendedForecast'), days, false);
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
    getState: () => ({ ...map.getState(), opened, activeTab, databaseCalls: 0, pushes: 0 }) };
  if (new URLSearchParams(location.search).get('weather') === 'open') open();
})();
