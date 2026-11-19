/* Review-only embedded map component. No CMPRI API, database, GPS or push access.
 * NOAA requests occur only after an explicit live-feed button click, while open.
 * Road samples are schematic examples, never IDOT road reports. */
(function () {
  'use strict';
  const HOTEL = Object.freeze({ lat: 40.138080, lon: -88.251416 });
  const RADAR = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer';
  const WSSI = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer';
  const IDOT = 'https://www.gettingaroundillinois.com/WinterConditions/index.html';
  const CENTRAL = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
  const SAMPLE_START = Date.parse('2026-01-15T23:00:00Z');
  const RADIUS = 6378137;
  const $ = (id) => document.getElementById(id);
  const state = {
    initialized: false, opened: false, active: false, mapReady: false,
    mode: 'simulation', activeLayer: 'reflectivity', frame: 11, zoom: 1,
    center: { ...HOTEL }, opacity: 0.65, showRadar: true, roads: false, impacts: false,
    frames: [], radarStatus: 'Simulation only', roadsStatus: 'Simulation off',
    impactsStatus: 'Simulation off', networkRequests: 0, fetchedAt: null,
    reportTime: null, forecastIssue: null, forecastStart: null, forecastEnd: null,
    forecastFeatures: [], forecastRenderer: [], forecastExtent: null,
    forecastCoverage: { returned: 0, valid: 0, stale: 0, invalid: 0 }, error: '', viewportRevision: 0
  };
  let canvas, context, shell, observer, raf = null, loop = null, drag = null;
  let generation = 0, liveBusy = false;
  const controllers = new Set();
  const images = new Map();
  const loadingImages = new Map();
  const failedImages = new Set();
  const verified = new Map();
  const reportCells = new Map();
  const productInfo = {
    velocity: ['Local velocity · KILX', 'NOAA publishes a KILX WMS. A current velocity layer, scan time, legend and CORS have not been verified. Velocity is radar-relative motion, not surface wind.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows?service=wms&version=1.3.0&request=GetCapabilities'],
    ptype: ['Precipitation type', 'NOAA publishes a precipitation-type analysis. Current classifications and browser access are unverified. Rain, snow and ice cannot be inferred from reflectivity colors.', 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_pcpn_typ/ows?service=wms&version=1.3.0&request=GetCapabilities'],
    satellite: ['GOES-19 · Great Lakes', 'NOAA GeoColor satellite imagery covers Illinois. This review build does not embed a current satellite image.', 'https://www.star.nesdis.noaa.gov/GOES/sector.php?sat=G19&sector=cgl'],
    lightning: ['GOES-19 · Total lightning', 'NOAA GLM flash-extent density is regional total lightning. Current imagery is not embedded; no ground-strike pins or distance-to-hotel claims are made.', 'https://www.star.nesdis.noaa.gov/GOES/sector.php?sat=G19&sector=cgl']
  };
  const controls = [
    ['radar', 'Observed radar layer', 'CMPRI overlay', 'NOAA MRMS time-enabled ImageServer', 'Toggle radar independently. Default is fabricated, labeled sample echoes. Live mode uses actual catalog raster IDs and valid times.'],
    ['roads', 'Reported winter roads layer', 'CMPRI overlay', 'IDOT Getting Around Illinois; concrete data feed unverified', 'Toggle same-map road examples. Samples are schematic, off by default. Live mode leaves reports unavailable; no route safety is inferred.'],
    ['impacts', 'Forecast winter travel impacts layer', 'CMPRI overlay', 'NWS/WPC WSSI overall Days 1–3, layer 4', 'Toggle same-map regional forecast impact polygons, independently of radar and road reports. Samples are off by default.'],
    ['velocity', 'Local velocity product', 'CMPRI overlay', 'NOAA KILX WMS catalog', 'Show verified source and unavailable notice; no current velocity imagery.'],
    ['ptype', 'Precipitation type product', 'CMPRI overlay', 'NOAA CONUS precipitation-type WMS catalog', 'Show verified source and unavailable notice; no classification inferred from radar.'],
    ['satellite', 'Satellite product', 'CMPRI overlay', 'NOAA GOES-19 Great Lakes GeoColor', 'Show verified source and unavailable notice; no current image embedded.'],
    ['lightning', 'Lightning product', 'CMPRI overlay', 'NOAA GOES-19 GLM FED3 + GeoColor', 'Show verified source and unavailable notice; no strike pins or counts.'],
    ['moreNoaaProducts', 'More NOAA products · expand / collapse', 'CMPRI overlay', 'None · local presentation of official product links', 'Expand or collapse optional velocity, precipitation-type, satellite and lightning choices. This disclosure does not request a feed or change the three independent map layers.'],
    ['pin', 'Fixed hotel pin', 'Embedded map component · CMPRI-authored', 'Marriott hotel View Map coordinates', 'Plot 40.138080, −88.251416 in the same projection as every selected layer; no GPS.'],
    ['pan', 'Pan · drag / touch / arrow keys', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Move the shared viewport; every visible layer and hotel pin moves together.'],
    ['zoomIn', 'Zoom in', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Increase shared map scale; plus key also works.'],
    ['zoomOut', 'Zoom out', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Decrease shared map scale; minus key also works.'],
    ['recenter', 'Recenter', 'Embedded map component · CMPRI-authored', 'Marriott fixed hotel coordinates', 'Restore the hotel-centered initial extent without device location access.'],
    ['fullscreen', 'Fullscreen / exit', 'Embedded map component · CMPRI-authored', 'Browser Fullscreen API; CSS fallback', 'Expand the same map. Escape exits; no separate radar app or iframe.'],
    ['opacity', 'Opacity', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Change weather-layer opacity together. Hotel pin and grid retain contrast.'],
    ['legend', 'Layer legends', 'Embedded map component · CMPRI-authored', 'Radar dBZ; proposed sample road colors; WSSI renderer', 'Separate observed radar, reported road conditions, and forecast impacts. Sample and unavailable legends remain explicit.'],
    ['previousFrame', 'Previous scan', 'Embedded map component · CMPRI-authored', 'Sample times or actual NOAA catalog times', 'Pause playback and display the previous loaded catalog/sample frame.'],
    ['playLoop', 'Play / pause', 'Embedded map component · CMPRI-authored', 'Sample frames or exact NOAA catalog rasters', 'Play only while Weather is visible. Close, hidden tab, and pause stop its local timer. No prediction or future radar.'],
    ['frameRange', 'Scan seek slider', 'Embedded map component · CMPRI-authored', 'Sample times or actual NOAA catalog times', 'Pause and select one exact frame; live timestamps are never synthesized.'],
    ['nextFrame', 'Next scan', 'Embedded map component · CMPRI-authored', 'Sample times or actual NOAA catalog times', 'Pause playback and display the next loaded catalog/sample frame.'],
    ['showEchoes', 'Show radar echoes', 'Embedded map component · CMPRI-authored', 'Same radar source as selected mode', 'Hide/show radar rendering while preserving independent road and impact overlays.'],
    ['tryLiveFeeds', 'Try live feeds', 'CMPRI overlay', 'NOAA radar catalog/export; WSSI layer 4 query', 'Explicit one-time fetch while open. Clears simulations. No guessed IDOT feed, automated refresh, or background scheduler.'],
    ['mapUseDemo', 'Use simulated map', 'CMPRI overlay', 'None · fabricated local examples', 'Abort outstanding requests and return to clearly labeled demonstration geometry.'],
    ['sourceLink', 'Official product link', 'CMPRI overlay', 'Selected official NOAA/NWS product page', 'Open the source page on explicit click. It does not load a third-party app into this map.']
    ,['mapLayerTimes', 'Layer times & limits · expand / collapse', 'CMPRI overlay', 'Actual NOAA times when available; sample times clearly labeled', 'Reveal source/report/forecast validity and fetched-extent limits. Disclosure makes no request.']
    ,['mapOfficialRoadSource', 'Official IDOT source link', 'CMPRI overlay', 'IDOT Getting Around Illinois winter conditions', 'Open the verified official map on explicit click; no guessed feed or embedded third-party radar app.']
    ,['openMapReference', 'Control & source reference', 'CMPRI overlay', 'None · local review documentation', 'Switch to the Sources view and the complete control provenance table; no data request.']
  ];
  function formatTime(value) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? CENTRAL.format(date) : 'Unavailable';
  }
  function mercator(lat, lon) {
    const latitude = Math.max(-75, Math.min(75, lat));
    return { x: RADIUS * lon * Math.PI / 180,
      y: RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) };
  }
  function unproject(x, y) {
    return { lon: x / RADIUS * 180 / Math.PI,
      lat: (2 * Math.atan(Math.exp(y / RADIUS)) - Math.PI / 2) * 180 / Math.PI };
  }
  function geometry() {
    const bounds = canvas.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height,
      resolution: 620 / state.zoom, center: mercator(state.center.lat, state.center.lon) };
  }
  function project(lat, lon, geo) {
    const point = mercator(lat, lon);
    return { x: geo.width / 2 + (point.x - geo.center.x) / geo.resolution,
      y: geo.height / 2 - (point.y - geo.center.y) / geo.resolution };
  }
  function viewport(geo) {
    const halfWidth = geo.width * geo.resolution / 2;
    const halfHeight = geo.height * geo.resolution / 2;
    return { xmin: geo.center.x - halfWidth, ymin: geo.center.y - halfHeight,
      xmax: geo.center.x + halfWidth, ymax: geo.center.y + halfHeight };
  }
  function mark(id, result) {
    if (verified.get(id) === result) return;
    verified.set(id, result);
    if (reportCells.has(id)) reportCells.get(id).textContent = result;
  }
  function emit() {
    window.dispatchEvent(new CustomEvent('cmpri-weather-map-state', { detail: getState() }));
  }
  function cancelRequests() {
    generation += 1;
    controllers.forEach((controller) => controller.abort());
    controllers.clear();
    loadingImages.clear();
    liveBusy = false;
    if ($('tryLiveFeeds')) $('tryLiveFeeds').disabled = false;
  }
  function clearImages() {
    images.forEach((image) => image.bitmap.close?.());
    images.clear();
    failedImages.clear();
  }
  async function request(url, asBlob, ticket) {
    if (!state.opened || !state.active || ticket !== generation) throw new DOMException('Weather closed', 'AbortError');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'mapservices.weather.noaa.gov') throw new Error('Unverified feed host');
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    state.networkRequests += 1;
    emit();
    try {
      const response = await fetch(parsed.href, { signal: controller.signal, mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (asBlob) return await response.blob();
      const json = await response.json();
      if (json.error) throw new Error('NOAA service error ' + (json.error.code || '') + ': ' + (json.error.message || 'unavailable'));
      return json;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  function endpoint(base, method, params) {
    return base + '/' + method + '?' + new URLSearchParams(params).toString();
  }
  function fieldValue(attributes, name) {
    const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? attributes[key] : null;
  }
  function actualDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const result = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
    return Number.isFinite(result) && result > 0 && Number.isFinite(new Date(result).getTime()) ? result : null;
  }
  function refreshForecastFreshness() {
    if (state.mode !== 'live' || !state.forecastExtent) return false;
    const previous = state.impactsStatus;
    let stale = 0;
    const now = Date.now();
    state.forecastFeatures.forEach((feature) => {
      const timing = feature.reviewTiming;
      timing.stale = timing.end <= now || now - timing.issue > 6 * 3600000;
      if (timing.stale) stale += 1;
    });
    state.forecastCoverage.stale = stale;
    const coverage = state.forecastCoverage;
    state.impactsStatus = coverage.valid
      ? 'Forecast areas: ' + (coverage.valid - coverage.stale) + ' fresh, ' + coverage.stale + ' STALE / expired'
        + (coverage.invalid ? '; INCOMPLETE · ' + coverage.invalid + ' invalid-time areas omitted' : '')
      : coverage.invalid ? 'Unavailable · all ' + coverage.invalid + ' returned areas have missing / invalid forecast times'
        : 'No mapped WSSI polygons returned within the fetched extent · travel status unknown';
    return state.impactsStatus !== previous;
  }
  function imageKey(frame, geo) {
    return [frame, Math.round(geo.center.x), Math.round(geo.center.y), state.zoom.toFixed(4), Math.round(geo.width), Math.round(geo.height)].join('|');
  }
  async function loadFrame(index) {
    if (state.mode !== 'live' || !state.opened || !state.active || !state.showRadar
      || state.activeLayer !== 'reflectivity' || !state.frames[index]) return;
    const geo = geometry();
    if (!geo.width || !geo.height) return;
    const key = imageKey(index, geo);
    if (images.has(key) || loadingImages.has(key) || failedImages.has(key)) return;
    const ticket = generation;
    const raster = state.frames[index];
    const extent = viewport(geo);
    const task = (async () => {
      try {
        const data = await request(endpoint(RADAR, 'exportImage', {
          f: 'json', bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(','),
          bboxSR: '3857', imageSR: '3857',
          size: Math.round(Math.min(1200, geo.width)) + ',' + Math.round(Math.min(900, geo.height)),
          format: 'png32', transparent: 'true',
          mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: raster.ids, mosaicOperation: 'MT_FIRST' })
        }), false, ticket);
        if (!state.showRadar || state.activeLayer !== 'reflectivity' || ticket !== generation) return;
        if (!data.href || !data.extent) throw new Error('NOAA image extent / URL unavailable');
        const blob = await request(data.href, true, ticket);
        const bitmap = await createImageBitmap(blob);
        if (ticket !== generation || !state.opened || !state.active) { bitmap.close?.(); return; }
        images.set(key, { bitmap, extent: data.extent, frame: index });
        if (images.size > 36) { const first = images.keys().next().value; images.get(first).bitmap.close?.(); images.delete(first); }
        state.radarStatus = 'Observed image loaded';
        mark('radar', 'Live export loaded · actual catalog time; freshness labeled');
        updateUI(); queueDraw();
      } catch (error) {
        if (ticket !== generation) return;
        failedImages.add(key);
        state.radarStatus = error.name === 'AbortError' ? 'Unavailable · request timed out / stopped' : 'Unavailable · ' + error.message;
        mark('radar', 'Live export unavailable · no sample substituted');
        updateUI();
      } finally { loadingImages.delete(key); }
    })();
    loadingImages.set(key, task);
    return task;
  }
  async function radarCatalog(ticket) {
    state.radarStatus = 'Loading NOAA scan catalog'; updateUI();
    const metadata = await request(RADAR + '?f=json', false, ticket);
    const fields = metadata.fields || [];
    const timeField = metadata.timeInfo?.startTimeField;
    const idField = metadata.objectIdField;
    if (!timeField || !idField || !fields.some((field) => field.name.toLowerCase() === timeField.toLowerCase())) throw new Error('Catalog scan-time metadata unavailable');
    const result = await request(endpoint(RADAR, 'query', {
      f: 'json', where: 'category=1', geometry: HOTEL.lon + ',' + HOTEL.lat,
      geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: idField + ',' + timeField, returnGeometry: 'false',
      orderByFields: timeField + ' DESC', resultRecordCount: '200'
    }), false, ticket);
    if (ticket !== generation) return;
    const grouped = new Map();
    (result.features || []).forEach((feature) => {
      const timestamp = Number(fieldValue(feature.attributes || {}, timeField));
      const id = Number(fieldValue(feature.attributes || {}, idField));
      if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isInteger(id)) return;
      if (!grouped.has(timestamp)) grouped.set(timestamp, []);
      grouped.get(timestamp).push(id);
    });
    state.frames = Array.from(grouped, ([time, ids]) => ({ time, ids })).sort((a, b) => a.time - b.time).slice(-12);
    if (!state.frames.length) throw new Error('No observed scans returned for the property');
    state.frame = state.frames.length - 1;
    state.radarStatus = 'Catalog verified · loading exact observed scan';
    mark('radar', 'Catalog verified · ' + state.frames.length + ' actual scan times');
    updateUI();
    await loadFrame(state.frame);
  }
  async function impactForecast(ticket) {
    state.impactsStatus = 'Loading WSSI forecast polygons'; updateUI();
    const metadata = await request(WSSI + '/4?f=json', false, ticket);
    const actualFields = (metadata.fields || []).map((field) => field.name);
    const requested = ['impact', 'issue_time', 'start_time', 'end_time', 'idp_filedate'];
    if (!requested.every((name) => actualFields.some((field) => field.toLowerCase() === name))) throw new Error('WSSI validity / impact fields unavailable');
    const extent = viewport(geometry());
    const result = await request(endpoint(WSSI + '/4', 'query', {
      f: 'json', where: '1=1',
      geometry: JSON.stringify({ ...extent, spatialReference: { wkid: 3857 } }),
      geometryType: 'esriGeometryEnvelope', inSR: '3857', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: requested.join(','),
      returnGeometry: 'true', resultRecordCount: '1000'
    }), false, ticket);
    if (ticket !== generation) return;
    if (result.exceededTransferLimit) throw new Error('WSSI result incomplete; narrow extent required');
    const returned = (result.features || []).filter((feature) => Array.isArray(feature.geometry?.rings));
    state.forecastCoverage = { returned: returned.length, valid: 0, stale: 0, invalid: 0 };
    state.forecastExtent = extent;
    state.forecastFeatures = returned.filter((feature) => {
      const attributes = feature.attributes || {};
      const issue = actualDate(fieldValue(attributes, 'issue_time'));
      const start = actualDate(fieldValue(attributes, 'start_time'));
      const end = actualDate(fieldValue(attributes, 'end_time'));
      if (!issue || !start || !end || start >= end || issue > Date.now() + 300000) {
        state.forecastCoverage.invalid += 1;
        return false;
      }
      const stale = end <= Date.now() || Date.now() - issue > 6 * 3600000;
      feature.reviewTiming = { issue, start, end, stale };
      state.forecastCoverage.valid += 1;
      if (stale) state.forecastCoverage.stale += 1;
      return true;
    });
    state.forecastRenderer = metadata.drawingInfo?.renderer?.uniqueValueInfos || [];
    const timings = state.forecastFeatures.map((feature) => feature.reviewTiming);
    state.forecastIssue = timings.length ? Math.max(...timings.map((timing) => timing.issue)) : null;
    state.forecastStart = timings.length ? Math.min(...timings.map((timing) => timing.start)) : null;
    state.forecastEnd = timings.length ? Math.max(...timings.map((timing) => timing.end)) : null;
    const coverage = state.forecastCoverage;
    refreshForecastFreshness();
    mark('impacts', coverage.valid ? 'Live query loaded · per-area validity checked; stale / omitted counts shown' : coverage.invalid ? 'Live query incomplete · invalid-time geometry omitted' : 'Live query succeeded · empty coverage, not all-clear');
    updateUI(); queueDraw();
  }
  async function tryLive() {
    if (!state.opened || !state.active || liveBusy) return;
    stopPlayback(); cancelRequests(); clearImages();
    liveBusy = true;
    state.mode = 'live'; state.frames = []; state.forecastFeatures = []; state.forecastExtent = null;
    state.forecastCoverage = { returned: 0, valid: 0, stale: 0, invalid: 0 };
    state.forecastIssue = null; state.forecastStart = null; state.forecastEnd = null;
    state.radarStatus = 'Loading'; state.impactsStatus = 'Loading';
    state.roadsStatus = 'Unavailable · exact IDOT feed / report timestamps unverified';
    mark('roads', 'Live unavailable · concrete IDOT feed / report time unverified');
    state.fetchedAt = null; state.error = '';
    if ($('tryLiveFeeds')) $('tryLiveFeeds').disabled = true;
    const ticket = generation;
    mark('tryLiveFeeds', 'Explicit live attempt started · no automatic polling');
    updateUI(); queueDraw();
    const results = await Promise.allSettled([radarCatalog(ticket), impactForecast(ticket)]);
    if (ticket !== generation || !state.opened || !state.active) return;
    if (results[0].status === 'rejected') {
      state.radarStatus = 'Unavailable · ' + results[0].reason.message;
      mark('radar', 'Live catalog unavailable · no sample substituted');
    }
    if (results[1].status === 'rejected') {
      state.impactsStatus = 'Unavailable · ' + results[1].reason.message;
      mark('impacts', 'Live query unavailable · no sample substituted');
    }
    state.fetchedAt = Date.now();
    liveBusy = false;
    if ($('tryLiveFeeds')) $('tryLiveFeeds').disabled = false;
    mark('tryLiveFeeds', 'One-time attempts complete · ' + state.networkRequests + ' actual NOAA requests this session');
    updateUI(); queueDraw(); emit();
  }
  function useSimulation() {
    stopPlayback(); cancelRequests(); clearImages();
    state.mode = 'simulation'; state.frames = []; state.frame = 11;
    state.radarStatus = 'Simulated echoes'; state.forecastFeatures = []; state.forecastExtent = null;
    state.forecastCoverage = { returned: 0, valid: 0, stale: 0, invalid: 0 };
    state.roadsStatus = state.roads ? 'Simulated schematic road examples' : 'Simulation off';
    state.impactsStatus = state.impacts ? 'Simulated forecast impact examples' : 'Simulation off';
    state.fetchedAt = null; state.forecastIssue = null; state.forecastStart = null; state.forecastEnd = null;
    mark('mapUseDemo', 'Exercised · requests aborted and simulated mode restored');
    updateUI(); queueDraw(); emit();
  }
  function drawGrid(geo) {
    context.fillStyle = '#141d20'; context.fillRect(0, 0, geo.width, geo.height);
    context.font = '10px Arial'; context.lineWidth = 1;
    const bounds = viewport(geo), southwest = unproject(bounds.xmin, bounds.ymin), northeast = unproject(bounds.xmax, bounds.ymax);
    const step = state.zoom >= 3 ? 0.1 : state.zoom >= 1.3 ? 0.25 : 0.5;
    context.strokeStyle = '#304044'; context.fillStyle = '#7e9398';
    for (let lon = Math.floor(southwest.lon / step) * step; lon < northeast.lon + step; lon += step) {
      const point = project(state.center.lat, lon, geo);
      context.beginPath(); context.moveTo(point.x, 0); context.lineTo(point.x, geo.height); context.stroke();
      if (point.x > 3 && point.x < geo.width - 48) context.fillText(Math.abs(lon).toFixed(2) + (lon < 0 ? '°W' : '°E'), point.x + 5, geo.height - 34);
    }
    for (let lat = Math.floor(southwest.lat / step) * step; lat < northeast.lat + step; lat += step) {
      const point = project(lat, state.center.lon, geo);
      context.beginPath(); context.moveTo(0, point.y); context.lineTo(geo.width, point.y); context.stroke();
      if (point.y > 54 && point.y < geo.height - 42) context.fillText(Math.abs(lat).toFixed(2) + (lat < 0 ? '°S' : '°N'), 8, point.y - 6);
    }
  }
  function polygon(rings, geo, fill, stroke, dashed) {
    context.save(); context.beginPath();
    rings.forEach((ring) => ring.forEach((coordinate, index) => {
      const point = project(coordinate[1], coordinate[0], geo);
      if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y);
    }));
    context.closePath(); context.fillStyle = fill; context.fill('evenodd');
    context.strokeStyle = stroke; context.lineWidth = 1.5;
    if (dashed) context.setLineDash([5, 4]);
    context.stroke(); context.restore();
  }
  function drawImpacts(geo) {
    if (!state.impacts) return;
    if (state.mode === 'simulation') {
      const shapes = [
        { ring: [[-88.95, 39.75], [-88.27, 39.65], [-88.01, 40.15], [-88.13, 40.55], [-88.86, 40.52]], fill: '#faf5a331', stroke: '#faf5a3' },
        { ring: [[-88.38, 39.73], [-87.72, 39.82], [-87.60, 40.40], [-88.10, 40.64], [-88.01, 40.15]], fill: '#f7962f38', stroke: '#f7962f' }
      ];
      context.save(); context.globalAlpha = state.opacity;
      shapes.forEach((shape) => polygon([shape.ring], geo, shape.fill, shape.stroke, true));
      context.restore();
      mark('impacts', 'Simulation rendered · fabricated forecast example polygons');
      return;
    }
    state.forecastFeatures.forEach((feature) => {
      const category = String(fieldValue(feature.attributes || {}, 'impact') || '');
      const renderer = state.forecastRenderer.find((item) => String(item.value).toUpperCase() === category.toUpperCase());
      const rgba = renderer?.symbol?.color || [180, 190, 199, 255];
      const color = rgba.slice(0, 3).join(',');
      const stale = feature.reviewTiming.stale;
      context.save(); context.globalAlpha = state.opacity;
      polygon(feature.geometry.rings, geo, 'rgba(' + color + ',.20)', 'rgb(' + color + ')', stale);
      context.restore();
    });
    if (state.forecastExtent) {
      const e = state.forecastExtent;
      const left = geo.width / 2 + (e.xmin - geo.center.x) / geo.resolution;
      const top = geo.height / 2 - (e.ymax - geo.center.y) / geo.resolution;
      context.save(); context.strokeStyle = '#b6c3c5'; context.lineWidth = 1; context.setLineDash([3, 6]);
      context.strokeRect(left, top, (e.xmax - e.xmin) / geo.resolution, (e.ymax - e.ymin) / geo.resolution); context.restore();
    }
  }
  function drawRadar(geo) {
    if (!state.showRadar || state.activeLayer !== 'reflectivity') return;
    context.save(); context.globalAlpha = state.opacity;
    if (state.mode === 'simulation') {
      const drift = state.frame * 0.026;
      [{ width: 0.25, color: '#387c57' }, { width: 0.16, color: '#48a565' }, { width: 0.075, color: '#9ebc58' }].forEach((contour, index) => {
        const left = [], right = [];
        for (let i = 0; i <= 64; i += 1) {
          const lat = HOTEL.lat - 1.65 + i * 0.052;
          const axis = HOTEL.lon - 0.9 + drift + Math.sin(i * 0.18) * 0.13 + Math.sin(i * 0.51) * 0.03;
          const width = contour.width * (0.72 + Math.sin(i * 0.29 + index) * 0.19 + Math.sin(i * 0.71) * 0.10);
          left.push(project(lat, axis - width, geo)); right.push(project(lat, axis + width, geo));
        }
        context.beginPath();
        left.concat(right.reverse()).forEach((point, i) => i ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.closePath(); context.fillStyle = contour.color; context.fill();
      });
      mark('radar', 'Simulation rendered · fabricated echoes, no observed data');
    } else {
      const exact = images.get(imageKey(state.frame, geo));
      const fallback = exact || Array.from(images.values()).reverse().find((image) => image.frame === state.frame);
      if (fallback) {
        const e = fallback.extent;
        const x = geo.width / 2 + (e.xmin - geo.center.x) / geo.resolution;
        const y = geo.height / 2 - (e.ymax - geo.center.y) / geo.resolution;
        context.drawImage(fallback.bitmap, x, y, (e.xmax - e.xmin) / geo.resolution, (e.ymax - e.ymin) / geo.resolution);
      }
    }
    context.restore();
  }
  function drawRoads(geo) {
    if (!state.roads || state.mode !== 'simulation') return;
    const paths = [
      { color: '#72c1ee', points: [[40.30, -88.91], [40.25, -88.59], [40.22, -88.20], [40.15, -87.76]] },
      { color: '#f49bd0', points: [[39.70, -88.60], [39.95, -88.42], [40.20, -88.30], [40.56, -88.14]] },
      { color: '#d763d0', points: [[40.48, -88.87], [40.12, -88.72], [39.92, -88.43], [39.79, -88.07]] }
    ];
    context.save(); context.globalAlpha = state.opacity; context.lineJoin = 'round'; context.lineCap = 'round';
    paths.forEach((path) => {
      context.beginPath(); path.points.forEach(([lat, lon], index) => { const point = project(lat, lon, geo); if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y); });
      context.strokeStyle = '#101417'; context.lineWidth = 8; context.stroke();
      context.strokeStyle = path.color; context.lineWidth = 4; context.stroke();
    });
    context.restore();
    mark('roads', 'Simulation rendered · schematic lines, no IDOT report');
  }
  function drawPin(geo) {
    const pin = project(HOTEL.lat, HOTEL.lon, geo);
    if (pin.x < 0 || pin.x > geo.width || pin.y < 0 || pin.y > geo.height) {
      context.fillStyle = '#ffcd00'; context.font = '11px Arial'; context.fillText('Hotel offscreen · use recenter', 12, geo.height - 58); return;
    }
    context.strokeStyle = '#ffcd0045'; context.lineWidth = 1;
    context.beginPath(); context.arc(pin.x, pin.y, 25, 0, Math.PI * 2); context.stroke();
    context.fillStyle = '#ffcd00'; context.strokeStyle = '#111'; context.lineWidth = 2;
    context.beginPath(); context.arc(pin.x, pin.y, 7, 0, Math.PI * 2); context.fill(); context.stroke();
    context.beginPath(); context.moveTo(pin.x, pin.y + 14); context.lineTo(pin.x - 5, pin.y + 5); context.lineTo(pin.x + 5, pin.y + 5); context.closePath(); context.fill();
    context.font = '11px Arial';
    const text = geo.width < 420 ? 'Residence Inn' : 'Residence Inn Champaign';
    const width = context.measureText(text).width;
    const left = Math.max(4, Math.min(geo.width - width - 22, pin.x - width / 2 - 10));
    context.fillStyle = '#0a1112ef'; context.fillRect(left, pin.y + 20, width + 20, 24);
    context.fillStyle = '#ffdc55'; context.fillText(text, left + 10, pin.y + 36);
    mark('pin', 'Rendered at verified fixed coordinates · no GPS');
  }
  function draw() {
    raf = null;
    if (!state.opened || !state.active || document.hidden || !context) return;
    if (refreshForecastFreshness()) updateUI();
    const geo = geometry();
    if (!geo.width || !geo.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(geo.width * ratio); canvas.height = Math.round(geo.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawGrid(geo); drawImpacts(geo); drawRadar(geo); drawRoads(geo); drawPin(geo);
    context.font = '10px Arial'; context.fillStyle = '#a5b2b6'; context.textAlign = 'right';
    context.fillText('Coordinate grid · no street basemap', geo.width - 12, geo.height - 12); context.textAlign = 'left';
    mark('legend', 'Rendered · separate source/type labels for selected layers');
  }
  function queueDraw() {
    if (state.opened && state.active && !document.hidden && raf === null) raf = requestAnimationFrame(draw);
  }
  function frameCount() { return state.mode === 'simulation' ? 12 : state.frames.length; }
  function scanTime() {
    if (!state.showRadar || state.activeLayer !== 'reflectivity') return 'Radar off · independent road / forecast overlays remain available';
    if (state.mode === 'simulation') return 'SIMULATED scan ' + (state.frame + 1) + '/12 · ' + formatTime(SAMPLE_START + state.frame * 300000);
    if (!state.frames[state.frame]) return 'Observed radar scan time unavailable · no sample substituted';
    const time = state.frames[state.frame].time;
    return (Date.now() - time > 20 * 60000 ? 'STALE · ' : 'OBSERVED · ') + formatTime(time) + ' · actual NOAA catalog time · ' + state.radarStatus;
  }
  function legendItem(label, color) {
    const item = document.createElement('span'); item.className = 'cmpri-map-legend-item';
    const swatch = document.createElement('span'); swatch.className = 'cmpri-map-swatch'; swatch.style.backgroundColor = color;
    item.append(swatch, document.createTextNode(label)); return item;
  }
  function renderLegend() {
    const host = $('mapLegend'); if (!host) return;
    const fragment = document.createDocumentFragment();
    if (state.showRadar && state.activeLayer === 'reflectivity') {
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row';
      const heading = document.createElement('strong'); heading.textContent = (state.mode === 'simulation' ? 'SIMULATED radar' : state.frames.length ? 'Observed radar' : 'Observed radar · UNAVAILABLE') + ' · dBZ'; row.append(heading);
      const colors = [['10', '#58bf6f'], ['25', '#28a153'], ['40', '#dfd956'], ['55', '#ec913f'], ['70', '#ae5297']];
      colors.forEach(([label, color]) => row.append(legendItem(label, color))); fragment.append(row);
    }
    if (state.roads) {
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row';
      const heading = document.createElement('strong'); heading.textContent = state.mode === 'simulation' ? 'SIMULATED road reports · schematic geometry' : 'IDOT reported roads · UNAVAILABLE'; row.append(heading);
      if (state.mode === 'simulation') [['Partly covered', '#72c1ee'], ['Mostly covered', '#f49bd0'], ['Covered', '#d763d0']].forEach(([label, color]) => row.append(legendItem(label, color)));
      fragment.append(row);
    }
    if (state.impacts) {
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row';
      const heading = document.createElement('strong'); heading.textContent = state.mode === 'simulation' ? 'SIMULATED forecast impacts' : 'WSSI forecast impacts · Days 1–3'; row.append(heading);
      if (state.mode === 'simulation') [['Minor example', '#faf5a3'], ['Moderate example', '#f7962f']].forEach(([label, color]) => row.append(legendItem(label, color)));
      else state.forecastRenderer.forEach((item) => row.append(legendItem(item.label || item.value, 'rgb(' + (item.symbol?.color || [180, 190, 199]).slice(0, 3).join(',') + ')')));
      if (state.mode === 'live' && state.forecastCoverage.stale) {
        const note = document.createElement('span'); note.textContent = 'Dashed outlines: stale / expired forecast areas'; row.append(note);
      }
      fragment.append(row);
    }
    const empty = !fragment.childNodes.length;
    host.replaceChildren(fragment); host.hidden = empty;
  }
  function updateUI() {
    if (!state.initialized) return;
    refreshForecastFreshness();
    const count = frameCount();
    const radarAvailable = state.showRadar && state.activeLayer === 'reflectivity' && count > 0;
    ['previousFrame', 'playLoop', 'frameRange', 'nextFrame'].forEach((id) => { if ($(id)) $(id).disabled = !radarAvailable; });
    if ($('frameRange')) { $('frameRange').max = Math.max(0, count - 1); $('frameRange').value = state.frame; $('frameRange').setAttribute('aria-label', state.mode === 'simulation' ? 'Simulated radar frame' : 'Observed NOAA radar scan'); }
    if ($('scanTime')) $('scanTime').textContent = scanTime();
    if ($('loopLabel')) $('loopLabel').textContent = count ? (state.mode === 'simulation' ? 'Simulated' : 'Observed') + ' loop · ' + count + ' frames' : 'No observed scans available';
    if ($('mapOpacity')) $('mapOpacity').value = Math.round(state.opacity * 100);
    if ($('opacityValue')) $('opacityValue').textContent = Math.round(state.opacity * 100) + '%';
    if ($('showEchoes')) {
      $('showEchoes').checked = state.showRadar;
      const last = $('showEchoes').parentElement.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) last.textContent = 'Show radar echoes';
    }
    if ($('mapLayerRadar')) $('mapLayerRadar').checked = state.showRadar;
    if ($('mapLayerRoads')) $('mapLayerRoads').checked = state.roads;
    if ($('mapLayerImpacts')) $('mapLayerImpacts').checked = state.impacts;
    const selected = [];
    if (state.showRadar && state.activeLayer === 'reflectivity') selected.push('radar');
    if (state.roads) selected.push('road reports'); if (state.impacts) selected.push('forecast impacts');
    if ($('mapStatus')) $('mapStatus').textContent = state.mode === 'simulation' ? 'SIMULATED · ' + (selected.join(' + ') || 'coordinate map') + ' · NOT LIVE WEATHER / ROAD DATA' : 'LIVE ATTEMPT · ' + (selected.join(' + ') || 'coordinate map') + ' · failures remain unavailable';
    if (canvas) {
      const radar = state.mode === 'simulation' ? 'Fabricated radar and overlay examples for interface review; no live weather or road data.'
        : state.showRadar && state.frames.length && images.size ? 'Observed NOAA radar catalog frames; current scan freshness is shown beside playback controls.'
          : 'Live mode; observed radar unavailable or not selected. Missing data does not mean clear weather.';
      const overlays = ' Road reports: ' + (!state.roads ? 'off.' : state.mode === 'simulation' ? 'schematic simulated lines, not actual IDOT reports.' : 'unavailable; exact IDOT feed unverified.')
        + ' Forecast impacts: ' + (!state.impacts ? 'off.' : state.mode === 'simulation' ? 'simulated polygons, not a WSSI forecast.' : state.impactsStatus + '.');
      canvas.setAttribute('aria-label', 'Weather map at verified Residence Inn Champaign coordinates. ' + radar + overlays + ' Drag or use arrow keys to pan; plus and minus to zoom.');
    }
    if ($('mapModeBadge')) $('mapModeBadge').textContent = state.mode === 'simulation' ? 'Simulated map' : 'See live layer status';
    if ($('observedRadarNote')) $('observedRadarNote').textContent = state.mode === 'simulation'
      ? 'All visible weather / road geometry is simulated. Observed scans require a successful NOAA catalog and image response. IDOT road reports and WSSI forecast impacts are independent layers; missing reports do not mean clear roads.'
      : 'Live mode contains no sample geometry. Radar scan times come from the NOAA catalog; export failures stay unavailable. IDOT reported roads remain unavailable because the concrete service and report timestamps are unverified.';
    const unavailable = productInfo[state.activeLayer];
    if ($('layerUnavailable')) $('layerUnavailable').hidden = !unavailable;
    if (unavailable) {
      if ($('layerTitle')) $('layerTitle').textContent = unavailable[0];
      if ($('layerDescription')) $('layerDescription').textContent = unavailable[1];
      if ($('layerSource')) $('layerSource').href = unavailable[2];
    }
    document.querySelectorAll('#productTabs [data-layer]').forEach((button) => {
      const name = button.dataset.layer; button.setAttribute('aria-pressed', String(name === state.activeLayer || (name === 'winter' && state.impacts)));
    });
    if ($('mapRoadStatus')) $('mapRoadStatus').textContent = state.mode === 'simulation' ? (state.roads ? 'SIMULATED road examples · report time fabricated for review: Jan 15, 2026, 5 PM CST. Schematic lines are not actual maintained routes.' : 'Road sample off. Live IDOT reports unavailable; exact feed and report timestamps unverified.') : state.roadsStatus + '. Report time unavailable. Missing reports do not mean clear roads.';
    if ($('mapImpactStatus')) $('mapImpactStatus').textContent = state.mode === 'simulation' ? (state.impacts ? 'SIMULATED forecast impact areas · example valid Jan 15–17, 2026. Fabricated boundaries, not a WSSI forecast.' : 'Forecast impact sample off. WSSI is regional impact guidance, not road-surface reports.') : state.impactsStatus + ' · issued: ' + formatTime(state.forecastIssue) + ' · valid: ' + formatTime(state.forecastStart) + ' → ' + formatTime(state.forecastEnd) + '. Coverage is limited to the extent fetched on the last explicit attempt; panning does not query new forecast areas.';
    if ($('mapFeedStatus')) $('mapFeedStatus').textContent = state.mode === 'simulation' ? 'Review samples only. No feed request is made on open. “Try live feeds” clears samples and explicitly attempts NOAA once.' : 'Radar: ' + state.radarStatus + ' · WSSI: ' + state.impactsStatus + ' · IDOT reports unavailable.' + (state.fetchedAt ? ' Attempt completed: ' + formatTime(state.fetchedAt) + '. This is fetch time, not report time.' : '');
    renderLegend(); emit();
  }
  function stopPlayback() {
    if (loop !== null) { clearInterval(loop); loop = null; }
    if ($('playLoop')) { $('playLoop').textContent = '▶ Play'; $('playLoop').setAttribute('aria-label', state.mode === 'simulation' ? 'Play simulated radar loop' : 'Play observed NOAA radar loop'); }
    emit();
  }
  function setFrame(index, source) {
    const count = frameCount(); if (!count) return;
    state.frame = (index + count) % count;
    if (source) mark(source, 'Exercised · exact ' + (state.mode === 'simulation' ? 'sample' : 'catalog') + ' frame selected');
    updateUI(); queueDraw();
    if (state.mode === 'live') void loadFrame(state.frame);
  }
  function play() {
    if (loop !== null) { stopPlayback(); mark('playLoop', 'Exercised · playback paused'); return; }
    if (!state.opened || !state.active || document.hidden || !state.showRadar || state.activeLayer !== 'reflectivity' || !frameCount()) return;
    loop = setInterval(() => setFrame(state.frame + 1), 850);
    if ($('playLoop')) { $('playLoop').textContent = 'Ⅱ Pause'; $('playLoop').setAttribute('aria-label', 'Pause radar loop'); }
    mark('playLoop', 'Exercised · local playback; stops on close / hidden view'); emit();
  }
  function zoomBy(factor, source) {
    state.zoom = Math.max(0.45, Math.min(9, state.zoom * factor));
    state.viewportRevision += 1; mark(source, 'Exercised · shared map zoom now ' + state.zoom.toFixed(2) + '×');
    queueDraw(); if (state.mode === 'live') void loadFrame(state.frame); emit();
  }
  function selectLayer(name, enabled) {
    init(); stopPlayback();
    if (name === 'roads') { state.roads = enabled === undefined ? !state.roads : Boolean(enabled); if (state.mode === 'simulation') state.roadsStatus = state.roads ? 'Simulated schematic road examples' : 'Simulation off'; mark('roads', state.roads ? 'Selected · ' + (state.mode === 'simulation' ? 'schematic simulation only' : 'live IDOT unavailable') : 'Exercised · road overlay hidden'); }
    else if (name === 'impacts' || name === 'winter') { state.impacts = enabled === undefined ? !state.impacts : Boolean(enabled); if (state.mode === 'simulation') state.impactsStatus = state.impacts ? 'Simulated forecast impact examples' : 'Simulation off'; mark('impacts', state.impacts ? 'Selected · ' + (state.mode === 'simulation' ? 'forecast simulation only' : state.impactsStatus) : 'Exercised · forecast overlay hidden'); }
    else if (name === 'radar' || name === 'reflectivity') { state.activeLayer = 'reflectivity'; state.showRadar = enabled === undefined ? true : Boolean(enabled); mark('radar', 'Exercised · radar ' + (state.showRadar ? 'shown' : 'hidden')); }
    else if (productInfo[name]) { state.activeLayer = name; state.showRadar = false; mark(name, 'Exercised · unavailable notice and official source shown'); }
    updateUI(); queueDraw();
    if (state.mode === 'live' && state.showRadar) void loadFrame(state.frame);
    return getState();
  }
  function renderControls() {
    const host = $('mapControlHost'); if (!host) return;
    const liveButton = $('tryLiveFeeds');
    const referenceLink = $('openMapReference');
    host.innerHTML = '<fieldset class="cmpri-map-layer-controls"><legend>Layers on this map · select independently</legend><label><input type="checkbox" id="mapLayerRadar" checked> Radar</label><label><input type="checkbox" id="mapLayerRoads"> Reported Illinois winter roads</label><label><input type="checkbox" id="mapLayerImpacts"> Forecast winter travel impacts</label></fieldset><div class="cmpri-map-mode-row"><button type="button" id="mapUseDemo">Use simulated map</button><span id="mapFeedStatus" class="cmpri-map-status-copy" role="status"></span></div><details class="cmpri-map-source-detail" id="mapLayerTimes"><summary>Layer times &amp; limits</summary><p id="mapRoadStatus"></p><p id="mapImpactStatus"></p><p>IDOT reports cover maintained highways, not every local street, the hotel driveway, or its parking lot. Forecast impact areas are separate from reported road surfaces. Neither guarantees a clear route.</p><a id="mapOfficialRoadSource" href="' + IDOT + '" target="_blank" rel="noopener noreferrer">Official IDOT reported winter road conditions ↗</a></details>';
    const modeRow = host.querySelector('.cmpri-map-mode-row');
    if (liveButton) modeRow.prepend(liveButton);
    if (referenceLink) modeRow.append(referenceLink);
    if ($('mapLayerControlsHost')) $('mapLayerControlsHost').append(host.querySelector('.cmpri-map-layer-controls'));
    $('mapLayerRadar').addEventListener('change', (event) => selectLayer('radar', event.target.checked));
    $('mapLayerRoads').addEventListener('change', (event) => selectLayer('roads', event.target.checked));
    $('mapLayerImpacts').addEventListener('change', (event) => selectLayer('impacts', event.target.checked));
    $('mapUseDemo').addEventListener('click', useSimulation);
  }
  function renderReport() {
    const host = $('mapControlReport'); if (!host) return;
    const intro = document.createElement('p'); intro.className = 'cmpri-map-report-intro';
    intro.textContent = 'This is a CMPRI-authored embedded map component, not an iframe, third-party radar app, or provider-native control set. All layers share its Web Mercator viewport. Verification below records what has actually rendered or been exercised in this browser session; published sources do not establish current data access.';
    const wrapper = document.createElement('div'); wrapper.className = 'cmpri-map-report-scroll';
    const table = document.createElement('table'); table.className = 'cmpri-map-control-table';
    const caption = document.createElement('caption'); caption.textContent = 'Every map layer and control: owner, source, precise effect, and test status';
    table.append(caption);
    const head = document.createElement('thead'), heading = document.createElement('tr');
    ['Layer / control', 'Owner', 'Official source or none', 'Effect', 'Verified test status'].forEach((label) => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; heading.append(cell); });
    head.append(heading); table.append(head);
    const body = document.createElement('tbody');
    controls.forEach(([id, label, owner, source, effect]) => {
      const row = document.createElement('tr'); row.dataset.controlReport = id;
      [label, owner, source, effect, verified.get(id) || 'Implemented; not yet exercised in this session'].forEach((text, index) => { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); if (index === 4) reportCells.set(id, cell); });
      body.append(row);
    });
    table.append(body); wrapper.append(table); host.replaceChildren(intro, wrapper);
  }
  function init() {
    if (state.initialized) return window.cmpriWeatherMap;
    canvas = $('radarCanvas'); shell = $('mapShell');
    if (!canvas || !shell) return window.cmpriWeatherMap;
    state.initialized = true; renderControls(); renderReport();
    const on = (id, event, handler) => { if ($(id)) $(id).addEventListener(event, handler); };
    on('tryLiveFeeds', 'click', tryLive);
    on('moreNoaaProducts', 'toggle', () => mark('moreNoaaProducts', 'Exercised · optional NOAA product choices ' + ($('moreNoaaProducts').open ? 'expanded' : 'collapsed') + '; no feed request'));
    on('mapLayerTimes', 'toggle', () => mark('mapLayerTimes', 'Exercised · layer times / limits ' + ($('mapLayerTimes').open ? 'expanded' : 'collapsed') + '; no feed request'));
    on('mapOfficialRoadSource', 'click', () => mark('mapOfficialRoadSource', 'Exercised · explicit official IDOT source navigation'));
    on('openMapReference', 'click', () => mark('openMapReference', 'Exercised · local control / source reference opened'));
    on('playLoop', 'click', play);
    on('previousFrame', 'click', () => { stopPlayback(); setFrame(state.frame - 1, 'previousFrame'); });
    on('nextFrame', 'click', () => { stopPlayback(); setFrame(state.frame + 1, 'nextFrame'); });
    on('frameRange', 'input', (event) => { stopPlayback(); setFrame(Number(event.target.value), 'frameRange'); });
    on('mapOpacity', 'input', (event) => { state.opacity = Number(event.target.value) / 100; mark('opacity', 'Exercised · weather-layer opacity ' + Math.round(state.opacity * 100) + '%'); updateUI(); queueDraw(); });
    on('showEchoes', 'change', (event) => { stopPlayback(); state.showRadar = event.target.checked; if (state.showRadar) state.activeLayer = 'reflectivity'; mark('showEchoes', 'Exercised · radar echoes ' + (state.showRadar ? 'shown' : 'hidden') + '; playback stopped'); updateUI(); queueDraw(); if (state.showRadar && state.mode === 'live') void loadFrame(state.frame); });
    on('zoomIn', 'click', () => zoomBy(1.4, 'zoomIn'));
    on('zoomOut', 'click', () => zoomBy(1 / 1.4, 'zoomOut'));
    on('recenter', 'click', () => { state.center = { ...HOTEL }; state.zoom = 1; state.viewportRevision += 1; mark('recenter', 'Exercised · fixed hotel center and initial zoom restored'); queueDraw(); if (state.mode === 'live') void loadFrame(state.frame); emit(); });
    on('fullscreen', 'click', async () => {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else if (shell.classList.contains('expanded')) shell.classList.remove('expanded');
      else { try { await shell.requestFullscreen(); } catch { shell.classList.add('expanded'); } }
      mark('fullscreen', 'Exercised · same-map fullscreen toggled'); queueDraw();
    });
    on('layerSource', 'click', () => mark('sourceLink', 'Exercised · explicit official source navigation'));
    on('productTabs', 'click', (event) => { const button = event.target.closest('[data-layer]'); if (button) selectLayer(button.dataset.layer); });
    document.addEventListener('fullscreenchange', () => { if ($('fullscreen')) $('fullscreen').setAttribute('aria-label', document.fullscreenElement === shell ? 'Exit map fullscreen' : 'Toggle map fullscreen'); queueDraw(); });
    canvas.addEventListener('pointerdown', (event) => {
      drag = { x: event.clientX, y: event.clientY, center: mercator(state.center.lat, state.center.lon), geo: geometry() };
      canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      state.center = unproject(drag.center.x - (event.clientX - drag.x) * drag.geo.resolution, drag.center.y + (event.clientY - drag.y) * drag.geo.resolution);
      state.center.lat = Math.max(-75, Math.min(75, state.center.lat)); queueDraw();
      mark('pan', 'Exercised · pointer / touch moves shared viewport');
    });
    const endDrag = () => { const moved = Boolean(drag); drag = null; canvas.classList.remove('dragging'); if (moved && state.mode === 'live') void loadFrame(state.frame); emit(); };
    canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag); canvas.addEventListener('lostpointercapture', endDrag);
    canvas.addEventListener('keydown', (event) => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.4, 'zoomIn'); }
      else if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.4, 'zoomOut'); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); const geo = geometry(), move = geo.resolution * 50;
        state.center = unproject(geo.center.x + (event.key === 'ArrowRight' ? move : event.key === 'ArrowLeft' ? -move : 0), geo.center.y + (event.key === 'ArrowUp' ? move : event.key === 'ArrowDown' ? -move : 0));
        mark('pan', 'Exercised · keyboard arrow moves shared viewport'); queueDraw(); if (state.mode === 'live') void loadFrame(state.frame); emit();
      }
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && shell.classList.contains('expanded')) { event.preventDefault(); event.stopPropagation(); shell.classList.remove('expanded'); queueDraw(); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else if (state.opened) resume(); });
    window.addEventListener('pagehide', close);
    updateUI(); return window.cmpriWeatherMap;
  }
  function open() {
    init(); if (!state.initialized) return getState();
    state.opened = true; state.active = true;
    if (!state.mapReady) { context = canvas.getContext('2d'); observer = new ResizeObserver(queueDraw); state.mapReady = true; }
    observer.observe(canvas); updateUI(); queueDraw(); emit(); return getState();
  }
  function pause() {
    state.active = false; stopPlayback(); cancelRequests();
    if (state.mode === 'live') {
      if (/Loading|loading/.test(state.radarStatus)) state.radarStatus = 'Unavailable · request stopped when view became inactive';
      if (/Loading|loading/.test(state.impactsStatus)) state.impactsStatus = 'Unavailable · request stopped when view became inactive';
    }
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    emit(); return getState();
  }
  function resume() {
    if (!state.opened || document.hidden) return getState();
    state.active = true; queueDraw(); updateUI(); return getState();
  }
  function close() {
    pause(); state.opened = false; observer?.disconnect();
    if (document.fullscreenElement === shell) void document.exitFullscreen().catch(() => {});
    shell?.classList.remove('expanded'); emit(); return getState();
  }
  function getState() {
    return { initialized: state.initialized, opened: state.opened, active: state.active,
      mapReady: state.mapReady, mode: state.mode, activeLayer: state.activeLayer,
      layers: { radar: state.showRadar, roads: state.roads, impacts: state.impacts },
      frame: state.frame, frameCount: frameCount(), playing: loop !== null,
      center: { ...state.center }, zoom: state.zoom, opacity: state.opacity,
      networkRequests: state.networkRequests, pendingRequests: controllers.size,
      databaseCalls: 0, pushes: 0,
      status: { radar: state.radarStatus, roads: state.roadsStatus, impacts: state.impactsStatus },
      fetchedAt: state.fetchedAt, forecastIssue: state.forecastIssue,
      forecastStart: state.forecastStart, forecastEnd: state.forecastEnd,
      forecastCoverage: { ...state.forecastCoverage }, forecastExtent: state.forecastExtent ? { ...state.forecastExtent } : null,
      scanTimes: state.mode === 'live' ? state.frames.map((frame) => frame.time) : [],
      verified: Object.fromEntries(verified) };
  }
  window.cmpriWeatherMap = { init, open, close, pause, resume, getState, selectLayer };
}());
