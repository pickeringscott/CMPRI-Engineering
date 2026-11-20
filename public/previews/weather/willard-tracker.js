/* Independent, foreground-only CMI aircraft map. Positions are never predicted. */
(function () {
  'use strict';
  const AIRPORT = Object.freeze({ lat: 40.0398, lon: -88.2762 });
  const TTL = 180000, TILE_LIMIT = 256, PARALLEL = 4, TILE = 256;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function project(lat, lon, zoom) {
    const size = TILE * 2 ** zoom, latitude = clamp(lat, -85.05112878, 85.05112878);
    return { x: (lon + 180) / 360 * size, y: (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) / 2 * size };
  }
  function unproject(x, y, zoom) {
    const size = TILE * 2 ** zoom;
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI, lon: x / size * 360 - 180 };
  }
  function instant(value) { const parsed = typeof value === 'number' ? value : typeof value === 'string' && value ? Date.parse(value) : NaN; return finite(parsed) ? parsed : null; }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function dispose(image) { if (typeof image?.close === 'function') image.close(); else if (image && 'src' in image) image.src = ''; }
  function decode(blob, signal) {
    if (typeof window.createImageBitmap === 'function') return window.createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob), image = new Image();
      const cleanup = () => { URL.revokeObjectURL(url); signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null; };
      const abort = () => { cleanup(); image.src = ''; reject(new DOMException('Aborted', 'AbortError')); };
      image.onload = () => { cleanup(); resolve(image); };
      image.onerror = () => { cleanup(); reject(new Error('Ground Map Image Unavailable')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else image.src = url;
    });
  }
  function create(host, { clockMode = '12' } = {}) {
    if (!host?.append) throw new TypeError('A Tracker Map Host Is Required');
    const root = element('section', 'wt-map'), canvas = element('canvas', 'wt-canvas');
    root.setAttribute('aria-label', 'Aircraft Near Willard Airport');
    canvas.setAttribute('aria-label', 'Reported Aircraft Positions And USGS Ground Map'); canvas.tabIndex = 0;
    const tools = element('div', 'wt-tools'); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Aircraft Map Controls');
    const buttons = new Map();
    for (const [action, label, glyph] of [['zoom-in', 'Zoom In', '+'], ['zoom-out', 'Zoom Out', '−'], ['recenter', 'Recenter On CMI', '⌖'], ['fullscreen', 'Full Screen', '⛶'], ['refresh', 'Refresh Aircraft', '↻']]) {
      const button = element('button', '', glyph); button.type = 'button'; button.dataset.action = action;
      button.title = window.cmpriWeatherTooltips?.titleCase(label) || label; button.setAttribute('aria-label', label); tools.append(button); buttons.set(action, button);
    }
    buttons.get('refresh').title = 'Refresh Map Data'; buttons.get('refresh').setAttribute('aria-label', 'Refresh Map Data');
    const layers = element('div', 'wt-layer-buttons'); layers.setAttribute('role', 'group'); layers.setAttribute('aria-label', 'Flight Map Layers');
    const aerialButton = element('button', '', 'Aerial Imagery'); aerialButton.type = 'button'; aerialButton.dataset.layer = 'aerial'; aerialButton.setAttribute('aria-pressed', 'true'); aerialButton.title = 'Show Historical USGS Aerial Imagery';
    const layoutButton = element('button', '', 'Airport Layout'); layoutButton.type = 'button'; layoutButton.dataset.layer = 'layout'; layoutButton.setAttribute('aria-pressed', 'true'); layoutButton.title = 'Show FAA Airport Layout Reference';
    layers.append(aerialButton, layoutButton);
    const banner = element('div', 'wt-source'), provider = element('a', 'wt-provider', 'Aircraft Data: ADSB.lol');
    provider.href = 'https://adsb.lol/?lat=40.0398&lon=-88.2762&zoom=9&hideSideBar='; provider.target = '_blank'; provider.rel = 'noopener noreferrer';
    const license = element('a', 'wt-license', 'ODbL1.0'); license.href = 'https://opendatacommons.org/licenses/odbl/1-0/'; license.target = '_blank'; license.rel = 'noopener noreferrer';
    const ground = element('a', 'wt-usgs', 'USGS · USDA/NAIP'); ground.href = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer'; ground.target = '_blank'; ground.rel = 'noopener noreferrer';
    const imageryYear = element('span', 'wt-imagery-year', 'Historical · Capture Year Unavailable');
    const faa = element('a', 'wt-faa', 'FAA Airport Layout · Reference'); faa.href = 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/'; faa.target = '_blank'; faa.rel = 'noopener noreferrer';
    const layoutCopy = element('span', 'wt-layout-status', 'Airport Layout Pending');
    const statusCopy = element('span', 'wt-status', 'Unavailable'), updated = element('time', 'wt-updated', 'Updated Unavailable');
    banner.append(provider, license, ground, imageryYear, faa, layoutCopy, element('span', 'wt-scope', 'CMI · 50 NM'), statusCopy, updated);
    const details = element('aside', 'wt-details'); details.hidden = true; details.setAttribute('aria-label', 'Aircraft Details');
    root.append(canvas, layers, tools, details, banner); host.append(root);
    const context = canvas.getContext('2d'), cache = new Map(), inflight = new Map(), tileFailures = new Set();
    const start = project(AIRPORT.lat, AIRPORT.lon, 0);
    let center = { ...start }, zoom = 9, width = 640, height = 450, visibleTiles = [], queue = [], markers = [];
    let basemap = 'imagery';
    const LAYOUT_TTL = 6 * 3600000;
    let layoutEnabled = true, layoutStatus = 'unavailable', layoutFeatures = [], layoutLayers = [], layoutReadAt = null, layoutRetrievedAt = null, layoutSource = null, layoutRecord = null, layoutRequests = 0, layoutRendered = 0, layoutError = '';
    let requestedActive = false, running = false, destroyed = false, generation = 0, wheelActive = false, expanded = false;
    let sourceStatus = 'unavailable', aircraft = [], trustedCollection = false, observedAt = null, retrievedAt = null, lastReadAt = null, lastAttemptAt = null, error = '';
    let sourceRecord = null, pollTimer = null, sourceRequests = 0, tileRequests = 0, selected = null, pointer = null, moved = false;
    const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: clockMode === '24' ? '2-digit' : 'numeric', minute: '2-digit', ...(clockMode === '24' ? { hourCycle: 'h23' } : { hour12: true }), timeZoneName: 'short' });
    function timestamp(value) { return value === null ? 'Unavailable' : clock.format(new Date(value)); }
    function status() { return sourceStatus === 'live' && observedAt !== null && Date.now() - observedAt >= TTL ? 'stale' : sourceStatus; }
    function positionAge(row) { return finite(row.positionAgeSeconds) ? Math.max(0, row.positionAgeSeconds + (observedAt === null ? 0 : Math.max(0, Date.now() - observedAt) / 1000)) : null; }
    function effectiveLayoutStatus() { return ['available', 'partial'].includes(layoutStatus) && layoutReadAt !== null && Date.now() - layoutReadAt >= LAYOUT_TTL ? 'stale' : layoutStatus; }
    function screen(lat, lon) {
      const point = project(lat, lon, zoom), scale = 2 ** zoom, size = TILE * scale;
      let dx = point.x - center.x * scale; if (dx > size / 2) dx -= size; if (dx < -size / 2) dx += size;
      return { x: width / 2 + dx, y: height / 2 + point.y - center.y * scale };
    }
    function showDetails() {
      const row = aircraft.find((item) => item.hex === selected);
      details.hidden = !row; details.replaceChildren(); if (!row) return;
      const close = element('button', 'wt-details-close', '×'); close.type = 'button'; close.title = 'Close Aircraft Details'; close.setAttribute('aria-label', 'Close Aircraft Details');
      close.addEventListener('click', () => { selected = null; showDetails(); });
      details.append(close, element('strong', '', row.callsign || row.registration || row.hex));
      const list = element('dl');
      const age = positionAge(row);
      const fields = [['Registration', row.registration], ['Aircraft', row.type], ['Altitude', row.altitudeFeet === 'ground' ? 'Ground' : finite(row.altitudeFeet) ? row.altitudeFeet.toLocaleString('en-US') + ' Ft' : null],
        ['Ground Speed', finite(row.speedKnots) ? row.speedKnots + ' Kt' : null], ['Track', finite(row.track) ? row.track + '°' : null],
        ['Position Age', age === null ? null : Math.round(age) + ' Seconds'], ['Updated', timestamp(observedAt)], ['Hex', row.hex]];
      for (const [label, value] of fields) { const item = element('div'); item.append(element('dt', '', label), element('dd', '', value ?? 'Unknown')); list.append(item); }
      details.append(list);
    }
    function updateBanner() {
      const state = status();
      statusCopy.textContent = state === 'unavailable' ? 'Unavailable' : state === 'stale' ? 'Stale Positions' : trustedCollection && aircraft.length === 0 ? 'No Aircraft Reported' : aircraft.length + ' Aircraft';
      if (visibleTiles.some((tile) => tileFailures.has(tile.key))) statusCopy.textContent += ' · Ground Map Unavailable';
      updated.textContent = 'Updated ' + timestamp(observedAt); if (observedAt !== null) updated.dateTime = new Date(observedAt).toISOString(); else updated.removeAttribute('datetime');
      root.dataset.status = state; root.dataset.active = String(running); root.dataset.wheelActive = String(wheelActive);
      root.dataset.basemap = basemap; aerialButton.setAttribute('aria-pressed', String(basemap === 'imagery'));
      ground.textContent = basemap === 'imagery' ? 'USGS · USDA/NAIP' : 'USGS'; ground.href = 'https://basemap.nationalmap.gov/arcgis/rest/services/' + (basemap === 'imagery' ? 'USGSImageryOnly' : 'USGSTopo') + '/MapServer';
      imageryYear.hidden = basemap !== 'imagery';
      const layoutState = effectiveLayoutStatus(); layoutButton.setAttribute('aria-pressed', String(layoutEnabled));
      layoutButton.dataset.status = layoutState; faa.hidden = !layoutEnabled;
      layoutCopy.textContent = layoutRecord ? 'Airport Layout Pending' : layoutState === 'available' ? '' : layoutState === 'partial' ? 'Airport Layout Partial' : layoutState === 'stale' ? 'Airport Layout Stale · Unavailable' : 'Airport Layout Unavailable';
      layoutCopy.hidden = !layoutEnabled || !layoutCopy.textContent;
      layoutCopy.title = layoutError || 'Historical Reference Geometry; Not Runway Or Taxiway Operating Status';
      banner.title = error || 'Community Reported Aircraft Positions'; buttons.get('refresh').disabled = !running || sourceRecord !== null;
    }
    function paint() {
      updateBanner(); markers = [];
      if (!context) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1); context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height); context.fillStyle = '#1a252d'; context.fillRect(0, 0, width, height);
      for (const tile of visibleTiles) { const image = cache.get(tile.key); if (image) context.drawImage(image, tile.left, tile.top, TILE, TILE); }
      paintLayout();
      const airport = screen(AIRPORT.lat, AIRPORT.lon);
      context.save(); context.translate(airport.x, airport.y); context.fillStyle = '#ffcf4d'; context.strokeStyle = '#172027'; context.lineWidth = 2;
      context.beginPath(); context.arc(0, 0, 6, 0, Math.PI * 2); context.fill(); context.stroke(); context.font = 'bold 11px Arial'; context.textAlign = 'left'; context.textBaseline = 'middle'; context.strokeText('CMI', 9, 0); context.fillText('CMI', 9, 0); context.restore();
      for (const row of aircraft) {
        const point = screen(row.lat, row.lon); if (point.x < -16 || point.y < -16 || point.x > width + 16 || point.y > height + 16) continue;
        const age = positionAge(row), old = status() !== 'live' || age === null || age > 180;
        markers.push({ ...point, hex: row.hex, lat: row.lat, lon: row.lon, track: row.track, kind: finite(row.track) ? 'arrow' : 'dot', stale: old });
        context.save(); context.translate(point.x, point.y); context.globalAlpha = old ? .48 : 1; context.fillStyle = old ? '#a9b8c1' : '#12d6ed'; context.strokeStyle = '#14222b'; context.lineWidth = 1.5;
        context.beginPath();
        if (finite(row.track)) { context.rotate(row.track * Math.PI / 180); context.moveTo(0, -11); context.lineTo(6, 7); context.lineTo(0, 4); context.lineTo(-6, 7); context.closePath(); }
        else context.arc(0, 0, 4, 0, Math.PI * 2);
        context.fill(); context.stroke(); context.restore();
      }
      showDetails();
    }
    function trim() {
      const needed = new Set(visibleTiles.map((tile) => tile.key));
      while (cache.size > TILE_LIMIT) { const key = Array.from(cache.keys()).find((item) => !needed.has(item)) || cache.keys().next().value; dispose(cache.get(key)); cache.delete(key); }
    }
    function polygonRows(collection) {
      if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) return [];
      return collection.features.slice(0, 1500).flatMap((feature) => {
        const p = feature?.properties || {}, geometry = feature?.geometry;
        if (p.airportId !== 'KCMI' || !['runway', 'taxiway', 'apron'].includes(p.kind)) return [];
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        if (!Array.isArray(polygons) || !polygons.length || polygons.some((polygon) => !Array.isArray(polygon) || !polygon.length || polygon.some((ring) => !Array.isArray(ring) || ring.length < 4 || ring.length > 20000 || ring.some((point) => !Array.isArray(point) || !finite(point[0]) || !finite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.05112878) || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]))) return [];
        return [{ kind: p.kind, designator: typeof p.designator === 'string' && !/^(?:UNK|UNKNOWN)$/i.test(p.designator.trim()) ? p.designator.trim() : null, polygons }];
      });
    }
    function paintLayout() {
      layoutRendered = 0;
      const state = effectiveLayoutStatus(); if (!context || !layoutEnabled || !['available', 'partial'].includes(state)) return;
      for (const feature of layoutFeatures) {
        const layer = layoutLayers.find((item) => item.kind === feature.kind);
        if (layer?.status !== 'available') continue;
        for (const polygon of feature.polygons) {
          const rings = polygon.map((ring) => ring.map(([lon, lat]) => screen(lat, lon)));
          const points = rings[0], minX = Math.min(...points.map((p) => p.x)), maxX = Math.max(...points.map((p) => p.x)), minY = Math.min(...points.map((p) => p.y)), maxY = Math.max(...points.map((p) => p.y));
          if (maxX < 0 || minX > width || maxY < 0 || minY > height) continue;
          context.save(); context.beginPath();
          for (const ring of rings) { ring.forEach((point, index) => { if (!index) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y); }); context.closePath(); }
          context.fillStyle = feature.kind === 'runway' ? '#f2d37745' : feature.kind === 'taxiway' ? '#c3dfe645' : '#d9d6c52e';
          context.strokeStyle = feature.kind === 'runway' ? '#ffe7a4' : '#d2e5eb'; context.lineWidth = feature.kind === 'runway' ? 1.5 : 1;
          context.fill('evenodd'); context.stroke(); layoutRendered += 1;
          if (feature.designator && zoom >= 12 && maxX - minX > 24 && maxY - minY > 8) { context.font = 'bold 10px Arial'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.lineWidth = 3; context.strokeStyle = '#15212a'; context.fillStyle = '#fff7dc'; context.strokeText(feature.designator, (minX + maxX) / 2, (minY + maxY) / 2); context.fillText(feature.designator, (minX + maxX) / 2, (minY + maxY) / 2); }
          context.restore();
        }
      }
    }
    async function readLayout(force = false) {
      if (!running || destroyed || !layoutEnabled || layoutRecord) return;
      if (!force && layoutReadAt !== null && Date.now() - layoutReadAt < LAYOUT_TTL) { paint(); return; }
      const ticket = generation, record = { controller: new AbortController(), timeout: null }; layoutRecord = record; layoutRequests += 1; layoutError = '';
      record.timeout = setTimeout(() => record.controller.abort(), 15000); paint();
      try {
        const response = await fetch('/api/willard-airport-layout', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: record.controller.signal });
        if (!response.ok) throw new Error('Airport Layout Unavailable');
        const body = await response.json(); if (ticket !== generation || !running || !layoutEnabled || layoutRecord !== record || record.controller.signal.aborted) return;
        const features = polygonRows(body?.collection), state = body?.status;
        if (!['available', 'partial', 'stale'].includes(state) || !features.length) throw new Error(body?.error || 'Airport Layout Unavailable');
        layoutFeatures = features; layoutLayers = Array.isArray(body.layers) ? body.layers : []; layoutStatus = state; layoutReadAt = Date.now(); layoutRetrievedAt = instant(body.retrievedAt); layoutSource = typeof body.sourceUrl === 'string' ? body.sourceUrl : null;
        layoutError = typeof body.operationalStatusNote === 'string' ? body.operationalStatusNote : 'Historical Reference Geometry; Not Runway Or Taxiway Operating Status';
        if (layoutSource) { try { const url = new URL(layoutSource); if (url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'faa.gov' || url.hostname.endsWith('.faa.gov') || url.hostname === 'services6.arcgis.com' || url.hostname === 'ais-faa.opendata.arcgis.com')) faa.href = url.href; } catch { /* Keep the fixed FAA source link. */ } }
      } catch (failure) { if (ticket === generation && running && layoutEnabled && layoutRecord === record) { layoutStatus = 'unavailable'; layoutError = failure.name === 'AbortError' ? 'Airport Layout Read Timed Out' : String(failure.message || 'Airport Layout Unavailable'); } }
      finally { clearTimeout(record.timeout); if (layoutRecord === record) layoutRecord = null; if (ticket === generation && running) paint(); }
    }
    function tileUrl(tile) { return '/api/weather-preview/basemap?dataset=' + tile.dataset + '&op=tile&z=' + tile.z + '&x=' + tile.x + '&y=' + tile.y; }
    function pumpTiles() {
      if (!running || destroyed) return;
      while (inflight.size < PARALLEL && queue.length) {
        const tile = queue.shift(); if (cache.has(tile.key) || inflight.has(tile.key)) continue;
        const ticket = generation, record = { controller: new AbortController(), timeout: null }; inflight.set(tile.key, record); tileRequests += 1;
        record.timeout = setTimeout(() => record.controller.abort(), 15000);
        void (async () => {
          let image = null;
          try {
            const response = await fetch(tileUrl(tile), { cache: 'force-cache', signal: record.controller.signal }); if (!response.ok) throw new Error('USGS Tile Unavailable');
            image = await decode(await response.blob(), record.controller.signal);
            if (ticket !== generation || !running || record.controller.signal.aborted) { dispose(image); return; }
            const prior = cache.get(tile.key); if (prior) dispose(prior); cache.set(tile.key, image); tileFailures.delete(tile.key); trim(); paint();
          } catch (failure) { if (ticket === generation && running && failure.name !== 'AbortError') { tileFailures.add(tile.key); paint(); } }
          finally { clearTimeout(record.timeout); if (inflight.get(tile.key) === record) inflight.delete(tile.key); pumpTiles(); }
        })();
      }
    }
    function updateTiles() {
      if (!running) return;
      const scale = 2 ** zoom, count = 2 ** zoom, left = center.x * scale - width / 2, top = center.y * scale - height / 2;
      const tiles = [];
      for (let y = Math.max(0, Math.floor(top / TILE)); y <= Math.min(count - 1, Math.floor((top + height) / TILE)); y += 1) {
        for (let rawX = Math.floor(left / TILE); rawX <= Math.floor((left + width) / TILE); rawX += 1) {
          const x = ((rawX % count) + count) % count; tiles.push({ key: basemap + '/' + zoom + '/' + x + '/' + y, dataset: basemap, z: zoom, x, y, left: rawX * TILE - left, top: y * TILE - top });
        }
      }
      visibleTiles = tiles; const needed = new Set(tiles.map((tile) => tile.key));
      inflight.forEach((record, key) => { if (!needed.has(key) || record.controller.signal.aborted) { record.controller.abort(); clearTimeout(record.timeout); inflight.delete(key); } });
      queue = tiles.filter((tile) => !cache.has(tile.key) && !inflight.has(tile.key) && !tileFailures.has(tile.key)); pumpTiles(); paint();
    }
    function resize() {
      const rect = root.getBoundingClientRect(); width = Math.max(180, rect.width || host.clientWidth || 640); height = Math.max(180, rect.height || 450);
      const ratio = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      if (running) updateTiles(); else paint();
    }
    function schedule() {
      if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null;
      if (!running || destroyed) return;
      // Start a successful read's cache interval at receipt, so network time
      // cannot make the next check hit the server just before its cache expires.
      const now = Date.now(), readDue = lastAttemptAt === null ? now + TTL : Math.max(lastAttemptAt, lastReadAt ?? lastAttemptAt) + TTL;
      const deadlines = [readDue];
      if (observedAt !== null) {
        if (observedAt + TTL > now) deadlines.push(observedAt + TTL);
        for (const row of aircraft) if (finite(row.positionAgeSeconds)) {
          const due = observedAt + (180 - row.positionAgeSeconds) * 1000 + 1;
          if (due > now) deadlines.push(due);
        }
      }
      pollTimer = setTimeout(() => { pollTimer = null; paint(); if (Date.now() >= readDue) void refresh(true); else schedule(); }, Math.max(1, Math.min(...deadlines) - now));
    }
    function normalize(rows) {
      const result = [], seen = new Set();
      for (const row of rows) {
        if (!row || typeof row.hex !== 'string' || !row.hex.trim() || seen.has(row.hex) || !finite(row.lat) || !finite(row.lon) || Math.abs(row.lat) > 85.05112878 || Math.abs(row.lon) > 180) continue;
        seen.add(row.hex); result.push({ ...row, track: finite(row.track) && row.track >= 0 && row.track < 360 ? row.track : null,
          altitudeFeet: row.altitudeFeet === 'ground' || finite(row.altitudeFeet) ? row.altitudeFeet : null, speedKnots: finite(row.speedKnots) && row.speedKnots >= 0 ? row.speedKnots : null });
      }
      return result;
    }
    async function refresh(force = false) {
      if (!running || destroyed || sourceRecord) return;
      if (!force && lastReadAt !== null && Date.now() - lastReadAt < TTL) { paint(); schedule(); return; }
      const ticket = generation, record = { controller: new AbortController(), timeout: null }; sourceRecord = record; sourceRequests += 1; lastAttemptAt = Date.now(); error = '';
      record.timeout = setTimeout(() => record.controller.abort(), 15000); paint();
      try {
        const response = await fetch('/api/willard-tracker', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: record.controller.signal });
        if (!response.ok) throw new Error('Aircraft Data Unavailable');
        const body = await response.json(); if (ticket !== generation || !running) return;
        const at = instant(body?.observedAt), rows = Array.isArray(body?.aircraft) ? normalize(body.aircraft) : null;
        if (!['live', 'stale'].includes(body?.status) || at === null || at > Date.now() + 60000 || !rows || body.aircraft.length > 0 && !rows.length) throw new Error(body?.error || 'Aircraft Data Unavailable');
        if (observedAt !== null && (at < observedAt || body.status === 'stale' && rows.length === 0 && aircraft.length > 0)) {
          sourceStatus = 'stale'; error = 'Last Known Aircraft Positions'; lastReadAt = Date.now(); return;
        }
        aircraft = rows; observedAt = at; retrievedAt = instant(body.retrievedAt); trustedCollection = true; sourceStatus = body.status; lastReadAt = Date.now();
        selected = aircraft.some((row) => row.hex === selected) ? selected : null;
      } catch (failure) { if (ticket === generation && running) { sourceStatus = 'unavailable'; trustedCollection = false; error = failure.name === 'AbortError' ? 'Aircraft Read Timed Out' : String(failure.message || 'Aircraft Data Unavailable'); } }
      finally { clearTimeout(record.timeout); if (sourceRecord === record) sourceRecord = null; if (ticket === generation && running) { paint(); schedule(); } }
    }
    function stop() {
      generation += 1; running = false; wheelActive = false; pointer = null;
      if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null;
      if (sourceRecord) { sourceRecord.controller.abort(); clearTimeout(sourceRecord.timeout); sourceRecord = null; }
      if (layoutRecord) { layoutRecord.controller.abort(); clearTimeout(layoutRecord.timeout); layoutRecord = null; }
      inflight.forEach((record) => { record.controller.abort(); clearTimeout(record.timeout); }); inflight.clear(); queue = []; visibleTiles = [];
      cache.forEach(dispose); cache.clear(); tileFailures.clear(); paint();
      if (expanded) { expanded = false; root.classList.remove('wt-expanded'); }
      if (document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => {});
    }
    function reconcile() {
      const shouldRun = requestedActive && !document.hidden && !destroyed;
      if (shouldRun === running) return;
      if (!shouldRun) stop(); else { running = true; resize(); void refresh(); void readLayout(); }
    }
    function setActive(value) { requestedActive = Boolean(value); reconcile(); return getState(); }
    function changeZoom(next, x = width / 2, y = height / 2) {
      if (!running) return; next = clamp(Math.round(next), 4, 14); if (next === zoom) return;
      const beforeScale = 2 ** zoom, afterScale = 2 ** next, anchor = { x: center.x + (x - width / 2) / beforeScale, y: center.y + (y - height / 2) / beforeScale };
      zoom = next; center = { x: ((anchor.x - (x - width / 2) / afterScale) % TILE + TILE) % TILE, y: clamp(anchor.y - (y - height / 2) / afterScale, 0, TILE) }; updateTiles();
    }
    function recenter() { center = { ...start }; zoom = 9; selected = null; if (running) updateTiles(); }
    function toggleFullscreen() {
      if (!running) return;
      if (document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => {});
      else if (expanded) { expanded = false; root.classList.remove('wt-expanded'); resize(); }
      else if (root.requestFullscreen) void root.requestFullscreen().catch(() => { if (running) { expanded = true; root.classList.add('wt-expanded'); resize(); } });
      else { expanded = true; root.classList.add('wt-expanded'); resize(); }
    }
    function action(event) { const name = event.target.closest('button[data-action]')?.dataset.action; if (!running) return; if (name === 'zoom-in') changeZoom(zoom + 1); else if (name === 'zoom-out') changeZoom(zoom - 1); else if (name === 'recenter') recenter(); else if (name === 'fullscreen') toggleFullscreen(); else if (name === 'refresh') { void refresh(true); void readLayout(true); } }
    function layerAction(event) {
      const name = event.target.closest('button[data-layer]')?.dataset.layer;
      if (name === 'aerial') { basemap = basemap === 'imagery' ? 'topo' : 'imagery'; if (running) updateTiles(); else paint(); }
      else if (name === 'layout') {
        layoutEnabled = !layoutEnabled;
        if (!layoutEnabled && layoutRecord) { layoutRecord.controller.abort(); clearTimeout(layoutRecord.timeout); layoutRecord = null; }
        if (layoutEnabled && running) void readLayout(); paint();
      }
    }
    function point(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
    function down(event) { if (!running || event.button !== undefined && event.button !== 0) return; pointer = { id: event.pointerId, ...point(event) }; moved = false; canvas.setPointerCapture?.(event.pointerId); }
    function move(event) { if (!running || !pointer || event.pointerId !== pointer.id) return; const at = point(event), dx = at.x - pointer.x, dy = at.y - pointer.y; moved ||= Math.abs(dx) + Math.abs(dy) > 2; center.x = ((center.x - dx / 2 ** zoom) % TILE + TILE) % TILE; center.y = clamp(center.y - dy / 2 ** zoom, 0, TILE); pointer = { id: pointer.id, ...at }; updateTiles(); }
    function up() { pointer = null; }
    function click(event) { if (!running) return; wheelActive = true; if (!moved) { const at = point(event), hit = markers.map((row) => ({ ...row, distance: Math.hypot(row.x - at.x, row.y - at.y) })).filter((row) => row.distance <= 14).sort((a, b) => a.distance - b.distance)[0]; selected = hit?.hex || null; } moved = false; paint(); }
    function leave() { wheelActive = false; pointer = null; updateBanner(); }
    function wheel(event) { if (!running || !wheelActive) return; event.preventDefault(); const at = point(event); changeZoom(zoom + (event.deltaY < 0 ? 1 : -1), at.x, at.y); }
    function fullscreenChange() { buttons.get('fullscreen').setAttribute('aria-pressed', String(document.fullscreenElement === root || expanded)); resize(); }
    function keydown(event) { if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); expanded = false; root.classList.remove('wt-expanded'); resize(); } }
    function getState() {
      const current = status(), location = unproject(center.x, center.y, 0), airport = screen(AIRPORT.lat, AIRPORT.lon);
      return { active: running, requestedActive, destroyed, status: current, error, observedAt: observedAt === null ? null : new Date(observedAt).toISOString(), retrievedAt: retrievedAt === null ? null : new Date(retrievedAt).toISOString(),
        snapshotAgeSeconds: observedAt === null ? null : Math.max(0, (Date.now() - observedAt) / 1000), aircraftCount: current === 'live' && trustedCollection ? aircraft.length : null, retainedAircraftCount: aircraft.length,
        aircraftCoverageVerified: current === 'live' && trustedCollection && aircraft.length > 0 && aircraft.some((row) => positionAge(row) !== null && positionAge(row) <= 180),
        aircraft: aircraft.map((row) => ({ ...row, positionAgeSeconds: positionAge(row) })), markers: markers.map((row) => ({ ...row })), airport: { ...AIRPORT, ...airport }, center: location, zoom, wheelActive,
        width, height, basemap, aerialImagery: basemap === 'imagery', imageryCaptureYear: null, airportLayout: { enabled: layoutEnabled, status: effectiveLayoutStatus(), features: layoutFeatures.length, rendered: layoutRendered, requests: layoutRequests, pending: Boolean(layoutRecord), retrievedAt: layoutRetrievedAt === null ? null : new Date(layoutRetrievedAt).toISOString(), layers: layoutLayers.map((row) => ({ ...row })), sourceUrl: layoutSource }, requests: sourceRequests, pending: sourceRecord ? 1 : 0, pendingRequests: sourceRecord ? 1 : 0, tileRequests, pendingTiles: Array.from(inflight.values()).filter((record) => !record.controller.signal.aborted).length,
        queuedTiles: queue.length, tileCacheSize: cache.size, tileCacheLimit: TILE_LIMIT, tileParallelLimit: PARALLEL, refreshTimerActive: pollTimer !== null, clockMode, databaseCalls: 0, backgroundPolling: false };
    }
    function destroy() { if (destroyed) return; requestedActive = false; stop(); destroyed = true; observer?.disconnect(); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', reconcile); document.removeEventListener('fullscreenchange', fullscreenChange); document.removeEventListener('keydown', keydown, true); window.removeEventListener('pagehide', pagehide); root.remove(); }
    function pagehide() { setActive(false); }
    tools.addEventListener('click', action); layers.addEventListener('click', layerAction); canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('click', click); canvas.addEventListener('pointerleave', leave); canvas.addEventListener('wheel', wheel, { passive: false });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; observer?.observe(root);
    window.addEventListener('resize', resize); document.addEventListener('visibilitychange', reconcile); document.addEventListener('fullscreenchange', fullscreenChange); document.addEventListener('keydown', keydown, true); window.addEventListener('pagehide', pagehide);
    resize();
    return Object.freeze({ setActive, destroy, getState });
  }
  window.cmpriWillardTracker = Object.freeze({ create, project, unproject, airport: AIRPORT });
}());
