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
    topo: 'USGS',
    imagery: 'USGS · USDA/NAIP',
    relief: 'USGS · 3DEP/GMTED2010'
  });
  const cache = new Map();
  const inflight = new Map();
  const failures = new Map();
  const referenceImages = new Map();
  let placeLabels = null;
  const HOTEL = Object.freeze({ latitude: 40.138080, longitude: -88.251416 });
  const referenceSources = Object.freeze({
    roads: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer',
    places: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer'
  });
  const referenceStatus = {
    roads: { status: 'Not requested', source: referenceSources.roads },
    places: { status: 'Not requested', source: referenceSources.places }
  };
  const state = {
    initialized: false, opened: false, style: 'aerial', dataset: 'imagery', referenceEnabled: false,
    requests: 0, loaded: 0, tileZoom: null, requestedZoom: null,
    visible: [], status: 'Waiting for the map to open', error: ''
  };
  let generation = 0;
  let queue = [];
  let onChange = null;
  let notified = '';
  let referenceTarget = null, referenceTimer = null, referenceQueue = [];

  function getState() {
    const visibleLoaded = state.visible.filter((tile) => cache.has(tile.key)).length;
    const visibleFailed = state.visible.filter((tile) => failures.has(tile.key)).length;
    return {
      initialized: state.initialized, opened: state.opened, style: state.style, dataset: state.dataset,
      status: state.status, requests: state.requests,
      pending: Array.from(inflight.values()).filter((record) => !record.controller.signal.aborted).length,
      queued: queue.length, loaded: state.loaded, failed: failures.size,
      cacheSize: cache.size, cacheLimit: CACHE_LIMIT, parallelLimit: PARALLEL_LIMIT,
      attribution: ATTRIBUTION[state.dataset] + (state.style === 'aerial' && state.referenceEnabled ? ' · GNIS' : ''), error: state.error,
      visibleLoaded, visibleTotal: state.visible.length, visibleFailed,
      tileZoom: state.tileZoom, requestedZoom: state.requestedZoom,
      imageryAcquisitionYear: null,
      reference: {
        enabled: state.referenceEnabled && state.style === 'aerial',
        pending: Array.from(inflight.values()).filter((record) => record.kind === 'reference' && !record.controller.signal.aborted).length,
        queued: referenceQueue.length, cacheSize: referenceImages.size + (placeLabels ? 1 : 0),
        roads: { ...referenceStatus.roads, loaded: referenceImages.has('roads') },
        places: { ...referenceStatus.places, loaded: Boolean(placeLabels), sourceCount: placeLabels?.data.features.length || 0,
          uniqueCount: placeLabels?.labels.length || 0, count: placeLabels?.labels.length || 0,
          renderedCount: placeLabels?.renderedCount || 0, renderedLabels: placeLabels?.renderedLabels || [] }
      }
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
    referenceQueue = []; referenceTarget = null;
    if (referenceTimer !== null) { clearTimeout(referenceTimer); referenceTimer = null; }
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
  function property(properties, name) {
    const key = Object.keys(properties || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? properties[key] : null;
  }
  function distanceFromHotel(longitude, latitude) {
    const rad = Math.PI / 180, lat = (latitude - HOTEL.latitude) * rad, lon = (longitude - HOTEL.longitude) * rad;
    const value = Math.sin(lat / 2) ** 2 + Math.cos(HOTEL.latitude * rad) * Math.cos(latitude * rad) * Math.sin(lon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
  }
  function officialPlaces(data) {
    const labels = new Map();
    for (const feature of data.features) {
      const properties = feature?.properties || {}, officialName = property(properties, 'gaz_name');
      if (typeof officialName !== 'string') continue;
      const name = officialName.replace(/\s+/g, ' ').trim().replace(/^(?:(?:city|village|town) of\s+)+/i, '').trim();
      if (!name) continue;
      const coordinates = feature.geometry?.type === 'Point' ? [feature.geometry.coordinates]
        : feature.geometry?.type === 'MultiPoint' ? feature.geometry.coordinates : [];
      if (!Array.isArray(coordinates)) continue;
      const points = coordinates.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
        && Math.abs(point[0]) <= 180 && Math.abs(point[1]) < 85.051129)
        .map((point) => ({ longitude: point[0], latitude: point[1], distance: distanceFromHotel(point[0], point[1]) }))
        .sort((a, b) => a.distance - b.distance || a.longitude - b.longitude || a.latitude - b.latitude);
      if (!points.length) continue;
      const gazId = property(properties, 'gaz_id'), objectId = property(properties, 'OBJECTID');
      const id = gazId ?? objectId ?? feature.id ?? '';
      const label = { name, officialName, id, objectId, ...points[0] };
      const key = name.toLocaleLowerCase('en-US'), prior = labels.get(key);
      const compare = (a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id), 'en-US', { numeric: true })
        || String(a.objectId).localeCompare(String(b.objectId), 'en-US', { numeric: true }) || a.longitude - b.longitude || a.latitude - b.latitude;
      if (!prior || compare(label, prior) < 0) labels.set(key, label);
    }
    return Array.from(labels.values()).sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id), 'en-US', { numeric: true }) || a.name.localeCompare(b.name, 'en-US'));
  }
  function cachedReferenceKey(dataset) {
    return dataset === 'places' ? placeLabels?.key : referenceImages.get(dataset)?.key;
  }
  function pump() {
    if (!state.opened || document.hidden) return;
    while (inflight.size < PARALLEL_LIMIT && queue.length) {
      const tile = queue.shift();
      if (inflight.has(tile.key) || tile.kind !== 'reference' && (cache.has(tile.key) || failures.has(tile.key))) continue;
      if (tile.kind === 'reference' && (!state.referenceEnabled || state.style !== 'aerial' || tile.viewportKey !== referenceTarget?.key)) continue;
      const controller = new AbortController();
      const record = { controller, generation, kind: tile.kind || 'tile' };
      inflight.set(tile.key, record);
      state.requests += 1;
      notify();
      void (async () => {
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const bbox = tile.kind === 'reference' ? [tile.extent.xmin, tile.extent.ymin, tile.extent.xmax, tile.extent.ymax].join(',') : null;
          const query = tile.kind === 'reference'
            ? tile.dataset === 'places' ? new URLSearchParams({ op: 'place-labels', dataset: 'places', bbox })
              : new URLSearchParams({ op: 'reference', dataset: tile.dataset, bbox, width: String(tile.width), height: String(tile.height) })
            : new URLSearchParams({ dataset: tile.dataset, z: String(tile.z), x: String(tile.x), y: String(tile.y) });
          const response = await fetch('/api/weather-preview/basemap?' + query, {
            method: 'GET', signal: controller.signal, credentials: 'same-origin', cache: 'default'
          });
          if (!response.ok) throw new Error('USGS ' + (tile.kind === 'reference' ? 'reference' : 'tile') + ' request failed (HTTP ' + response.status + ')');
          if (tile.kind === 'reference' && tile.dataset === 'places') {
            const payload = await response.json();
            if (payload.error || payload.data?.type !== 'FeatureCollection' || !Array.isArray(payload.data.features)) throw new Error('Official GNIS point labels are unavailable');
            if (!state.opened || record.generation !== generation || controller.signal.aborted || !state.referenceEnabled
              || state.style !== 'aerial' || tile.viewportKey !== referenceTarget?.key) return;
            placeLabels = { data: payload.data, labels: officialPlaces(payload.data), extent: tile.extent, key: tile.viewportKey,
              renderedCount: 0, renderedLabels: [] };
            referenceStatus.places = { status: 'Official incorporated-place labels available', source: payload.source || referenceSources.places };
            return;
          }
          const blob = await response.blob();
          const type = blob.type.split(';')[0];
          if (tile.kind === 'reference' ? type !== 'image/png' : !['image/png', 'image/jpeg', 'image/jpg'].includes(type)) throw new Error('USGS did not return a supported image');
          const bitmap = await createImageBitmap(blob);
          if (!state.opened || record.generation !== generation || controller.signal.aborted) { bitmap.close?.(); return; }
          if (tile.kind === 'reference') {
            if (!state.referenceEnabled || state.style !== 'aerial' || tile.viewportKey !== referenceTarget?.key) { bitmap.close?.(); return; }
            if (bitmap.width !== tile.width || bitmap.height !== tile.height) { bitmap.close?.(); throw new Error('USGS reference dimensions do not match the requested map extent'); }
            referenceImages.get(tile.dataset)?.bitmap.close?.();
            referenceImages.set(tile.dataset, { bitmap, extent: tile.extent, key: tile.viewportKey });
            referenceStatus[tile.dataset] = { status: 'Official reference available', source: response.headers.get('X-USGS-Source') || referenceSources[tile.dataset] };
          } else { cache.set(tile.key, bitmap); state.loaded += 1; trimCache(); }
        } catch (error) {
          if (state.opened && record.generation === generation) {
            if (tile.kind === 'reference') {
              if (tile.viewportKey === referenceTarget?.key) referenceStatus[tile.dataset].status = 'Unavailable · ' + (error.name === 'AbortError' ? 'Official reference request timed out' : error.message);
            } else failures.set(tile.key, error.name === 'AbortError' ? 'USGS tile request timed out' : error.message);
          }
        } finally {
          clearTimeout(timeout);
          if (inflight.get(tile.key) === record) inflight.delete(tile.key);
          notify(); pump();
        }
      })();
    }
  }
  function rebuildQueue() {
    referenceQueue = referenceQueue.filter((job) => !inflight.has(job.key)
      && job.viewportKey === referenceTarget?.key && cachedReferenceKey(job.dataset) !== job.viewportKey);
    queue = referenceQueue.concat(state.visible.filter((tile) => !cache.has(tile.key) && !failures.has(tile.key) && !inflight.has(tile.key)));
  }
  function prepareReferences(geo) {
    if (!state.referenceEnabled || state.style !== 'aerial') return;
    const width = Math.max(1, Math.min(1500, Math.round(geo.width))), height = Math.max(1, Math.min(1500, Math.round(geo.height)));
    const key = [geo.center.x.toFixed(3), geo.center.y.toFixed(3), geo.resolution.toFixed(6), geo.width.toFixed(2), geo.height.toFixed(2)].join('|');
    if (referenceTarget?.key === key) return;
    const halfWidth = geo.width * geo.resolution / 2, halfHeight = geo.height * geo.resolution / 2;
    const target = { key, width, height, extent: { xmin: geo.center.x - halfWidth, ymin: geo.center.y - halfHeight, xmax: geo.center.x + halfWidth, ymax: geo.center.y + halfHeight } };
    referenceTarget = target; referenceQueue = []; queue = queue.filter((job) => job.kind !== 'reference');
    inflight.forEach((record) => { if (record.kind === 'reference') record.controller.abort(); });
    if (referenceTimer !== null) clearTimeout(referenceTimer);
    for (const dataset of ['roads', 'places']) referenceStatus[dataset].status = cachedReferenceKey(dataset) === key ? 'Official reference available' : 'Waiting for settled map extent';
    referenceTimer = setTimeout(() => {
      referenceTimer = null;
      if (!state.opened || document.hidden || state.style !== 'aerial' || !state.referenceEnabled || referenceTarget?.key !== key) return;
      referenceQueue = ['roads', 'places'].filter((dataset) => cachedReferenceKey(dataset) !== key).map((dataset) => ({ ...target, viewportKey: key, kind: 'reference', dataset, key: 'reference/' + dataset + '/' + key }));
      for (const job of referenceQueue) referenceStatus[job.dataset].status = 'Requesting official reference';
      rebuildQueue(); notify(); pump();
    }, 120);
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
    if (typeof options.referenceEnabled === 'boolean' && options.referenceEnabled !== state.referenceEnabled) {
      state.referenceEnabled = options.referenceEnabled;
      if (!state.referenceEnabled) {
        referenceQueue = []; referenceTarget = null;
        if (referenceTimer !== null) { clearTimeout(referenceTimer); referenceTimer = null; }
        queue = queue.filter((job) => job.kind !== 'reference');
        inflight.forEach((record) => { if (record.kind === 'reference') record.controller.abort(); });
      }
    }
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
    state.opened = false; abortRequests();
    for (const dataset of ['roads', 'places']) referenceStatus[dataset].status = 'Closed · reference requests stopped';
    notify();
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
    prepareReferences(geo);
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
    rebuildQueue();
    notify(); pump(); return getState();
  }
  function drawReferences(context, geo) {
    if (!state.opened || document.hidden || !state.referenceEnabled || state.style !== 'aerial' || !context || !geo?.center || !Number.isFinite(geo.resolution) || geo.resolution <= 0) return;
    for (const dataset of ['roads']) {
      const image = referenceImages.get(dataset); if (!image) continue;
      const extent = image.extent;
      context.save(); context.filter = 'drop-shadow(0px 0px 1px white) drop-shadow(0px 0px 1px white)'; context.imageSmoothingEnabled = true;
      context.drawImage(image.bitmap, geo.width / 2 + (extent.xmin - geo.center.x) / geo.resolution,
        geo.height / 2 - (extent.ymax - geo.center.y) / geo.resolution,
        (extent.xmax - extent.xmin) / geo.resolution, (extent.ymax - extent.ymin) / geo.resolution);
      context.restore();
    }
    if (!placeLabels) return;
    const occupied = [], rendered = [];
    context.save(); context.filter = 'none'; context.font = '600 12px Arial, Helvetica, sans-serif';
    context.textAlign = 'center'; context.textBaseline = 'bottom'; context.lineJoin = 'round';
    for (const label of placeLabels.labels) {
      const x = label.longitude * ORIGIN / 180, y = Math.log(Math.tan((90 + label.latitude) * Math.PI / 360)) * ORIGIN / Math.PI;
      const point = { x: geo.width / 2 + (x - geo.center.x) / geo.resolution, y: geo.height / 2 - (y - geo.center.y) / geo.resolution };
      const width = Math.ceil(context.measureText(label.name).width) + 8, height = 20;
      if (point.x < 0 || point.x > geo.width || point.y < 0 || point.y > geo.height || width > geo.width - 12) continue;
      const candidates = [{ x: point.x - width / 2, y: point.y - height - 5 },
        { x: point.x + 7, y: point.y - height / 2 }, { x: point.x - width - 7, y: point.y - height / 2 },
        { x: point.x - width / 2, y: point.y + 6 }];
      const box = candidates.map((position) => ({ ...position, width, height })).find((candidate) =>
        candidate.x >= 5 && candidate.y >= 5 && candidate.x + width <= geo.width - 5 && candidate.y + height <= geo.height - 5
        && !occupied.some((other) => candidate.x < other.x + other.width + 5 && candidate.x + width + 5 > other.x
          && candidate.y < other.y + other.height + 4 && candidate.y + height + 4 > other.y));
      if (!box) continue;
      occupied.push(box);
      context.fillStyle = '#fff'; context.strokeStyle = '#16191d'; context.lineWidth = 3.5;
      context.beginPath(); context.arc(point.x, point.y, 2.1, 0, Math.PI * 2); context.stroke(); context.fill();
      const textX = box.x + width / 2, textY = box.y + height - 3;
      context.strokeText(label.name, textX, textY); context.fillText(label.name, textX, textY);
      rendered.push({ name: label.name, officialName: label.officialName, id: label.id, longitude: label.longitude, latitude: label.latitude });
    }
    context.restore();
    const previous = placeLabels.renderedCount;
    placeLabels.renderedCount = rendered.length; placeLabels.renderedLabels = rendered.slice(0, 80);
    if (previous !== rendered.length) notify();
  }
  window.cmpriGroundMap = { init, draw, drawReferences, open, close, getState };
}());
