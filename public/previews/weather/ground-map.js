/* Actual USGS ground-map tiles. Presentation only: no GPS, database or scheduler. */
(function () {
  'use strict';
  const ORIGIN = 20037508.342787;
  const BASE_RESOLUTION = 156543.03392800014;
  const TILE_SIZE = 256;
  const CACHE_LIMIT = 150;
  const PARALLEL_LIMIT = 4;
  const STYLES = Object.freeze({ aerial: 'imagery' });
  const ATTRIBUTION = Object.freeze({
    topo: 'USGS',
    imagery: 'USGS · USDA/NAIP',
    relief: 'USGS · 3DEP/GMTED2010'
  });
  const cache = new Map();
  const inflight = new Map();
  const failures = new Map();
  const referenceImages = new Map();
  let placeLabels = null, routeFeatures = null;
  const HOTEL = Object.freeze({ latitude: 40.138080, longitude: -88.251416 });
  const referenceSources = Object.freeze({
    roads: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer',
    places: 'https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer',
    routes: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer'
  });
  const shieldImages = { interstate: null, illinois: null };
  const shieldSources = Object.freeze({ interstate: '/previews/weather/signs/interstate-route.svg', illinois: '/previews/weather/signs/illinois-route.svg' });
  const shieldStatus = { interstate: 'Not loaded', illinois: 'Not loaded' };
  const referenceStatus = {
    roads: { status: 'Not requested', source: referenceSources.roads },
    places: { status: 'Not requested', source: referenceSources.places },
    routes: { status: 'Not requested', source: referenceSources.routes }
  };
  const state = {
    initialized: false, opened: false, style: 'aerial', dataset: 'imagery', referenceEnabled: false,
    requests: 0, loaded: 0, tileZoom: null, requestedZoom: null,
    visible: [], fallbackVisibleCount: 0, status: 'Waiting for the map to open', error: ''
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
      visibleLoaded, visibleTotal: state.visible.length, visibleFailed, fallbackVisibleCount: state.fallbackVisibleCount,
      tileZoom: state.tileZoom, requestedZoom: state.requestedZoom,
      imageryAcquisitionYear: null,
      shields: { interstate: { source: shieldSources.interstate, status: shieldStatus.interstate }, illinois: { source: shieldSources.illinois, status: shieldStatus.illinois } },
      reference: {
        enabled: state.referenceEnabled && state.style === 'aerial',
        pending: Array.from(inflight.values()).filter((record) => record.kind === 'reference' && !record.controller.signal.aborted).length,
        queued: referenceQueue.length, cacheSize: referenceImages.size + (placeLabels ? 1 : 0) + (routeFeatures ? 1 : 0),
        routes: { ...referenceStatus.routes, loaded: Boolean(routeFeatures), sourceCount: routeFeatures?.data.features.length || 0,
          count: routeFeatures?.routes.length || 0, renderedCount: routeFeatures?.rendered.length || 0, rendered: routeFeatures?.rendered || [], budget: routeFeatures?.budget || 0 },
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
  function officialRoutes(data) {
    const routes = new Map();
    const classes = [['interstate', ['INTERSTATE', 'interstate', 'interstate_a', 'interstate_b', 'interstate_c']],
      ['us', ['US_ROUTE', 'us_route', 'us_route_a', 'us_route_b', 'us_route_c']],
      ['state', ['ST_ROUTE', 'state_route', 'state_route_a', 'state_route_b', 'state_route_c']]];
    data.features.forEach((feature) => {
      const geometry = feature.geometry;
      const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
      const valid = lines.filter(Array.isArray).map((line) => line.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) < 85.051129)).filter((line) => line.length > 1);
      if (!valid.length) return;
      const countyFips = String(property(feature.properties, 'stco_fipscode') || '').trim();
      const stateFips = String(property(feature.properties, 'STFIPS') || '').trim().padStart(2, '0');
      const stateAbbreviation = String(property(feature.properties, 'STATE') || '').trim().toUpperCase();
      const jurisdiction = countyFips ? countyFips.slice(0, 2) : stateFips !== '00' ? stateFips : stateAbbreviation;
      const illinois = jurisdiction === '17' || stateAbbreviation === 'IL';
      const projected = valid.map((line) => line.map((point) => [point[0] * ORIGIN / 180, Math.log(Math.tan((90 + point[1]) * Math.PI / 360)) * ORIGIN / Math.PI]));
      classes.forEach(([type, fields]) => {
        const numbers = new Set();
        fields.forEach((field) => String(property(feature.properties, field) || '').split(/[;,/|]+/).forEach((part) => {
          const match = /^\s*(?:(?:I|US|IL|SR)[- ]*)?(0*\d{1,6}[A-Z]?)\s*$/i.exec(part);
          if (match) numbers.add(match[1].replace(/^0+(?=\d)/, '').toUpperCase());
        }));
        numbers.forEach((number) => {
          const key = type + ':' + (type === 'state' ? (jurisdiction || 'unknown') + ':' : '') + number;
          if (!routes.has(key)) routes.set(key, { type, number, key, jurisdiction, illinois, lines: [], sourceIds: [] });
          const route = routes.get(key); route.lines.push(...projected);
          const id = property(feature.properties, 'permanent_identifier') || property(feature.properties, 'OBJECTID') || feature.id;
          if (id !== undefined && id !== null && !route.sourceIds.includes(id)) route.sourceIds.push(id);
        });
      });
    });
    return Array.from(routes.values()).sort((a, b) => ['interstate', 'us', 'state'].indexOf(a.type) - ['interstate', 'us', 'state'].indexOf(b.type) || a.number.localeCompare(b.number, 'en-US', { numeric: true }));
  }
  function screenPoint(point, geo) {
    const x = point[0] * ORIGIN / 180, y = Math.log(Math.tan((90 + point[1]) * Math.PI / 360)) * ORIGIN / Math.PI;
    return { x: geo.width / 2 + (x - geo.center.x) / geo.resolution, y: geo.height / 2 - (y - geo.center.y) / geo.resolution };
  }
  function clippedSegment(a, b, width, height) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let low = 0, high = 1;
    const p = [-dx, dx, -dy, dy], q = [a.x - 20, width - 20 - a.x, a.y - 20, height - 20 - a.y];
    for (let i = 0; i < 4; i += 1) {
      if (!p[i] && q[i] < 0) return null;
      if (!p[i]) continue;
      const value = q[i] / p[i];
      if (p[i] < 0) low = Math.max(low, value); else high = Math.min(high, value);
      if (low > high) return null;
    }
    return { x: a.x + dx * (low + high) / 2, y: a.y + dy * (low + high) / 2,
      startX: a.x + dx * low, startY: a.y + dy * low, endX: a.x + dx * high, endY: a.y + dy * high,
      length: Math.hypot(dx, dy) * (high - low) };
  }
  function loadShieldImages() {
    Object.entries(shieldSources).forEach(([name, source]) => {
      if (shieldImages[name] || shieldStatus[name] === 'Loading') return;
      shieldStatus[name] = 'Loading';
      const image = new Image();
      image.onload = () => { shieldImages[name] = image; shieldStatus[name] = 'Official design loaded'; notify(); };
      image.onerror = () => { shieldStatus[name] = 'Unavailable'; notify(); };
      image.src = source;
    });
  }
  function routeCandidates(route, geo) {
    const candidates = [];
    route.lines.forEach((line) => {
      for (let i = 1; i < line.length; i += 1) {
        const screen = (point) => ({ x: geo.width / 2 + (point[0] - geo.center.x) / geo.resolution, y: geo.height / 2 - (point[1] - geo.center.y) / geo.resolution });
        const segment = clippedSegment(screen(line[i - 1]), screen(line[i]), geo.width, geo.height);
        if (segment) candidates.push(segment);
      }
    });
    return candidates;
  }
  function shieldMetrics(route, geo) {
    const size = geo.width < 420 ? 26 : 30;
    const official = route.type === 'interstate' || route.type === 'state' && route.illinois;
    return { width: official ? (route.number.length > 2 && route.type === 'interstate' ? size * 1.25 : size) : 36,
      height: official ? size : 20, asset: route.type === 'interstate' ? 'interstate' : route.type === 'state' && route.illinois ? 'illinois' : null };
  }
  function paintShield(context, route, point, metrics) {
    const left = point.x - metrics.width / 2, top = point.y - metrics.height / 2;
    if (metrics.asset) {
      const image = shieldImages[metrics.asset]; if (!image) return false;
      context.drawImage(image, left, top, metrics.width, metrics.height);
      context.font = '700 ' + Math.round(metrics.height * .5) + 'px Arial, Helvetica, sans-serif';
      context.fillStyle = metrics.asset === 'interstate' ? '#fff' : '#000';
      context.fillText(route.number, point.x, top + metrics.height * (metrics.asset === 'interstate' ? .55 : 245 / 385), metrics.width * .7);
    } else {
      context.fillStyle = '#fff'; context.strokeStyle = '#19222a'; context.lineWidth = 1.5;
      context.beginPath(); context.roundRect(left, top, metrics.width, metrics.height, 3); context.fill(); context.stroke();
      context.font = '700 9px Arial, Helvetica, sans-serif'; context.fillStyle = '#16212a';
      context.fillText('US ' + route.number, point.x, point.y + .5);
    }
    return true;
  }
  function drawStateRouteLines(context, geo) {
    if (!routeFeatures) return;
    context.save(); context.beginPath(); context.rect(0, 0, geo.width, geo.height); context.clip();
    context.lineJoin = 'round'; context.lineCap = 'round';
    routeFeatures.routes.filter((route) => route.type === 'state').forEach((route) => {
      context.beginPath();
      route.lines.forEach((line) => line.forEach((point, index) => {
        const x = geo.width / 2 + (point[0] - geo.center.x) / geo.resolution, y = geo.height / 2 - (point[1] - geo.center.y) / geo.resolution;
        if (index) context.lineTo(x, y); else context.moveTo(x, y);
      }));
      context.strokeStyle = '#1a2029'; context.lineWidth = 2.6; context.stroke();
      context.strokeStyle = '#f4f0d8'; context.lineWidth = 1.1; context.stroke();
    });
    context.restore();
  }
  function drawRouteShields(context, geo, occupied) {
    if (!routeFeatures) return;
    const z = Math.log2(BASE_RESOLUTION / geo.resolution), area = geo.width * geo.height;
    const normalBudget = Math.max(1, Math.min(z <= 9 ? 4 : z <= 11 ? 7 : 10, Math.floor(area / (z <= 9 ? 95000 : z <= 11 ? 70000 : 45000))));
    const hotel = screenPoint([HOTEL.longitude, HOTEL.latitude], geo);
    const nearby = z >= 9 && hotel.x > 0 && hotel.x < geo.width && hotel.y > 0 && hotel.y < geo.height;
    const budget = nearby ? Math.max(5, normalBudget) : normalBudget;
    const layoutKey = [geo.width, geo.height, geo.resolution, geo.center.x, geo.center.y, shieldStatus.interstate, shieldStatus.illinois, placeLabels?.key || ''].join('|');
    const cachedLayout = routeFeatures.layoutKey === layoutKey, rendered = [];
    context.save(); context.textAlign = 'center'; context.textBaseline = 'middle';
    if (cachedLayout) {
      routeFeatures.rendered.forEach((entry) => {
        const metrics = shieldMetrics(entry, geo);
        if (paintShield(context, entry, entry, metrics)) { occupied.push({ x: entry.x - metrics.width / 2, y: entry.y - metrics.height / 2, ...metrics }); rendered.push(entry); }
      });
    } else {
      const candidates = new Map(routeFeatures.routes.map((route) => [route.key, routeCandidates(route, geo)]));
      const chosenCounts = new Map();
      const fits = (point, metrics) => {
        const box = { x: point.x - metrics.width / 2, y: point.y - metrics.height / 2, width: metrics.width, height: metrics.height };
        return box.x >= 4 && box.y >= 4 && box.x + box.width <= geo.width - 4 && box.y + box.height <= geo.height - 4
          && !occupied.some((other) => box.x < other.x + other.width + 7 && box.x + box.width + 7 > other.x && box.y < other.y + other.height + 7 && box.y + box.height + 7 > other.y);
      };
      const place = (route, side, filter, target) => {
        if (!route || rendered.length >= budget || route.type === 'state' && !route.illinois) return;
        const metrics = shieldMetrics(route, geo);
        const segments = candidates.get(route.key) || [], eligible = filter || (() => true);
        const compare = (a, b) => target ? Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y) : b.length - a.length;
        const points = segments.filter(eligible).sort(compare);
        let point = points.find((candidate) => fits(candidate, metrics));
        if (!point) {
          // A visible source segment can have a blocked midpoint but usable
          // space nearer an end. Keep every alternative on that same clipped
          // official polyline; never move a shield away from its road.
          const alternatives = segments.flatMap((segment) => [0, .1, .25, .75, .9, 1].map((fraction) => ({
            x: segment.startX + (segment.endX - segment.startX) * fraction,
            y: segment.startY + (segment.endY - segment.startY) * fraction, length: segment.length
          }))).filter(eligible).sort(compare);
          point = alternatives.find((candidate) => fits(candidate, metrics));
        }
        if (!point || !paintShield(context, route, point, metrics)) return;
        occupied.push({ x: point.x - metrics.width / 2, y: point.y - metrics.height / 2, width: metrics.width, height: metrics.height });
        chosenCounts.set(route.key, (chosenCounts.get(route.key) || 0) + 1);
        const worldX = geo.center.x + (point.x - geo.width / 2) * geo.resolution, worldY = geo.center.y - (point.y - geo.height / 2) * geo.resolution;
        rendered.push({ type: route.type, number: route.number, key: route.key, jurisdiction: route.jurisdiction, illinois: route.illinois,
          x: point.x, y: point.y, side: side || 'single', longitude: worldX * 180 / ORIGIN,
          latitude: Math.atan(Math.sinh(worldY * Math.PI / ORIGIN)) * 180 / Math.PI, sourceIds: route.sourceIds.slice(0, 3) });
      };
      if (nearby) {
        const i57 = routeFeatures.routes.find((route) => route.type === 'interstate' && route.number === '57');
        const i74 = routeFeatures.routes.find((route) => route.type === 'interstate' && route.number === '74');
        place(i57, 'north', (point) => point.y < hotel.y - 28, { x: hotel.x, y: geo.height * .2 });
        place(i57, 'south', (point) => point.y > hotel.y + 28, { x: hotel.x, y: geo.height * .77 });
        const urbana = placeLabels?.labels.find((label) => label.name.toLowerCase() === 'urbana');
        const urbanaPoint = urbana ? screenPoint([urbana.longitude, urbana.latitude], geo) : hotel;
        const east = Math.max(hotel.x + 12000 / geo.resolution, urbanaPoint.x + 5000 / geo.resolution);
        place(i74, 'east', (point) => point.x >= east, { x: Math.min(geo.width - 30, east + 20), y: hotel.y + 30 });
        const mahomet = placeLabels?.labels.find((label) => label.name.toLowerCase() === 'mahomet');
        const mahometPoint = mahomet ? screenPoint([mahomet.longitude, mahomet.latitude], geo) : null;
        const west = Math.min(hotel.x - 12000 / geo.resolution, mahometPoint ? mahometPoint.x + 5000 / geo.resolution : hotel.x - 55);
        place(i74, 'west', (point) => point.x <= west, mahometPoint || { x: Math.max(30, west - 20), y: hotel.y - 35 });
        const stateRoutes = routeFeatures.routes.filter((route) => route.type === 'state' && route.illinois)
          .sort((a, b) => Math.min(...(candidates.get(a.key) || []).map((point) => Math.hypot(point.x - hotel.x, point.y - hotel.y))) - Math.min(...(candidates.get(b.key) || []).map((point) => Math.hypot(point.x - hotel.x, point.y - hotel.y))));
        for (const route of stateRoutes) { const before = rendered.length; place(route, 'single', null, hotel); if (rendered.length > before) break; }
      }
      routeFeatures.routes.forEach((route) => { if (!chosenCounts.has(route.key)) place(route, 'single'); });
    }
    context.restore();
    const previous = routeFeatures.rendered.length; routeFeatures.rendered = rendered; routeFeatures.budget = budget; routeFeatures.layoutKey = layoutKey;
    if (previous !== rendered.length) notify();
  }
  function cachedReferenceKey(dataset) {
    return dataset === 'places' ? placeLabels?.key : dataset === 'routes' ? routeFeatures?.key : referenceImages.get(dataset)?.key;
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
              : tile.dataset === 'routes' ? new URLSearchParams({ op: 'route-features', dataset: 'roads', bbox, z: String(tile.z) })
              : new URLSearchParams({ op: 'reference', dataset: tile.dataset, bbox, width: String(tile.width), height: String(tile.height) })
            : new URLSearchParams({ dataset: tile.dataset, z: String(tile.z), x: String(tile.x), y: String(tile.y) });
          const response = await fetch('/api/weather-preview/basemap?' + query, {
            method: 'GET', signal: controller.signal, credentials: 'same-origin', cache: 'default'
          });
          if (!response.ok) throw new Error('USGS ' + (tile.kind === 'reference' ? 'reference' : 'tile') + ' request failed (HTTP ' + response.status + ')');
          if (tile.kind === 'reference' && ['places', 'routes'].includes(tile.dataset)) {
            const payload = await response.json();
            if (payload.error || payload.data?.type !== 'FeatureCollection' || !Array.isArray(payload.data.features)) throw new Error('Official geographic feature labels are unavailable');
            if (!state.opened || record.generation !== generation || controller.signal.aborted || !state.referenceEnabled
              || state.style !== 'aerial' || tile.viewportKey !== referenceTarget?.key) return;
            if (tile.dataset === 'routes') {
              routeFeatures = { data: payload.data, routes: officialRoutes(payload.data), extent: tile.extent, key: tile.viewportKey, rendered: [], budget: 0 };
              referenceStatus.routes = { status: 'Official route geometry available', source: payload.source || referenceSources.routes };
              return;
            }
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
    const target = { key, width, height, z: state.tileZoom ?? Math.max(0, Math.min(16, Math.round(Math.log2(BASE_RESOLUTION / geo.resolution)))), extent: { xmin: geo.center.x - halfWidth, ymin: geo.center.y - halfHeight, xmax: geo.center.x + halfWidth, ymax: geo.center.y + halfHeight } };
    referenceTarget = target; referenceQueue = []; queue = queue.filter((job) => job.kind !== 'reference');
    inflight.forEach((record) => { if (record.kind === 'reference') record.controller.abort(); });
    if (referenceTimer !== null) clearTimeout(referenceTimer);
    for (const dataset of ['roads', 'places', 'routes']) referenceStatus[dataset].status = cachedReferenceKey(dataset) === key ? 'Official reference available' : 'Waiting for settled map extent';
    referenceTimer = setTimeout(() => {
      referenceTimer = null;
      if (!state.opened || document.hidden || state.style !== 'aerial' || !state.referenceEnabled || referenceTarget?.key !== key) return;
      referenceQueue = ['roads', 'places', 'routes'].filter((dataset) => cachedReferenceKey(dataset) !== key).map((dataset) => ({ ...target, viewportKey: key, kind: 'reference', dataset, key: 'reference/' + dataset + '/' + key }));
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
    loadShieldImages(); notify();
    return getState();
  }
  function close() {
    state.opened = false; abortRequests();
    for (const dataset of ['roads', 'places', 'routes']) referenceStatus[dataset].status = 'Closed · reference requests stopped';
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
    context.filter = 'none';
    context.imageSmoothingEnabled = true;
    // A new native zoom level may still be loading. Keep already loaded,
    // georeferenced imagery underneath it instead of clearing known geography.
    const visibleKeys = new Set(state.visible.map((tile) => tile.key));
    const bounds = { xmin: geo.center.x - geo.width * geo.resolution / 2, xmax: geo.center.x + geo.width * geo.resolution / 2,
      ymin: geo.center.y - geo.height * geo.resolution / 2, ymax: geo.center.y + geo.height * geo.resolution / 2 };
    const fallback = [];
    cache.forEach((bitmap, key) => {
      if (visibleKeys.has(key)) return;
      const [dataset, level, column, row] = key.split('/');
      const z = Number(level), x = Number(column), y = Number(row);
      if (dataset !== state.dataset || ![z, x, y].every(Number.isInteger)) return;
      const span = 2 * ORIGIN / 2 ** z, left = -ORIGIN + x * span, top = ORIGIN - y * span;
      if (left >= bounds.xmax || left + span <= bounds.xmin || top <= bounds.ymin || top - span >= bounds.ymax) return;
      fallback.push({ bitmap, z, left, top, span });
    });
    fallback.sort((a, b) => a.z - b.z).forEach((tile) => {
      context.drawImage(tile.bitmap, geo.width / 2 + (tile.left - geo.center.x) / geo.resolution,
        geo.height / 2 - (tile.top - geo.center.y) / geo.resolution, tile.span / geo.resolution, tile.span / geo.resolution);
    });
    state.fallbackVisibleCount = fallback.length;
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
      context.save(); context.filter = 'drop-shadow(0px 0px .65px white)'; context.imageSmoothingEnabled = true;
      context.drawImage(image.bitmap, geo.width / 2 + (extent.xmin - geo.center.x) / geo.resolution,
        geo.height / 2 - (extent.ymax - geo.center.y) / geo.resolution,
        (extent.xmax - extent.xmin) / geo.resolution, (extent.ymax - extent.ymin) / geo.resolution);
      context.restore();
    }
    drawStateRouteLines(context, geo);
    const hotel = screenPoint([HOTEL.longitude, HOTEL.latitude], geo);
    const occupied = [{ x: hotel.x - 22, y: hotel.y - 22, width: 44, height: 44 },
      { x: geo.width - 55, y: 0, width: 55, height: 190 }, { x: 0, y: geo.height - 65, width: 240, height: 65 }];
    drawRouteShields(context, geo, occupied);
    if (!placeLabels) return;
    const rendered = [];
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
