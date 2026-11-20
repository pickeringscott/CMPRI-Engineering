/* Review-only embedded map component. No application records, database, GPS or push access.
 * Actual NOAA requests begin when Weather opens and refresh only while its map is visible.
 * Missing IDOT reports remain unavailable. No fabricated weather geometry. */
(function () {
  'use strict';
  const HOTEL = Object.freeze({ lat: 40.138080, lon: -88.251416 });
  const REFLECTIVITY = Object.freeze({ product: 'reflectivity', layer: 'conus_bref_qcd', style: 'radar_reflectivity',
    source: 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows' });
  const WSSI = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer';
  const CENTRAL = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
  const RADIUS = 6378137;
  const REFRESH_INTERVAL = 5 * 60 * 1000;
  const PLAYBACK_SPEEDS = Object.freeze(['slow', 'normal', 'fast']);
  // Fixed official exports verified as georeferenced PNGs on the branch preview.
  const GEOGRAPHIC_REFERENCE_ENABLED = true;
  const $ = (id) => document.getElementById(id);
  const state = {
    initialized: false, opened: false, active: false, mapReady: false,
    mode: 'live', activeLayer: 'reflectivity', frame: 0, zoom: 4,
    backgroundStyle: 'aerial', grid: false, playbackSpeed: 'normal', loopMinutes: 90, wheelZoomActive: false,
    catalogFrames: [], displayedTime: null,
    showAlerts: true, alerts: [], alertStatus: 'Unknown · waiting for the NWS property alert response',
    alertSource: null, alertCheckedAt: null, alertGeometryless: 0,
    center: { ...HOTEL }, opacity: 0.65, showRadar: true, roads: false, impacts: false,
    frames: [], radarStatus: 'Waiting for Weather to open', roadsStatus: 'Unavailable · exact IDOT feed / report timestamps unverified',
    impactsStatus: 'Waiting for Weather to open', openAttempted: false, networkRequests: 0, fetchedAt: null,
    reportTime: null, forecastIssue: null, forecastStart: null, forecastEnd: null,
    forecastFeatures: [], forecastRenderer: [], forecastExtent: null,
    forecastCoverage: { returned: 0, valid: 0, stale: 0, invalid: 0 }, error: '', viewportRevision: 0
  };
  let canvas, context, shell, observer, raf = null, loop = null, gesture = null, viewportTimer = null;
  let playbackRunning = false, playbackGeneration = 0, frameSelection = 0;
  let queuedFrame = null;
  let wmsMetadata = null, wmsRaster = null, wmsLegendUrl = null, wmsLoading = false, wmsQueued = false, wmsSelection = 0, wmsMetadataLoading = false, wmsLegendLoading = false;
  let reflectivityLegendUrl = null, reflectivityLegendLoading = false;
  const reflectivity = { ...REFLECTIVITY, legendSource: null, legendStatus: 'Not loaded' };
  const wmsControllers = new Set();
  const pointers = new Map();
  let generation = 0, liveBusy = false;
  let refreshTimer = null, refreshDueAt = null;
  const controllers = new Set();
  const images = new Map();
  const loadingImages = new Map();
  const failedImages = new Set();
  const verified = new Map();
  const reportCells = new Map();
  const productInfo = {
    velocity: ['Local velocity · KILX', 'The latest advertised KILX velocity image and official legend load through the preview transport. Velocity is radar-relative motion, not hotel surface wind.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows?service=wms&version=1.3.0&request=GetCapabilities'],
    ptype: ['Precipitation type', 'The latest advertised NOAA precipitation-type analysis and official legend load through the preview transport. No rain, snow or ice classification is inferred from reflectivity colors.', 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_pcpn_typ/ows?service=wms&version=1.3.0&request=GetCapabilities'],
    satellite: ['GOES-19 · Great Lakes', 'NOAA GeoColor satellite imagery covers Illinois. This review build does not embed a current satellite image.', 'https://www.star.nesdis.noaa.gov/GOES/sector.php?sat=G19&sector=cgl'],
    lightning: ['GOES-19 · Total lightning', 'NOAA GLM flash-extent density is regional total lightning. Current imagery is not embedded; no ground-strike pins or distance-to-hotel claims are made.', 'https://www.star.nesdis.noaa.gov/GOES/sector.php?sat=G19&sector=cgl']
  };
  const WMS_PRODUCTS = Object.freeze({
    velocity: { product: 'velocity', layer: 'kilx_sr_bvel', style: 'radar_velocity', title: 'Local velocity · KILX' },
    ptype: { product: 'precipitation', layer: 'conus_pcpn_typ', style: 'radar_precip_type', title: 'Precipitation type · NOAA analysis' }
  });
  state.wms = { product: null, layer: null, style: null, time: null, status: 'Not selected', source: null,
    mapSource: null, legendSource: null, legendStatus: 'Not loaded', displayedTime: null };
  const controls = [
    ['mapBackgroundMenu', 'Map menu', 'CMPRI embedded map', 'USGS ground-map datasets; independent NOAA weather overlays', 'Choose a geographic background separately from weather Layers. This menu never changes radar, WSSI or road report selections.'],
    ['mapLayersMenu', 'Layers menu', 'CMPRI overlay', 'NOAA observed products, NWS/WPC WSSI and property alerts; IDOT reports unavailable', 'Open the four independent weather-layer controls. Background style is chosen in Map.'],
    ['mapBackgroundStyle', 'Background style', 'CMPRI renderer over official USGS tiles', 'USGS Topo, historical imagery and shaded relief', 'Gray uses muted USGS Topo; Roads uses original USGS Topo; Aerial uses historical USGS imagery; Terrain uses USGS shaded relief.'],
    ['backgroundGray', 'Gray background', 'CMPRI color treatment', 'USGS Topo', 'Draw actual USGS Topo tiles in muted grayscale beneath weather. It is a geographic reference map, not a weather product.'],
    ['backgroundRoads', 'Roads background', 'CMPRI embedded map', 'USGS Topo', 'Show original topographic roads and labels. Background road lines do not report winter road conditions.'],
    ['backgroundAerial', 'Aerial background', 'CMPRI embedded map', 'USGS historical imagery', 'Show published USGS ground imagery; acquisition date may be unknown. This is not a current weather satellite image.'],
    ['geographicReference', 'Geographic roads and town names', 'CMPRI display of official USGS geography', 'USGS Transportation PNG and GNIS incorporated-place GeoJSON', 'Draw actual major roads and deduplicated town names at their official point coordinates over aerial imagery. These are geographic reference features, not reported winter road conditions.'],
    ['backgroundTerrain', 'Terrain background', 'CMPRI embedded map', 'USGS shaded relief', 'Show USGS terrain relief beneath the same weather and property pin. Shading does not establish current travel conditions.'],
    ['mapAttribution', 'Ground-map source attribution', 'CMPRI embedded map', 'USGS National Map', 'Keep the geographic source visible on the map in every background style, including loading and unavailable states.'],
    ['wheelZoom', 'Click-activated wheel zoom', 'CMPRI embedded map', 'None · local viewport interaction', 'The wheel scrolls the Weather view until the map is clicked. Then it zooms around the cursor. Leaving the map resets activation; settled extents request NOAA imagery.'],
    ['doubleClickZoom', 'Cursor-anchored double-click zoom', 'CMPRI embedded map', 'None · local viewport interaction', 'Double click to zoom in around the cursor; Shift-double-click zooms out.'],
    ['pinchZoom', 'Two-finger pinch zoom', 'CMPRI embedded map', 'None · local viewport interaction', 'Use two actual pointers to scale and pan around their geographic midpoint. No device GPS is accessed.'],
    ['playbackSpeed', 'Playback speed', 'CMPRI observed-radar player', 'Exact loaded NOAA scan images', 'Slow, Normal and Fast change playback pacing only. The last observed frame remains visible while the next real image loads.'],
    ['loopLength', 'Observed loop length', 'CMPRI observed-radar player', 'Explicit NOAA CONUS BREFQCD advertised scan times', 'Choose 60, 90 or 120 minutes ending at the latest published scan. Shorter available coverage is reported; no future scans are generated.'],
    ['propertyAlerts', 'Official alerts applying to hotel', 'CMPRI overlay from the existing NWS resource', 'NWS active property-point alert query', 'Draw only actual Polygon / MultiPolygon geometry from alerts applying to the hotel. County or zone alerts without polygons remain in the official alert list; panning does not load other-area alerts.'],
    ['alertDetails', 'Tap official alert area', 'CMPRI embedded map', 'NWS event, validity times and official bulletin link', 'Open details for an actual alert polygon. The popup is separate from Guest Safety and sends no notification.'],
    ['radar', 'Selected observed product layer', 'CMPRI overlay', 'Official NOAA CONUS BREFQCD, KILX velocity or precipitation-type WMS', 'Hide or show the selected observed product without changing it. Regional reflectivity loops explicit advertised scan times; other products use their latest advertised observation.'],
    ['roads', 'Reported winter roads layer', 'CMPRI overlay', 'IDOT Getting Around Illinois; concrete data feed unverified', 'Select the reported-road layer independently. Reports remain unavailable until an exact official feed and timestamps are verified; no route safety is inferred.'],
    ['impacts', 'Forecast winter travel impacts layer', 'CMPRI overlay', 'NWS/WPC WSSI overall Days 1–3, layer 4', 'Toggle same-map regional forecast impact polygons, independently of radar and road reports. The overlay is off by default; only verified NOAA forecast geometry is rendered.'],
    ['velocity', 'Local velocity product', 'CMPRI overlay', 'Official NOAA KILX WMS · advertised kilx_sr_bvel / radar_velocity', 'Display the latest advertised observed velocity image and its actual official PNG legend on the same USGS map. It is radar-relative motion, not hotel surface wind. No velocity loop is fabricated.'],
    ['ptype', 'Precipitation type product', 'CMPRI overlay', 'Official NOAA CONUS WMS · advertised conus_pcpn_typ / radar_precip_type', 'Display the latest advertised precipitation-type analysis and actual official PNG legend on the same map. Classifications come from NOAA, never reflectivity colors.'],
    ['wmsLegend', 'Official velocity / precipitation-type legend', 'CMPRI image display', 'NOAA WMS GetLegendGraphic for the selected advertised style', 'Render the actual PNG legend returned by NOAA; missing legends stay unavailable. Units and categories are not invented.'],
    ['satellite', 'Satellite product', 'CMPRI overlay', 'NOAA GOES-19 Great Lakes GeoColor', 'Show verified source and unavailable notice; no current image embedded.'],
    ['lightning', 'Lightning product', 'CMPRI overlay', 'NOAA GOES-19 GLM FED3 + GeoColor', 'Show verified source and unavailable notice; no strike pins or counts.'],
    ['moreNoaaProducts', 'More NOAA products · expand / collapse', 'CMPRI overlay', 'None · local presentation of official product links', 'Expand or collapse optional velocity, precipitation-type, satellite and lightning choices. This disclosure does not request a feed or change the independent map layers.'],
    ['pin', 'Fixed hotel pin', 'Embedded map component · CMPRI-authored', 'Marriott hotel View Map coordinates', 'Plot 40.138080, −88.251416 in the same projection as every selected layer; no GPS.'],
    ['pan', 'Pan · drag / touch / arrow keys', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Move the shared viewport; every visible layer and hotel pin moves together.'],
    ['zoomIn', 'Zoom in', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Increase shared map scale; plus key also works.'],
    ['zoomOut', 'Zoom out', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Decrease shared map scale; minus key also works.'],
    ['recenter', 'Recenter', 'Embedded map component · CMPRI-authored', 'Marriott fixed hotel coordinates', 'Restore the hotel-centered initial extent without device location access.'],
    ['fullscreen', 'Fullscreen / exit', 'Embedded map component · CMPRI-authored', 'Browser Fullscreen API; CSS fallback', 'Expand the same map. Escape exits; no separate radar app or iframe.'],
    ['opacity', 'Opacity', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Change weather-layer opacity together. USGS background and hotel pin retain contrast.'],
    ['legend', 'Layer legends', 'Embedded map component · CMPRI-authored', 'Official NOAA product legends and WSSI renderer; IDOT unavailable', 'Show compact official observed-product and forecast-impact legends in the map’s lower-left corner.'],
    ['previousFrame', 'Previous scan', 'Embedded map component · CMPRI-authored', 'Actual NOAA catalog times', 'Pause playback and display the previous exact NOAA catalog frame.'],
    ['playLoop', 'Play / pause', 'Embedded map component · CMPRI-authored', 'Exact NOAA catalog rasters', 'Play only while Weather is visible. Close, hidden tab, and pause stop its local timer. No prediction or future radar.'],
    ['frameRange', 'Scan seek slider', 'Embedded map component · CMPRI-authored', 'Actual NOAA catalog times', 'Pause and select one exact frame; live timestamps are never synthesized.'],
    ['nextFrame', 'Next scan', 'Embedded map component · CMPRI-authored', 'Actual NOAA catalog times', 'Pause playback and display the next exact NOAA catalog frame.'],
    ['showEchoes', 'Show selected observed product', 'Embedded map component · CMPRI-authored', 'Same official NOAA source as selected product', 'Hide/show reflectivity, velocity or precipitation-type rendering without silently switching products; other layers remain independent.'],
    ['automaticRefresh', 'Automatic foreground map refresh', 'CMPRI embedded map', 'NOAA reflectivity WMS capabilities/maps, WSSI layer 4 and selected KILX or precipitation-type WMS', 'Refresh published map products every five minutes while the Weather map is open and visible. Closing, switching tabs or hiding the document stops its timer and aborts requests. No database work or server scheduler.'],
    ['sourceLink', 'Official product link', 'CMPRI overlay', 'Selected official NOAA/NWS product page', 'Open the source page on explicit click. It does not load a third-party app into this map.']
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
  function wmsKey(geo) {
    return [state.activeLayer, state.wms.time, Math.round(geo.center.x), Math.round(geo.center.y), geo.resolution.toFixed(6), Math.round(geo.width), Math.round(geo.height)].join('|');
  }
  function stopWms(clear = false) {
    wmsSelection += 1; wmsControllers.forEach((controller) => controller.abort()); wmsControllers.clear();
    wmsLoading = false; wmsQueued = false; wmsMetadataLoading = false; wmsLegendLoading = false;
    if (clear) {
      wmsMetadata = null; wmsRaster?.bitmap.close?.(); wmsRaster = null;
      if (wmsLegendUrl) URL.revokeObjectURL(wmsLegendUrl);
      wmsLegendUrl = null; state.wms.displayedTime = null; state.wms.legendStatus = 'Not loaded';
    }
  }
  function latestAdvertisedTime(dimension) {
    const candidates = [];
    if (dimension?.default && dimension.default !== 'current') candidates.push(dimension.default);
    String(dimension?.values || '').split(',').forEach((entry) => {
      const parts = entry.trim().split('/');
      candidates.push(parts.length > 1 ? parts[1] : parts[0]);
    });
    return candidates.filter((time) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= Date.now())
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  }
  async function loadWmsView() {
    if (!state.opened || !state.active || document.hidden || !state.showRadar || !WMS_PRODUCTS[state.activeLayer]
      || !wmsMetadata || wmsMetadata.key !== state.activeLayer) return;
    const geo = geometry(); if (!geo.width || !geo.height) return;
    const key = wmsKey(geo);
    if (wmsRaster?.key === key) { state.wms.status = 'Observed WMS image loaded'; return true; }
    if (wmsLoading) { wmsQueued = true; return false; }
    wmsLoading = true;
    const ticket = generation, selection = wmsSelection, product = WMS_PRODUCTS[state.activeLayer];
    const time = state.wms.time, extent = viewport(geo);
    const width = Math.max(1, Math.min(1500, Math.round(geo.width))), height = Math.max(1, Math.min(1500, Math.round(geo.height)));
    state.wms.status = 'Loading observed WMS image · previous image and its time retained when available'; updateUI();
    try {
      const image = await wmsRequest({ product: product.product, op: 'map', layer: state.wms.layer, style: state.wms.style,
        time, bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(','), width: String(width), height: String(height) }, true, ticket);
      const bitmap = await createImageBitmap(image.blob);
      if (ticket !== generation || selection !== wmsSelection || !state.opened || !state.active || key !== wmsKey(geometry())) { bitmap.close?.(); return false; }
      if (bitmap.width !== width || bitmap.height !== height) { bitmap.close?.(); throw new Error('Official WMS image dimensions do not match its georeferenced request'); }
      if (image.time && Date.parse(image.time) !== Date.parse(time)) { bitmap.close?.(); throw new Error('Official WMS image time did not match the requested advertised observation'); }
      wmsRaster?.bitmap.close?.(); wmsRaster = { key, bitmap, extent, time, product: product.product };
      state.wms.displayedTime = time; state.wms.mapSource = image.source || state.wms.source;
      state.wms.status = 'Observed WMS image loaded'; mark(state.activeLayer, 'Actual NOAA WMS PNG loaded · advertised layer, style and observed time');
      updateUI(); queueDraw(); return true;
    } catch (error) {
      if (ticket !== generation || selection !== wmsSelection) return false;
      state.wms.status = 'Unavailable · ' + error.message; mark(state.activeLayer, 'Official WMS image unavailable · no replacement graphic'); updateUI(); return false;
    } finally {
      if (selection === wmsSelection && ticket === generation) {
        wmsLoading = false;
        if (wmsQueued && state.opened && state.active) { wmsQueued = false; void loadWmsView(); }
      }
    }
  }
  async function loadWmsLegend(selection, ticket) {
    if (!wmsMetadata || !WMS_PRODUCTS[state.activeLayer] || wmsLegendLoading) return;
    wmsLegendLoading = true;
    const product = WMS_PRODUCTS[state.activeLayer]; state.wms.legendStatus = 'Loading official PNG legend'; updateUI();
    try {
      const image = await wmsRequest({ product: product.product, op: 'legend', layer: state.wms.layer, style: state.wms.style }, true, ticket);
      const bitmap = await createImageBitmap(image.blob); bitmap.close?.();
      if (selection !== wmsSelection || ticket !== generation || !state.opened || !state.active) return;
      if (wmsLegendUrl) URL.revokeObjectURL(wmsLegendUrl);
      wmsLegendUrl = URL.createObjectURL(image.blob); state.wms.legendSource = image.source || state.wms.source;
      state.wms.legendStatus = 'Official NOAA PNG legend loaded'; mark('wmsLegend', 'Actual official GetLegendGraphic PNG decoded and displayed'); updateUI();
    } catch (error) {
      if (selection !== wmsSelection || ticket !== generation) return;
      state.wms.legendStatus = 'Unavailable · ' + error.message; mark('wmsLegend', 'Official legend unavailable · no invented units or categories'); updateUI();
    } finally {
      if (selection === wmsSelection && ticket === generation) wmsLegendLoading = false;
    }
  }
  async function loadWmsProduct(refresh = false) {
    const name = state.activeLayer, product = WMS_PRODUCTS[name];
    if (!product || !state.opened || !state.active || !state.showRadar) return;
    if (!refresh && wmsMetadataLoading) return;
    if (!refresh && wmsMetadata?.key === name) {
      await Promise.allSettled([loadWmsView(), wmsLegendUrl ? Promise.resolve() : loadWmsLegend(wmsSelection, generation)]); return;
    }
    const retained = refresh && wmsRaster?.product === product.product;
    const previous = state.wms;
    stopWms(!retained);
    wmsMetadataLoading = true;
    const ticket = generation, selection = wmsSelection;
    state.wms = retained ? { ...previous, status: 'Loading official WMS capabilities' } : { product: product.product, layer: null, style: null, time: null, status: 'Loading official WMS capabilities',
      source: productInfo[name][2], mapSource: null, legendSource: null, legendStatus: 'Waiting for advertised style', displayedTime: null }; updateUI();
    try {
      const metadata = await wmsRequest({ product: product.product, op: 'capabilities' }, false, ticket);
      if (ticket !== generation || selection !== wmsSelection || name !== state.activeLayer || !state.opened || !state.active) return;
      const layer = metadata.layers?.find((candidate) => candidate.name === product.layer);
      const style = layer?.styles?.find((candidate) => candidate.name === product.style);
      if (!layer || !style || !metadata.mapFormats?.some((format) => format.toLowerCase() === 'image/png')
        || !layer.crs?.some((crs) => crs.toUpperCase() === 'EPSG:3857')) throw new Error('Required layer, style, PNG or EPSG:3857 was not advertised by NOAA');
      const time = latestAdvertisedTime(layer.time);
      if (!time) throw new Error('No concrete past observed scan time was advertised by NOAA');
      wmsMetadata = { key: name, layer, style, metadata };
      wmsMetadataLoading = false;
      state.wms.layer = layer.name; state.wms.style = style.name; state.wms.time = time; state.wms.source = metadata.source || productInfo[name][2];
      await Promise.allSettled([loadWmsView(), metadata.legendSupported ? (wmsLegendUrl ? Promise.resolve() : loadWmsLegend(selection, ticket)) : Promise.resolve().then(() => {
        state.wms.legendStatus = 'Unavailable · official service did not advertise a legend'; updateUI();
      })]);
    } catch (error) {
      if (ticket !== generation || selection !== wmsSelection) return;
      state.wms.status = 'Unavailable · ' + error.message; state.wms.legendStatus = 'Unavailable · capabilities not verified'; mark(name, state.wms.status); updateUI();
    } finally {
      if (ticket === generation && selection === wmsSelection) wmsMetadataLoading = false;
    }
  }
  function loadSelectedImage() {
    return WMS_PRODUCTS[state.activeLayer] ? loadWmsProduct() : loadFrame(state.frame);
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
    queuedFrame = null;
    reflectivityLegendLoading = false;
    wmsSelection += 1; wmsControllers.clear(); wmsLoading = false; wmsQueued = false; wmsMetadataLoading = false; wmsLegendLoading = false;
    liveBusy = false;
  }
  async function foregroundRead(path, asBlob, ticket, wms = false) {
    if (!state.opened || !state.active || ticket !== generation) throw new DOMException('Weather closed', 'AbortError');
    const controller = new AbortController();
    controllers.add(controller);
    if (wms === true) wmsControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    state.networkRequests += 1;
    emit();
    try {
      const response = await fetch(path, { signal: controller.signal, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (asBlob) {
        const blob = await response.blob();
        if (wms && !blob.type.toLowerCase().startsWith('image/png')) throw new Error('Official WMS PNG unavailable');
        return wms ? { blob, source: response.headers.get('X-Weather-Source'), time: response.headers.get('X-Weather-Time') } : blob;
      }
      const json = await response.json();
      if (json.error) throw new Error('NOAA service error ' + (json.error.code || '') + ': ' + (json.error.message || 'unavailable'));
      return json;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      wmsControllers.delete(controller);
    }
  }
  function request(url, asBlob, ticket) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'mapservices.weather.noaa.gov') throw new Error('Unverified feed host');
    return foregroundRead('/api/weather-preview/map?url=' + encodeURIComponent(parsed.href), asBlob, ticket);
  }
  function wmsRequest(parameters, asBlob, ticket) {
    return foregroundRead('/api/weather-preview/wms?' + new URLSearchParams(parameters), asBlob, ticket, true);
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
    return [state.frames[frame]?.time, Math.round(geo.center.x), Math.round(geo.center.y), state.zoom.toFixed(4), Math.round(geo.width), Math.round(geo.height)].join('|');
  }
  function applyLoopWindow() {
    const selectedTime = state.frames[state.frame]?.time;
    const latest = state.catalogFrames[state.catalogFrames.length - 1]?.time;
    state.frames = latest ? state.catalogFrames.filter((frame) => frame.time >= latest - state.loopMinutes * 60000) : [];
    const retained = state.frames.findIndex((frame) => frame.time === selectedTime);
    state.frame = retained >= 0 ? retained : Math.max(0, state.frames.length - 1);
    // Keep the displayed raster and its real scan time until its replacement is ready,
    // including when a refresh advances the catalog beyond the previous loop window.
  }
  function availableWindowMinutes() {
    if (state.frames.length < 2) return 0;
    return Math.round((state.frames[state.frames.length - 1].time - state.frames[0].time) / 6000) / 10;
  }
  async function loadFrame(index) {
    if (state.mode !== 'live' || !state.opened || !state.active || !state.showRadar
      || state.activeLayer !== 'reflectivity' || !state.frames[index]) return;
    const geo = geometry();
    if (!geo.width || !geo.height) return;
    const key = imageKey(index, geo);
    if (images.has(key)) { state.radarStatus = 'Observed image loaded'; return true; }
    if (loadingImages.has(key)) return loadingImages.get(key);
    if (failedImages.has(key)) return false;
    if (loadingImages.size >= 2) {
      // Scrubbing retains only the latest desired scan, never a request per tick.
      queuedFrame = state.frames[index].time;
      return false;
    }
    queuedFrame = null;
    const ticket = generation;
    const raster = state.frames[index];
    const extent = viewport(geo);
    state.radarStatus = 'Loading actual NOAA image · previous observed frame retained when available';
    updateUI();
    const task = (async () => {
      try {
        const width = Math.max(1, Math.min(1500, Math.round(geo.width)));
        const height = Math.max(1, Math.min(1500, Math.round(geo.height)));
        const result = await foregroundRead('/api/weather-preview/wms?' + new URLSearchParams({
          product: REFLECTIVITY.product, op: 'map', layer: REFLECTIVITY.layer, style: REFLECTIVITY.style,
          time: raster.advertisedTime, bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(','),
          width: String(width), height: String(height)
        }), true, ticket, 'reflectivity');
        const blob = result.blob;
        if (result.time && Date.parse(result.time) !== raster.time) throw new Error('NOAA reflectivity image time did not match the advertised scan');
        const bitmap = await createImageBitmap(blob);
        if (ticket !== generation || !state.opened || !state.active) { bitmap.close?.(); return; }
        if (bitmap.width !== width || bitmap.height !== height) { bitmap.close?.(); throw new Error('NOAA image dimensions did not match the georeferenced request'); }
        images.set(key, { bitmap, extent, time: raster.time });
        if (images.size > 36) { const first = images.keys().next().value; images.get(first).bitmap.close?.(); images.delete(first); }
        state.radarStatus = 'Observed image loaded';
        mark('radar', 'Actual NOAA BREFQCD PNG loaded · explicit advertised scan time and matching map extent');
        updateUI(); queueDraw();
        return true;
      } catch (error) {
        if (ticket !== generation) return;
        failedImages.add(key);
        state.radarStatus = error.name === 'AbortError' ? 'Unavailable · request timed out / stopped' : 'Unavailable · ' + error.message;
        mark('radar', 'NOAA export unavailable · no replacement imagery');
        updateUI();
        return false;
      } finally {
        if (loadingImages.get(key) === task) loadingImages.delete(key);
        if (queuedFrame !== null && ticket === generation && state.opened && state.active && !document.hidden) {
          const desired = queuedFrame; queuedFrame = null;
          const next = state.frames.findIndex((frame) => frame.time === desired);
          if (next >= 0) void loadFrame(next);
        }
        if (ticket === generation && state.opened && state.active) updateUI();
      }
    })();
    loadingImages.set(key, task);
    updateUI();
    return task;
  }
  async function loadReflectivityLegend(ticket) {
    if (reflectivityLegendUrl || reflectivityLegendLoading || !state.opened || !state.active) return;
    reflectivityLegendLoading = true;
    try {
      const result = await foregroundRead('/api/weather-preview/wms?' + new URLSearchParams({
        product: REFLECTIVITY.product, op: 'legend', layer: REFLECTIVITY.layer, style: REFLECTIVITY.style
      }), true, ticket, 'reflectivity');
      const bitmap = await createImageBitmap(result.blob); bitmap.close?.();
      if (ticket !== generation || !state.opened || !state.active) return;
      reflectivityLegendUrl = URL.createObjectURL(result.blob);
      reflectivity.legendSource = result.source || REFLECTIVITY.source;
      reflectivity.legendStatus = 'Official NOAA reflectivity PNG legend loaded';
      mark('legend', 'Actual NOAA radar_reflectivity legend and observed BREFQCD imagery use the same advertised style');
      updateUI();
    } catch (error) {
      if (ticket !== generation) return;
      reflectivity.legendStatus = 'Unavailable · ' + error.message;
      mark('legend', 'Official reflectivity legend could not load; no substituted palette');
    } finally {
      if (ticket === generation) reflectivityLegendLoading = false;
    }
  }
  async function radarCatalog(ticket) {
    state.radarStatus = 'Loading NOAA scan catalog'; updateUI();
    const metadata = await foregroundRead('/api/weather-preview/wms?' + new URLSearchParams({ product: REFLECTIVITY.product, op: 'capabilities' }), false, ticket);
    if (ticket !== generation) return;
    const layer = metadata.layers?.find((candidate) => candidate.name === REFLECTIVITY.layer);
    const style = layer?.styles?.find((candidate) => candidate.name === REFLECTIVITY.style);
    if (!layer || !style || !metadata.mapFormats?.some((format) => format.toLowerCase() === 'image/png')
      || !layer.crs?.some((crs) => crs.toUpperCase() === 'EPSG:3857')) throw new Error('NOAA reflectivity layer, style, PNG or EPSG:3857 not advertised');
    const scans = new Map();
    // This source advertises individual scan instants. Do not infer interval steps
    // or label a source-default image with the capabilities default timestamp.
    String(layer.time?.values || '').split(',').forEach((value) => {
      const advertisedTime = value.trim();
      if (!advertisedTime || advertisedTime.includes('/')) return;
      const time = Date.parse(advertisedTime);
      if (Number.isFinite(time) && time > 0 && time <= Date.now()) scans.set(time, { time, advertisedTime });
    });
    state.catalogFrames = Array.from(scans.values()).sort((a, b) => a.time - b.time).slice(-96);
    applyLoopWindow();
    if (!state.frames.length) throw new Error('No explicit observed NOAA scan times were advertised');
    if (!playbackRunning) state.frame = state.frames.length - 1;
    state.radarStatus = 'Catalog verified · loading exact observed scan';
    mark('radar', 'NOAA BREFQCD verified · ' + state.frames.length + ' explicit advertised scan times');
    updateUI();
    await Promise.allSettled([loadFrame(state.frame), metadata.legendSupported ? loadReflectivityLegend(ticket) : Promise.resolve()]);
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
    if (!state.opened || !state.active || document.hidden || liveBusy) return;
    stopRefreshTimer();
    liveBusy = true; state.openAttempted = true;
    state.mode = 'live'; failedImages.clear();
    state.radarStatus = 'Loading'; state.impactsStatus = 'Loading';
    state.roadsStatus = 'Unavailable · exact IDOT feed / report timestamps unverified';
    mark('roads', 'Live unavailable · concrete IDOT feed / report time unverified');
    state.error = '';
    const ticket = generation;
    mark('automaticRefresh', 'Loading published map products · visible map only; current observed frame retained');
    updateUI(); queueDraw();
    const results = await Promise.allSettled([radarCatalog(ticket), impactForecast(ticket), WMS_PRODUCTS[state.activeLayer] ? loadWmsProduct(true) : Promise.resolve()]);
    if (ticket !== generation || !state.opened || !state.active) return;
    if (results[0].status === 'rejected') {
      state.radarStatus = 'Unavailable · ' + results[0].reason.message;
      mark('radar', 'NOAA catalog unavailable · no replacement imagery');
    }
    if (results[1].status === 'rejected') {
      state.impactsStatus = 'Unavailable · ' + results[1].reason.message;
      mark('impacts', 'NOAA query unavailable · no replacement geometry');
    }
    state.fetchedAt = Date.now();
    liveBusy = false;
    mark('automaticRefresh', 'Foreground refresh complete · five-minute cadence; ' + state.networkRequests + ' NOAA requests this session');
    scheduleRefresh();
    updateUI(); queueDraw(); emit();
  }
  function stopRefreshTimer() {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  function scheduleRefresh() {
    stopRefreshTimer();
    if (!state.opened || !state.active || document.hidden || liveBusy) return;
    refreshDueAt = (state.fetchedAt || Date.now()) + REFRESH_INTERVAL;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (state.opened && state.active && !document.hidden) void tryLive();
    }, Math.max(0, refreshDueAt - Date.now()));
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
  function alertPolygons(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygons.filter((rings) => Array.isArray(rings) && rings.length && rings.every((ring) =>
      Array.isArray(ring) && ring.length >= 4 && ring.every((point) => Array.isArray(point)
        && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)));
  }
  function setAlerts(envelope) {
    closeAlertDetails(); state.alerts = []; state.alertGeometryless = 0;
    state.alertSource = typeof envelope?.source === 'string' ? envelope.source : null;
    state.alertCheckedAt = envelope?.receivedAt || null;
    if (!envelope || !['live', 'stale'].includes(envelope.status) || !Array.isArray(envelope.data?.features)) {
      state.alertStatus = 'Unknown · official property alerts unavailable; no all-clear is inferred';
    } else {
      envelope.data.features.forEach((feature) => {
        const polygons = alertPolygons(feature.geometry);
        if (!polygons.length) state.alertGeometryless += 1;
        state.alerts.push({ id: feature.id, properties: feature.properties || {}, polygons });
      });
      state.alertStatus = (envelope.status === 'stale' ? 'STALE response · ' : '') + (state.alerts.length
        ? state.alerts.length + ' official alerts applying to hotel; ' + state.alertGeometryless + ' without renderable polygons remain in the official list'
        : 'No active alerts returned for the hotel at ' + formatTime(state.alertCheckedAt))
        + '. Scope is alerts applying to the hotel, not all alerts in the panned map.';
    }
    mark('propertyAlerts', state.alertStatus); updateUI(); queueDraw(); return getState();
  }
  function drawAlerts(geo) {
    if (!state.showAlerts) return;
    state.alerts.forEach((alert) => {
      const event = String(alert.properties.event || ''), color = /Warning$/.test(event) ? '#ff8757' : /Watch$/.test(event) ? '#ffcd00' : '#80ccf5';
      alert.polygons.forEach((rings) => polygon(rings, geo, color + '12', color, /Watch$/.test(event)));
    });
  }
  function withinRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if ((y1 > point.lat) !== (y2 > point.lat) && point.lon < (x2 - x1) * (point.lat - y1) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  }
  function closeAlertDetails() { $('mapAlertDetails')?.remove(); }
  function showAlertDetails(point) {
    if (!state.showAlerts) return;
    const geo = geometry(), location = unproject(geo.center.x + (point.x - geo.width / 2) * geo.resolution, geo.center.y - (point.y - geo.height / 2) * geo.resolution);
    const alert = state.alerts.find((item) => item.polygons.some((rings) => withinRing(location, rings[0]) && !rings.slice(1).some((ring) => withinRing(location, ring))));
    closeAlertDetails(); if (!alert) return;
    const panel = document.createElement('section'); panel.id = 'mapAlertDetails'; panel.className = 'cmpri-map-alert-details'; panel.setAttribute('aria-label', 'Official NWS alert details');
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close official alert details'); close.addEventListener('click', closeAlertDetails);
    const title = document.createElement('h3'); title.textContent = String(alert.properties.event || 'Official NWS alert');
    const scope = document.createElement('p'); scope.textContent = 'Official alert applying to Residence Inn Champaign';
    const effective = document.createElement('p'); effective.textContent = 'Effective: ' + formatTime(alert.properties.effective || alert.properties.onset);
    const expires = document.createElement('p'); expires.textContent = 'Expires: ' + formatTime(alert.properties.ends || alert.properties.expires);
    panel.append(close, title, scope, effective, expires);
    const source = [alert.properties.web, alert.properties.id, alert.id].find((value) => {
      try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'weather.gov' || url.hostname.endsWith('.weather.gov')); } catch { return false; }
    });
    if (source) { const link = document.createElement('a'); link.href = source; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Official NWS bulletin ↗'; panel.append(link); }
    else { const note = document.createElement('p'); note.textContent = 'Bulletin link unavailable; read the official alert list above.'; panel.append(note); }
    shell.append(panel); mark('alertDetails', 'Exercised · actual NWS property alert polygon and official validity times');
  }
  function drawRadar(geo) {
    if (!state.showRadar) return;
    if (WMS_PRODUCTS[state.activeLayer]) {
      if (!wmsRaster || wmsRaster.product !== WMS_PRODUCTS[state.activeLayer].product) return;
      const extent = wmsRaster.extent;
      context.save(); context.globalAlpha = state.opacity;
      context.drawImage(wmsRaster.bitmap, geo.width / 2 + (extent.xmin - geo.center.x) / geo.resolution,
        geo.height / 2 - (extent.ymax - geo.center.y) / geo.resolution,
        (extent.xmax - extent.xmin) / geo.resolution, (extent.ymax - extent.ymin) / geo.resolution);
      context.restore(); return;
    }
    if (state.activeLayer !== 'reflectivity') return;
    const exact = images.get(imageKey(state.frame, geo));
    const targetTime = state.frames[state.frame]?.time;
    const target = exact || Array.from(images.values()).reverse().find((item) => item.time === targetTime);
    const image = target || Array.from(images.values()).reverse().find((item) => item.time === state.displayedTime);
    if (!image) return;
    const changed = state.displayedTime !== image.time;
    state.displayedTime = image.time;
    context.save(); context.globalAlpha = state.opacity;
    const extent = image.extent;
    const x = geo.width / 2 + (extent.xmin - geo.center.x) / geo.resolution;
    const y = geo.height / 2 - (extent.ymax - geo.center.y) / geo.resolution;
    context.drawImage(image.bitmap, x, y, (extent.xmax - extent.xmin) / geo.resolution, (extent.ymax - extent.ymin) / geo.resolution);
    context.restore();
    if (changed) updateUI();
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
    context.fillStyle = '#141d20'; context.fillRect(0, 0, geo.width, geo.height);
    window.cmpriGroundMap?.draw(context, geo, state.backgroundStyle);
    drawImpacts(geo); drawRadar(geo);
    window.cmpriGroundMap?.drawReferences?.(context, geo);
    drawAlerts(geo); drawPin(geo);
    updateGroundStatus();
    mark('legend', 'Rendered · separate source/type labels for selected layers');
  }
  function queueDraw() {
    if (state.opened && state.active && !document.hidden && raf === null) raf = requestAnimationFrame(draw);
  }
  function frameCount() { return state.frames.length; }
  function scanTime() {
    if (WMS_PRODUCTS[state.activeLayer]) {
      const time = state.wms.displayedTime;
      if (!state.showRadar) return '';
      if (!time) return state.wms.status.startsWith('Unavailable') ? 'Observed image unavailable' : '';
      return formatTime(time);
    }
    if (!state.showRadar || state.activeLayer !== 'reflectivity') return '';
    if (!state.frames[state.frame]) return state.radarStatus.startsWith('Unavailable') ? 'Observed radar unavailable' : '';
    const time = state.displayedTime;
    if (time === null) return state.radarStatus.startsWith('Unavailable') ? 'Observed radar unavailable' : '';
    return formatTime(time);
  }
  function legendItem(label, color) {
    const item = document.createElement('span'); item.className = 'cmpri-map-legend-item';
    const swatch = document.createElement('span'); swatch.className = 'cmpri-map-swatch'; swatch.style.backgroundColor = color;
    item.append(swatch, document.createTextNode(label)); return item;
  }
  function renderLegend() {
    const host = $('mapLegend'); if (!host) return;
    const fragment = document.createDocumentFragment();
    if (state.showRadar && WMS_PRODUCTS[state.activeLayer]) {
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row cmpri-wms-legend';
      const heading = document.createElement('strong'); heading.textContent = WMS_PRODUCTS[state.activeLayer].title + ' · official NOAA legend'; row.append(heading);
      if (wmsLegendUrl) {
        const image = document.createElement('img'); image.id = 'mapWmsLegend'; image.src = wmsLegendUrl;
        image.alt = 'Official NOAA legend for ' + state.wms.layer + ', advertised style ' + state.wms.style; row.append(image);
      }
      if (wmsLegendUrl) fragment.append(row);
    }
    if (state.showRadar && state.activeLayer === 'reflectivity') {
      if (reflectivityLegendUrl) {
        const row = document.createElement('div'); row.className = 'cmpri-map-legend-row cmpri-reflectivity-legend';
        const heading = document.createElement('strong'); heading.textContent = 'NOAA reflectivity · dBZ';
        const image = document.createElement('img'); image.id = 'mapReflectivityLegend'; image.src = reflectivityLegendUrl;
        image.alt = 'Official NOAA reflectivity intensity legend for conus_bref_qcd, advertised style radar_reflectivity';
        const scale = document.createElement('div'); scale.className = 'cmpri-reflectivity-scale';
        const ramp = document.createElement('div'); ramp.className = 'cmpri-reflectivity-ramp'; ramp.append(image);
        const ticks = document.createElement('div'); ticks.className = 'cmpri-reflectivity-ticks'; ticks.setAttribute('aria-label', 'Reflectivity in dBZ');
        // NOAA's actual radar_reflectivity legend is 500×30. Keep its unchanged
        // PNG color band and reflow only the printed numbers for narrow screens.
        // Tick x centers measured from that official PNG; the first tick is inset,
        // so −20 is not claimed to be the ramp's minimum or left edge.
        [[-20, 37.5], [-10, 87.5], [0, 137], [10, 187.5], [20, 237.5],
          [30, 287.5], [40, 337], [50, 387], [60, 437], [70, 487]].forEach(([value, x]) => {
          const tick = document.createElement('span'); tick.textContent = String(value).replace('-', '−');
          tick.style.left = (x / 5) + '%'; ticks.append(tick);
        });
        scale.append(ramp, ticks); row.append(heading, scale); fragment.append(row);
      }
    }
    if (state.roads) {
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row';
      const heading = document.createElement('strong'); heading.textContent = 'IDOT reported roads · UNAVAILABLE'; row.append(heading);
      fragment.append(row);
    }
    if (state.impacts) {
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row';
      const heading = document.createElement('strong'); heading.textContent = 'WSSI forecast impacts · Days 1–3'; row.append(heading);
      state.forecastRenderer.forEach((item) => row.append(legendItem(item.label || item.value, 'rgb(' + (item.symbol?.color || [180, 190, 199]).slice(0, 3).join(',') + ')')));
      if (state.mode === 'live' && state.forecastCoverage.stale) {
        const note = document.createElement('span'); note.textContent = 'Dashed outlines: stale / expired forecast areas'; row.append(note);
      }
      fragment.append(row);
    }
    const empty = !fragment.childNodes.length;
    host.replaceChildren(fragment); host.hidden = empty;
  }
  function updateGroundStatus() {
    const ground = window.cmpriGroundMap?.getState();
    const attribution = (ground?.attribution || 'USGS') + ' · NOAA/NWS';
    const overzoom = Math.log2(156543.03392804097 / (620 / state.zoom)) > 16;
    if ($('mapAttributionSource')) $('mapAttributionSource').textContent = attribution;
    if ($('mapGroundStatus')) $('mapGroundStatus').textContent = ground
      ? (ground.visibleFailed ? (ground.visibleLoaded ? 'Geographic map incomplete. ' : 'Geographic map unavailable. ') : '')
        + (state.backgroundStyle === 'aerial' ? (ground.imageryAcquisitionYear ? 'Aerial capture year: ' + ground.imageryAcquisitionYear + '.' : 'Aerial capture year unavailable.') : '')
        + (state.backgroundStyle === 'aerial' && ground.reference?.enabled && [ground.reference.roads?.status, ground.reference.places?.status].some((status) => /unavailable/i.test(status || '')) ? ' Some geographic roads or town labels are unavailable.' : '')
        + (overzoom ? ' Source imagery is enlarged; no extra ground detail is added.' : '')
      : 'Geographic map unavailable.';
    if (ground) {
      mark('mapAttribution', 'Visible · ' + attribution);
      mark('background' + state.backgroundStyle[0].toUpperCase() + state.backgroundStyle.slice(1), ground.style === state.backgroundStyle && ground.visibleLoaded > 0 ? 'Actual USGS tiles rendered · ' + ground.status : 'Selected · awaiting this background');
      if (ground.reference?.enabled) mark('geographicReference', ground.reference.roads?.loaded && ground.reference.places?.loaded
        ? 'Actual USGS road PNG and official GNIS point labels rendered over aerial imagery'
        : 'Official geographic reference state: roads ' + ground.reference.roads?.status + '; towns ' + ground.reference.places?.status);
    }
  }
  function updateUI() {
    if (!state.initialized) return;
    refreshForecastFreshness();
    const count = frameCount();
    const wms = WMS_PRODUCTS[state.activeLayer];
    const buffering = state.opened && state.active && state.showRadar && (wms ? wmsLoading || wmsMetadataLoading
      : state.activeLayer === 'reflectivity' && (loadingImages.size > 0 || state.openAttempted && !count && !state.radarStatus.startsWith('Unavailable')));
    document.querySelectorAll('.loop,.cmpri-map-playback-options').forEach((bar) => {
      bar.dataset.loading = String(Boolean(buffering)); bar.setAttribute('aria-busy', String(Boolean(buffering)));
    });
    const radarAvailable = state.showRadar && state.activeLayer === 'reflectivity' && count > 0;
    ['previousFrame', 'playLoop', 'frameRange', 'nextFrame'].forEach((id) => { if ($(id)) $(id).disabled = !radarAvailable; });
    ['playbackSpeed', 'loopLength'].forEach((id) => { if ($(id)) $(id).disabled = Boolean(wms); });
    if ($('frameRange')) { $('frameRange').max = Math.max(0, count - 1); $('frameRange').value = state.frame; $('frameRange').setAttribute('aria-label', 'Observed NOAA radar scan'); }
    if ($('scanTime')) $('scanTime').textContent = scanTime();
    if ($('loopLabel')) $('loopLabel').textContent = buffering && !count ? '' : wms ? 'Latest observed product · playback loop only available for regional reflectivity' : count
      ? 'Observed loop · ' + count + ' actual scans · ' + availableWindowMinutes() + ' min available / ' + state.loopMinutes + ' min requested'
      : 'No observed scans available · ' + state.loopMinutes + ' min requested';
    if ($('playbackSpeed')) { $('playbackSpeed').value = String(PLAYBACK_SPEEDS.indexOf(state.playbackSpeed)); $('playbackSpeed').setAttribute('aria-valuetext', state.playbackSpeed); }
    if ($('playbackSpeedValue')) $('playbackSpeedValue').textContent = state.playbackSpeed[0].toUpperCase() + state.playbackSpeed.slice(1);
    if ($('loopLength')) $('loopLength').value = String(state.loopMinutes);
    if ($('loopLength')) $('loopLength').setAttribute('aria-valuetext', state.loopMinutes + ' minutes');
    if ($('loopLengthValue')) $('loopLengthValue').textContent = state.loopMinutes + ' min';
    if ($('mapBackgroundStyle')) $('mapBackgroundStyle').value = state.backgroundStyle;
    if ($('mapOpacity')) $('mapOpacity').value = Math.round(state.opacity * 100);
    if ($('opacityValue')) $('opacityValue').textContent = Math.round(state.opacity * 100) + '%';
    if ($('showEchoes')) {
      $('showEchoes').checked = state.showRadar;
      const last = $('showEchoes').parentElement.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) last.textContent = wms ? 'Show selected observed product' : 'Show radar echoes';
    }
    if ($('mapLayerRadar')) $('mapLayerRadar').checked = state.showRadar;
    if ($('mapLayerRadar')?.parentElement.lastChild?.nodeType === Node.TEXT_NODE) $('mapLayerRadar').parentElement.lastChild.textContent = wms ? ' ' + wms.title : ' Radar';
    if ($('mapLayerRoads')) $('mapLayerRoads').checked = state.roads;
    if ($('mapLayerImpacts')) $('mapLayerImpacts').checked = state.impacts;
    if ($('mapLayerAlerts')) $('mapLayerAlerts').checked = state.showAlerts;
    if (canvas) {
      const radar = wms ? wms.title + ': ' + state.wms.status + '. Observed time ' + formatTime(state.wms.displayedTime) + '.' : state.showRadar && state.frames.length && images.size
        ? 'Observed NOAA radar catalog frames; the displayed scan time is shown beside playback controls.'
        : 'Observed radar unavailable or not selected. Missing data does not mean clear weather.';
      const overlays = ' Road reports: ' + (!state.roads ? 'off.' : 'unavailable; exact IDOT feed unverified.')
        + ' Forecast impacts: ' + (!state.impacts ? 'off.' : state.impactsStatus + '.');
      canvas.setAttribute('aria-label', 'USGS geographic map with weather at verified Residence Inn Champaign coordinates. Background style: ' + state.backgroundStyle + '. ' + radar + overlays + ' Drag or use arrow keys to pan. Click the map to activate wheel zoom; leaving resets it. Double click, pinch, plus and minus also zoom.');
    }
    if ($('mapModeBadge')) $('mapModeBadge').textContent = wms ? 'Observed NOAA product' : 'NOAA radar';
    const unavailable = wms ? (!wmsRaster && state.wms.status.startsWith('Unavailable') ? [wms.title, state.wms.status, state.wms.source || productInfo[state.activeLayer][2]] : null) : productInfo[state.activeLayer];
    if ($('layerUnavailable')) $('layerUnavailable').hidden = !unavailable;
    if (unavailable) {
      if ($('layerTitle')) $('layerTitle').textContent = unavailable[0];
      if ($('layerDescription')) $('layerDescription').textContent = unavailable[1];
      if ($('layerSource')) $('layerSource').href = unavailable[2];
    }
    document.querySelectorAll('#productTabs [data-layer]').forEach((button) => {
      const name = button.dataset.layer; button.setAttribute('aria-pressed', String(name === state.activeLayer || (name === 'winter' && state.impacts)));
    });
    if ($('mapRoadStatus')) $('mapRoadStatus').textContent = state.roadsStatus + '. Report time unavailable. Missing reports do not mean clear roads.';
    if ($('mapImpactStatus')) $('mapImpactStatus').textContent = state.impactsStatus + ' · issued: ' + formatTime(state.forecastIssue) + ' · valid: ' + formatTime(state.forecastStart) + ' → ' + formatTime(state.forecastEnd) + '. Coverage is limited to the extent fetched on the last load; panning does not query new forecast areas.';
    if ($('mapAlertStatus')) $('mapAlertStatus').textContent = state.alertStatus;
    if ($('mapFeedStatus')) $('mapFeedStatus').textContent = [
      (wms ? state.wms.status : state.radarStatus).startsWith('Unavailable') ? 'Selected NOAA image unavailable.' : '',
      state.impacts && state.impactsStatus.startsWith('Unavailable') ? 'Winter impact guidance unavailable.' : '',
      state.roads ? 'IDOT road reports unavailable.' : ''
    ].filter(Boolean).join(' ');
    updateGroundStatus(); renderLegend(); emit();
  }
  function stopPlayback() {
    playbackRunning = false; playbackGeneration += 1;
    if (loop !== null) { clearTimeout(loop); loop = null; }
    if ($('playLoop')) { $('playLoop').textContent = '▶ Play'; $('playLoop').setAttribute('aria-label', 'Play observed NOAA radar loop'); }
    emit();
  }
  async function setFrame(index, source) {
    const count = frameCount(); if (!count) return;
    const selection = ++frameSelection;
    state.frame = (index + count) % count;
    if (source) mark(source, 'Exercised · exact NOAA catalog frame selected');
    updateUI(); queueDraw();
    const loaded = await loadFrame(state.frame);
    if (selection === frameSelection && state.opened && state.active) { updateUI(); queueDraw(); }
    return loaded;
  }
  function play() {
    if (playbackRunning) { stopPlayback(); mark('playLoop', 'Exercised · playback paused'); return; }
    if (!state.opened || !state.active || document.hidden || !state.showRadar || state.activeLayer !== 'reflectivity' || !frameCount()) return;
    playbackRunning = true;
    const ticket = ++playbackGeneration;
    const delay = () => ({ slow: 1500, normal: 850, fast: 350 })[state.playbackSpeed];
    const advance = async () => {
      loop = null;
      if (!playbackRunning || ticket !== playbackGeneration || !state.opened || !state.active || document.hidden) return;
      const next = (state.frame + 1) % frameCount();
      const nextTime = state.frames[next]?.time;
      const loaded = await loadFrame(next);
      if (!playbackRunning || ticket !== playbackGeneration || !state.opened || !state.active) return;
      if (!loaded) { stopPlayback(); return; }
      const retained = state.frames.findIndex((frame) => frame.time === nextTime);
      if (retained >= 0) state.frame = retained;
      updateUI(); queueDraw();
      void loadFrame((state.frame + 1) % frameCount());
      loop = setTimeout(advance, delay());
    };
    void loadFrame((state.frame + 1) % frameCount());
    loop = setTimeout(advance, delay());
    if ($('playLoop')) { $('playLoop').textContent = 'Ⅱ Pause'; $('playLoop').setAttribute('aria-label', 'Pause radar loop'); }
    mark('playLoop', 'Exercised · observed scans only; last real image held until next PNG is ready'); emit();
  }
  function scheduleViewportImage() {
    if (viewportTimer !== null) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      if (state.opened && state.active && !document.hidden) void loadSelectedImage();
    }, 180);
  }
  function localPoint(clientX, clientY) {
    const bounds = canvas.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  }
  function setCenter(x, y) {
    const center = unproject(x, y);
    state.center = { lat: Math.max(-75, Math.min(75, center.lat)), lon: Math.max(-180, Math.min(180, center.lon)) };
  }
  function zoomBy(factor, source, anchor) {
    stopPlayback();
    closeAlertDetails();
    const geo = geometry(), point = anchor || { x: geo.width / 2, y: geo.height / 2 };
    const fixed = { x: geo.center.x + (point.x - geo.width / 2) * geo.resolution,
      y: geo.center.y - (point.y - geo.height / 2) * geo.resolution };
    state.zoom = Math.max(0.45, Math.min(1024, state.zoom * factor));
    const resolution = 620 / state.zoom;
    setCenter(fixed.x - (point.x - geo.width / 2) * resolution, fixed.y + (point.y - geo.height / 2) * resolution);
    state.viewportRevision += 1; mark(source, 'Exercised · shared map zoom now ' + state.zoom.toFixed(2) + '×');
    queueDraw(); scheduleViewportImage(); emit();
  }
  function resetGesture() {
    const points = Array.from(pointers.values()), geo = geometry();
    if (points.length >= 2) {
      const first = localPoint(points[0].x, points[0].y), second = localPoint(points[1].x, points[1].y);
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      gesture = { type: 'pinch', distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), zoom: state.zoom,
        fixed: { x: geo.center.x + (midpoint.x - geo.width / 2) * geo.resolution, y: geo.center.y - (midpoint.y - geo.height / 2) * geo.resolution } };
    } else if (points.length) gesture = { type: 'pan', x: points[0].x, y: points[0].y, center: geo.center, resolution: geo.resolution };
    else gesture = null;
  }
  function selectLayer(name, enabled) {
    init(); stopPlayback();
    if (name === 'roads') { state.roads = enabled === undefined ? !state.roads : Boolean(enabled); mark('roads', state.roads ? 'Selected · IDOT reports unavailable; no route data rendered' : 'Exercised · road layer hidden'); }
    else if (name === 'impacts' || name === 'winter') { state.impacts = enabled === undefined ? !state.impacts : Boolean(enabled); mark('impacts', state.impacts ? 'Selected · ' + state.impactsStatus : 'Exercised · forecast overlay hidden'); }
    else if (name === 'radar' || name === 'reflectivity') {
      if (name === 'reflectivity' || !WMS_PRODUCTS[state.activeLayer]) { if (WMS_PRODUCTS[state.activeLayer]) stopWms(true); state.activeLayer = 'reflectivity'; }
      state.showRadar = enabled === undefined ? true : Boolean(enabled);
      if (!state.showRadar) stopWms();
      mark('radar', 'Exercised · selected observed product ' + (state.showRadar ? 'shown' : 'hidden'));
    }
    else if (WMS_PRODUCTS[name]) { stopWms(true); state.activeLayer = name; state.showRadar = true; mark(name, 'Selected · loading exact advertised NOAA layer, style, observed time and legend'); }
    else if (productInfo[name]) { stopWms(true); state.activeLayer = name; state.showRadar = false; mark(name, 'Exercised · unavailable notice and official source shown'); }
    updateUI(); queueDraw();
    if (state.mode === 'live' && state.showRadar) void loadSelectedImage();
    return getState();
  }
  function renderControls() {
    const host = $('mapControlHost'); if (!host) return;
    const opacity = $('mapOpacity')?.closest('.opacity');
    host.innerHTML = `<div class="cmpri-map-menu-bar"><details class="cmpri-map-menu" id="mapBackgroundMenu"><summary>Map</summary><div class="cmpri-map-menu-panel"><label for="mapBackgroundStyle">Geographic background</label><select id="mapBackgroundStyle"><option value="gray">Gray · USGS Topo</option><option value="roads">Roads · USGS Topo</option><option value="aerial">Aerial · USGS historical imagery</option><option value="terrain">Terrain · USGS shaded relief</option></select></div></details><details class="cmpri-map-menu" id="mapLayersMenu"><summary>Layers</summary><fieldset class="cmpri-map-layer-controls"><legend>Weather layers · select independently</legend><label><input type="checkbox" id="mapLayerRadar" checked> Radar</label><label><input type="checkbox" id="mapLayerRoads"> Reported Illinois winter roads</label><label><input type="checkbox" id="mapLayerImpacts"> Forecast winter travel impacts</label><label><input type="checkbox" id="mapLayerAlerts" checked> Official alerts applying to hotel</label></fieldset></details></div><div class="cmpri-map-playback-options"><label class="cmpri-map-slider" for="playbackSpeed"><span>Playback speed <output id="playbackSpeedValue" for="playbackSpeed">Normal</output></span><input id="playbackSpeed" type="range" min="0" max="2" step="1" value="1" aria-valuetext="Normal"></label><label class="cmpri-map-slider" for="loopLength"><span>Observation loop <output id="loopLengthValue" for="loopLength">90 min</output></span><input id="loopLength" type="range" min="60" max="120" step="30" value="90" aria-valuetext="90 minutes"></label></div><p id="mapGroundStatus" class="cmpri-map-status-copy" role="status"></p><p id="mapFeedStatus" class="cmpri-map-status-copy" role="status"></p>`;
    const sliders = host.querySelector('.cmpri-map-playback-options');
    if (opacity) {
      const label = document.createElement('span');
      label.append(document.createTextNode('Opacity '), $('opacityValue'));
      const input = $('mapOpacity');
      opacity.classList.add('cmpri-map-slider'); opacity.replaceChildren(label, input);
      sliders.prepend(opacity);
    }
    const tools = document.querySelector('.map-tools');
    if (tools) tools.prepend(sliders);
    if ($('mapLayerControlsHost')) $('mapLayerControlsHost').append(host.querySelector('.cmpri-map-menu-bar'));
    const attribution = document.createElement('div'); attribution.id = 'mapAttribution'; attribution.className = 'cmpri-map-attribution';
    const source = document.createElement('span'); source.id = 'mapAttributionSource'; source.textContent = 'USGS · NOAA/NWS';
    attribution.append(source); shell.append(attribution);
    if ($('mapLegend')) shell.append($('mapLegend'));
    ['mapHelp', 'mapStatus', 'openMapReference', 'observedRadarNote', 'tryLiveFeeds'].forEach((id) => $(id)?.remove());
    $('mapLayerRadar').addEventListener('change', (event) => selectLayer('radar', event.target.checked));
    $('mapLayerRoads').addEventListener('change', (event) => selectLayer('roads', event.target.checked));
    $('mapLayerImpacts').addEventListener('change', (event) => selectLayer('impacts', event.target.checked));
    $('mapLayerAlerts').addEventListener('change', (event) => { state.showAlerts = event.target.checked; closeAlertDetails(); mark('propertyAlerts', 'Selected · ' + (state.showAlerts ? state.alertStatus : 'property alert areas hidden')); updateUI(); queueDraw(); });
    $('mapBackgroundStyle').addEventListener('change', (event) => { state.backgroundStyle = event.target.value; mark('mapBackgroundStyle', 'Selected · ' + event.target.selectedOptions[0].textContent + '; weather selections unchanged'); updateUI(); queueDraw(); });
    $('playbackSpeed').addEventListener('input', (event) => { state.playbackSpeed = PLAYBACK_SPEEDS[Number(event.target.value)] || 'normal'; mark('playbackSpeed', 'Selected · ' + state.playbackSpeed + '; actual scan times unchanged'); updateUI(); });
    $('loopLength').addEventListener('input', (event) => { stopPlayback(); state.loopMinutes = Number(event.target.value); applyLoopWindow(); mark('loopLength', 'Selected · ' + state.loopMinutes + ' min requested / ' + availableWindowMinutes() + ' min published coverage'); updateUI(); queueDraw(); if (state.opened && state.active) void loadFrame(state.frame); });
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
    window.cmpriGroundMap?.init({ referenceEnabled: GEOGRAPHIC_REFERENCE_ENABLED, onChange: () => { updateGroundStatus(); queueDraw(); emit(); } });
    const on = (id, event, handler) => { if ($(id)) $(id).addEventListener(event, handler); };
    on('moreNoaaProducts', 'toggle', () => mark('moreNoaaProducts', 'Exercised · optional NOAA product choices ' + ($('moreNoaaProducts').open ? 'expanded' : 'collapsed') + '; no feed request'));
    on('mapBackgroundMenu', 'toggle', () => mark('mapBackgroundMenu', 'Exercised · Map menu ' + ($('mapBackgroundMenu').open ? 'opened' : 'closed')));
    on('mapLayersMenu', 'toggle', () => mark('mapLayersMenu', 'Exercised · Layers menu ' + ($('mapLayersMenu').open ? 'opened' : 'closed')));
    on('playLoop', 'click', play);
    on('previousFrame', 'click', () => { stopPlayback(); setFrame(state.frame - 1, 'previousFrame'); });
    on('nextFrame', 'click', () => { stopPlayback(); setFrame(state.frame + 1, 'nextFrame'); });
    on('frameRange', 'input', (event) => { stopPlayback(); setFrame(Number(event.target.value), 'frameRange'); });
    on('mapOpacity', 'input', (event) => { state.opacity = Number(event.target.value) / 100; mark('opacity', 'Exercised · weather-layer opacity ' + Math.round(state.opacity * 100) + '%'); updateUI(); queueDraw(); });
    on('showEchoes', 'change', (event) => { selectLayer('radar', event.target.checked); mark('showEchoes', 'Exercised · selected observed product ' + (state.showRadar ? 'shown' : 'hidden') + '; playback stopped'); });
    on('zoomIn', 'click', () => zoomBy(1.4, 'zoomIn'));
    on('zoomOut', 'click', () => zoomBy(1 / 1.4, 'zoomOut'));
    on('recenter', 'click', () => { stopPlayback(); closeAlertDetails(); state.center = { ...HOTEL }; state.zoom = 4; state.viewportRevision += 1; mark('recenter', 'Exercised · fixed hotel center and initial regional zoom restored'); queueDraw(); scheduleViewportImage(); emit(); });
    on('fullscreen', 'click', async () => {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else if (shell.classList.contains('expanded')) shell.classList.remove('expanded');
      else { try { await shell.requestFullscreen(); } catch { shell.classList.add('expanded'); } }
      mark('fullscreen', 'Exercised · same-map fullscreen toggled'); queueDraw();
    });
    on('layerSource', 'click', () => mark('sourceLink', 'Exercised · explicit official source navigation'));
    on('productTabs', 'click', (event) => { const button = event.target.closest('[data-layer]'); if (button) selectLayer(button.dataset.layer); });
    document.addEventListener('fullscreenchange', () => { if ($('fullscreen')) $('fullscreen').setAttribute('aria-label', document.fullscreenElement === shell ? 'Exit map fullscreen' : 'Toggle map fullscreen'); queueDraw(); });
    let gestureMoved = false, suppressClickUntil = 0;
    canvas.addEventListener('pointerdown', (event) => {
      if (!state.opened || !state.active || event.button !== 0) return;
      event.preventDefault(); stopPlayback(); closeAlertDetails();
      if (!pointers.size) gestureMoved = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging'); canvas.focus({ preventScroll: true }); resetGesture();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = Array.from(pointers.values());
      if (points.length >= 2 && gesture.type === 'pinch') {
        const first = localPoint(points[0].x, points[0].y), second = localPoint(points[1].x, points[1].y), geo = geometry();
        const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
        const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        state.zoom = Math.max(0.45, Math.min(1024, gesture.zoom * distance / gesture.distance));
        const resolution = 620 / state.zoom;
        setCenter(gesture.fixed.x - (midpoint.x - geo.width / 2) * resolution, gesture.fixed.y + (midpoint.y - geo.height / 2) * resolution);
        gestureMoved = true; mark('pinchZoom', 'Exercised · actual two-pointer midpoint-anchored zoom at ' + state.zoom.toFixed(2) + '×');
      } else if (gesture.type === 'pan') {
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        setCenter(gesture.center.x - dx * gesture.resolution, gesture.center.y + dy * gesture.resolution);
        if (Math.hypot(dx, dy) > 4) gestureMoved = true;
        mark('pan', 'Exercised · pointer / touch moves shared geographic and weather viewport');
      }
      state.viewportRevision += 1; queueDraw();
    });
    const endGesture = (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId); resetGesture();
      if (!pointers.size) {
        canvas.classList.remove('dragging');
        suppressClickUntil = gestureMoved ? Date.now() + 400 : 0;
        scheduleViewportImage(); emit();
      }
    };
    canvas.addEventListener('pointerup', endGesture); canvas.addEventListener('pointercancel', endGesture); canvas.addEventListener('lostpointercapture', endGesture);
    canvas.addEventListener('click', (event) => { if (Date.now() >= suppressClickUntil && event.detail <= 1) showAlertDetails(localPoint(event.clientX, event.clientY)); });
    shell.addEventListener('click', () => {
      if (state.opened && state.active) { state.wheelZoomActive = true; emit(); }
    });
    shell.addEventListener('pointerleave', () => {
      state.wheelZoomActive = false; emit();
    });
    canvas.addEventListener('wheel', (event) => {
      if (!state.opened || !state.active || !state.wheelZoomActive) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      zoomBy(Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), 'wheelZoom', localPoint(event.clientX, event.clientY));
    }, { passive: false });
    canvas.addEventListener('dblclick', (event) => { event.preventDefault(); zoomBy(event.shiftKey ? 0.5 : 2, 'doubleClickZoom', localPoint(event.clientX, event.clientY)); });
    canvas.addEventListener('keydown', (event) => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.4, 'zoomIn'); }
      else if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.4, 'zoomOut'); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); stopPlayback(); closeAlertDetails(); const geo = geometry(), move = geo.resolution * 50;
        state.center = unproject(geo.center.x + (event.key === 'ArrowRight' ? move : event.key === 'ArrowLeft' ? -move : 0), geo.center.y + (event.key === 'ArrowUp' ? move : event.key === 'ArrowDown' ? -move : 0));
        mark('pan', 'Exercised · keyboard arrow moves shared viewport'); queueDraw(); scheduleViewportImage(); emit();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('mapAlertDetails')) { event.preventDefault(); event.stopPropagation(); closeAlertDetails(); }
      else if (event.key === 'Escape' && shell.classList.contains('expanded')) { event.preventDefault(); event.stopPropagation(); shell.classList.remove('expanded'); queueDraw(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    window.addEventListener('pagehide', close);
    updateUI(); return window.cmpriWeatherMap;
  }
  function beginOpenAttempt() {
    if (state.opened && state.active && !document.hidden && (!state.openAttempted || !state.fetchedAt)) {
      state.openAttempted = true;
      void tryLive();
    }
  }
  function open() {
    init(); if (!state.initialized) return getState();
    if (!state.opened) state.openAttempted = false;
    state.opened = true; state.active = true;
    window.cmpriGroundMap?.open();
    if (!state.mapReady) { context = canvas.getContext('2d'); observer = new ResizeObserver(queueDraw); state.mapReady = true; }
    observer.observe(canvas); updateUI(); queueDraw(); beginOpenAttempt(); scheduleRefresh(); emit(); return getState();
  }
  function pause() {
    state.active = false; state.wheelZoomActive = false; stopRefreshTimer(); stopPlayback(); cancelRequests();
    window.cmpriGroundMap?.close(); pointers.clear(); gesture = null;
    canvas?.classList.remove('dragging'); closeAlertDetails();
    if (viewportTimer !== null) { clearTimeout(viewportTimer); viewportTimer = null; }
    if (state.mode === 'live') {
      if (/Loading|loading/.test(state.radarStatus)) state.radarStatus = 'Unavailable · request stopped when view became inactive';
      if (/Loading|loading/.test(state.impactsStatus)) state.impactsStatus = 'Unavailable · request stopped when view became inactive';
      if (/Loading|loading/.test(state.wms.status)) state.wms.status = 'Unavailable · WMS request stopped when view became inactive';
      if (/Loading|loading/.test(state.wms.legendStatus)) state.wms.legendStatus = 'Unavailable · WMS legend request stopped when view became inactive';
    }
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    emit(); return getState();
  }
  function resume() {
    if (!state.opened || document.hidden) return getState();
    state.active = true; window.cmpriGroundMap?.open(); queueDraw(); updateUI(); beginOpenAttempt(); scheduleRefresh(); return getState();
  }
  function close() {
    pause(); state.opened = false; observer?.disconnect();
    stopWms(true);
    if (document.fullscreenElement === shell) void document.exitFullscreen().catch(() => {});
    shell?.classList.remove('expanded'); emit(); return getState();
  }
  function getState() {
    return { initialized: state.initialized, opened: state.opened, active: state.active,
      mapReady: state.mapReady, mode: state.mode, activeLayer: state.activeLayer,
      layers: { radar: state.showRadar, roads: state.roads, impacts: state.impacts, alerts: state.showAlerts },
      frame: state.frame, frameCount: frameCount(), playing: playbackRunning,
      displayedFrame: state.frames.findIndex((frame) => frame.time === state.displayedTime), displayedScanTime: state.displayedTime,
      catalogFrameCount: state.catalogFrames.length, availableWindowMinutes: availableWindowMinutes(), loopMinutes: state.loopMinutes, playbackSpeed: state.playbackSpeed,
      backgroundStyle: state.backgroundStyle, grid: state.grid, ground: window.cmpriGroundMap?.getState() || null,
      alerts: { count: state.alerts.length, geometryless: state.alertGeometryless, checkedAt: state.alertCheckedAt, status: state.alertStatus, source: state.alertSource },
      wms: { ...state.wms, pending: wmsControllers.size, loading: wmsLoading || wmsMetadataLoading, queued: wmsQueued,
        imageLoaded: Boolean(wmsRaster), legendLoaded: Boolean(wmsLegendUrl), extent: wmsRaster ? { ...wmsRaster.extent } : null },
      reflectivity: { ...reflectivity, legendLoaded: Boolean(reflectivityLegendUrl) },
      center: { ...state.center }, zoom: state.zoom, opacity: state.opacity,
      wheelZoomActive: state.wheelZoomActive,
      refresh: { intervalMs: REFRESH_INTERVAL, nextAt: refreshTimer !== null ? refreshDueAt : null, scheduled: refreshTimer !== null },
      networkRequests: state.networkRequests, pendingRequests: controllers.size,
      rasterLoads: loadingImages.size, rasterQueue: queuedFrame === null ? 0 : 1, rasterLoadLimit: 2, imageCacheSize: images.size,
      buffering: document.querySelector('.loop')?.dataset.loading === 'true',
      databaseCalls: 0, pushes: 0,
      status: { radar: state.radarStatus, roads: state.roadsStatus, impacts: state.impactsStatus },
      fetchedAt: state.fetchedAt, forecastIssue: state.forecastIssue,
      forecastStart: state.forecastStart, forecastEnd: state.forecastEnd,
      forecastCoverage: { ...state.forecastCoverage }, forecastExtent: state.forecastExtent ? { ...state.forecastExtent } : null,
      scanTimes: state.frames.map((frame) => frame.time),
      verified: Object.fromEntries(verified) };
  }
  window.cmpriWeatherMap = { init, open, close, pause, resume, getState, selectLayer, setAlerts };
}());
