/* Actual USGS ground-map tiles. Presentation only: no GPS, database or scheduler. */
(function () {
  'use strict';
  const ORIGIN = 20037508.342787;
  const BASE_RESOLUTION = 156543.03392800014;
  const TILE_SIZE = 256;
  const CACHE_LIMIT = 150;
  const PARALLEL_LIMIT = 4;
  const STYLES = Object.freeze({ gray: 'topo', roads: 'topo', aerial: 'imagery', terrain: 'relief' });
  const ATTRIBUTION = Object.freeze({
    topo: 'USGS The National Map · topographic reference data',
    imagery: 'USGS The National Map · USDA/NAIP ground imagery · acquisition dates vary; not live satellite',
    relief: 'USGS The National Map · 3DEP / GMTED2010 shaded relief'
  });
  const cache = new Map();
  const inflight = new Map();
  const failures = new Map();
  const state = {
    initialized: false, opened: false, style: 'gray', dataset: 'topo',
    requests: 0, loaded: 0, tileZoom: null, requestedZoom: null,
    visible: [], status: 'Waiting for the map to open', error: ''
  };
  let generation = 0;
  let queue = [];
  let onChange = null;
  let notified = '';

  function getState() {
    const visibleLoaded = state.visible.filter((tile) => cache.has(tile.key)).length;
    const visibleFailed = state.visible.filter((tile) => failures.has(tile.key)).length;
    return {
      initialized: state.initialized, opened: state.opened, style: state.style, dataset: state.dataset,
      status: state.status, requests: state.requests,
      pending: Array.from(inflight.values()).filter((record) => !record.controller.signal.aborted).length,
      queued: queue.length, loaded: state.loaded, failed: failures.size,
      cacheSize: cache.size, cacheLimit: CACHE_LIMIT, parallelLimit: PARALLEL_LIMIT,
      attribution: ATTRIBUTION[state.dataset], error: state.error,
      visibleLoaded, visibleTotal: state.visible.length, visibleFailed,
      tileZoom: state.tileZoom, requestedZoom: state.requestedZoom
    };
  }
  function availability() {
    const visibleLoaded = state.visible.filter((tile) => cache.has(tile.key)).length;
    const missing = state.visible.filter((tile) => failures.has(tile.key));
    state.error = missing.length ? failures.get(missing[0].key) : '';
    if (!state.opened) state.status = 'Closed · USGS ground-map requests stopped';
    else if (!state.visible.length) state.status = 'Waiting for a ground-map viewport';
    else if (visibleLoaded === state.visible.length) state.status = 'USGS ground map available';
    else if (missing.length && visibleLoaded === 0 && missing.length === state.visible.length) state.status = 'USGS ground map unavailable';
    else if (missing.length) state.status = 'USGS ground map incomplete · ' + visibleLoaded + '/' + state.visible.length + ' tiles available';
    else state.status = 'Loading USGS ground map · ' + visibleLoaded + '/' + state.visible.length + ' tiles';
  }
  function notify() {
    availability();
    const serialized = JSON.stringify(getState());
    if (serialized === notified) return;
    notified = serialized;
    if (onChange) onChange(getState());
  }
  function abortRequests() {
    generation += 1;
    queue = [];
    // Keep records until their promises settle, preserving the four-request limit.
    inflight.forEach((record) => record.controller.abort());
  }
  function trimCache() {
    const visible = new Set(state.visible.map((tile) => tile.key));
    while (cache.size > CACHE_LIMIT) {
      const key = Array.from(cache.keys()).find((candidate) => !visible.has(candidate)) || cache.keys().next().value;
      cache.get(key).close?.(); cache.delete(key);
    }
  }
  function pump() {
    if (!state.opened || document.hidden) return;
    while (inflight.size < PARALLEL_LIMIT && queue.length) {
      const tile = queue.shift();
      if (cache.has(tile.key) || failures.has(tile.key) || inflight.has(tile.key)) continue;
      const controller = new AbortController();
      const record = { controller, generation };
      inflight.set(tile.key, record);
      state.requests += 1;
      notify();
      void (async () => {
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const query = new URLSearchParams({ dataset: tile.dataset, z: String(tile.z), x: String(tile.x), y: String(tile.y) });
          const response = await fetch('/api/weather-preview/basemap?' + query, {
            method: 'GET', signal: controller.signal, credentials: 'same-origin', cache: 'default'
          });
          if (!response.ok) throw new Error('USGS tile request failed (HTTP ' + response.status + ')');
          const blob = await response.blob();
          if (!['image/png', 'image/jpeg', 'image/jpg'].includes(blob.type.split(';')[0])) throw new Error('USGS tile did not return a supported image');
          const bitmap = await createImageBitmap(blob);
          if (!state.opened || record.generation !== generation || controller.signal.aborted) { bitmap.close?.(); return; }
          cache.set(tile.key, bitmap); state.loaded += 1; trimCache();
        } catch (error) {
          if (state.opened && record.generation === generation) {
            failures.set(tile.key, error.name === 'AbortError' ? 'USGS tile request timed out' : error.message);
          }
        } finally {
          clearTimeout(timeout);
          if (inflight.get(tile.key) === record) inflight.delete(tile.key);
          notify(); pump();
        }
      })();
    }
  }
  function tileRange(geo, z) {
    const resolution = BASE_RESOLUTION / (2 ** z);
    const span = TILE_SIZE * resolution;
    const xmin = geo.center.x - geo.width * geo.resolution / 2;
    const ymax = geo.center.y + geo.height * geo.resolution / 2;
    const xmax = geo.center.x + geo.width * geo.resolution / 2;
    const ymin = geo.center.y - geo.height * geo.resolution / 2;
    const maximum = 2 ** z - 1;
    const minX = Math.max(0, Math.floor((xmin + ORIGIN) / span));
    const maxX = Math.min(maximum, Math.floor((xmax + ORIGIN - 0.00001) / span));
    const minY = Math.max(0, Math.floor((ORIGIN - ymax) / span));
    const maxY = Math.min(maximum, Math.floor((ORIGIN - ymin - 0.00001) / span));
    return { resolution, span, minX, maxX, minY, maxY, count: Math.max(0, maxX - minX + 1) * Math.max(0, maxY - minY + 1) };
  }
  function tilesFor(geo) {
    const requested = Math.max(0, Math.min(16, Math.round(Math.log2(BASE_RESOLUTION / geo.resolution))));
    let z = requested, range = tileRange(geo, z);
    // Very wide displays use one coarser native level to keep visible tiles inside the bounded cache.
    while (range.count > 120 && z > 0) { z -= 1; range = tileRange(geo, z); }
    state.requestedZoom = requested; state.tileZoom = z;
    const tiles = [];
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const left = -ORIGIN + x * range.span;
        const top = ORIGIN - y * range.span;
        tiles.push({ dataset: state.dataset, z, x, y,
          key: [state.dataset, z, x, y].join('/'), left, top, span: range.span,
          distance: (left + range.span / 2 - geo.center.x) ** 2 + (top - range.span / 2 - geo.center.y) ** 2 });
      }
    }
    return tiles.sort((a, b) => a.distance - b.distance);
  }
  function init(options = {}) {
    if (typeof options.onChange === 'function') onChange = options.onChange;
    if (!state.initialized) {
      state.initialized = true;
      window.addEventListener('pagehide', close);
    }
    return window.cmpriGroundMap;
  }
  function open() {
    init();
    if (!state.opened) { state.opened = true; failures.clear(); }
    notify();
    return getState();
  }
  function close() {
    state.opened = false; abortRequests(); notify();
    return getState();
  }
  function draw(context, geo, style) {
    if (!state.opened || document.hidden || !context) return getState();
    if (!Object.hasOwn(STYLES, style)) { state.error = 'Unsupported ground-map style'; state.status = 'USGS ground map unavailable'; return getState(); }
    if (!geo || ![geo.width, geo.height, geo.resolution, geo.center?.x, geo.center?.y].every(Number.isFinite)
      || geo.width <= 0 || geo.height <= 0 || geo.resolution <= 0) return getState();
    if (style !== state.style) {
      abortRequests(); state.style = style; state.dataset = STYLES[style];
    }
    state.visible = tilesFor(geo);
    context.save();
    context.filter = style === 'gray' ? 'grayscale(1) brightness(0.55) contrast(1.15)' : 'none';
    context.imageSmoothingEnabled = true;
    state.visible.forEach((tile) => {
      const bitmap = cache.get(tile.key);
      if (!bitmap) return;
      cache.delete(tile.key); cache.set(tile.key, bitmap);
      const left = geo.width / 2 + (tile.left - geo.center.x) / geo.resolution;
      const top = geo.height / 2 - (tile.top - geo.center.y) / geo.resolution;
      const span = tile.span / geo.resolution;
      context.drawImage(bitmap, left, top, span, span);
    });
    context.restore();
    queue = state.visible.filter((tile) => !cache.has(tile.key) && !failures.has(tile.key) && !inflight.has(tile.key));
    notify(); pump(); return getState();
  }
  window.cmpriGroundMap = { init, draw, open, close, getState };
}());
