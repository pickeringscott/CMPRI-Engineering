/* Review-only embedded map component. No application records, database, GPS or push access.
 * Actual NOAA requests begin when Weather opens and refresh only while its map is visible.
 * Missing IDOT reports remain unavailable. No fabricated weather geometry. */
(function () {
  'use strict';
  const HOTEL = Object.freeze({ lat: 40.138080, lon: -88.251416 });
  const REFLECTIVITY = Object.freeze({ product: 'reflectivity', layer: 'conus_bref_qcd', style: 'radar_reflectivity',
    source: 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows' });
  const MOSAIC_BOUNDS = [
    ['conus', -130, 20, -60, 55], ['alaska', -176, 50, -126, 72],
    ['carib', -90, 10, -60, 25], ['hawaii', -164, 15, -151, 26], ['guam', 140, 9, 150, 18],
  ];
  const MOSAIC_LAYERS = { reflectivity: 'bref_qcd', ptype: 'pcpn_typ', composite: 'cref_qcd', echoTops: 'neet_v18' };
  const LOCAL_LAYERS = { reflectivity: 'sr_bref', velocity: 'sr_bvel', kilxReflectivity: 'sr_bref',
    dualPolType: 'bdhc', hourlyRain: 'boha', stormTotal: 'bdsa' };
  const WSSI = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer';
  const CENTRAL = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', hour12: new URLSearchParams(location.search).get('clock') !== '24'
  });
  const RADIUS = 6378137;
  const MIN_MAP_ZOOM = 0.075;
  const REFRESH_INTERVAL = 5 * 60 * 1000;
  const IMAGE_CACHE_LIMIT = 64;
  const PLAYBACK_SPEEDS = Object.freeze(['slow', 'normal', 'fast']);
  const PLAYBACK_MULTIPLIERS = Object.freeze({ slow: 0.5, normal: 1, fast: 2 });
  const ADDITIONAL_RADAR_LAYERS = Object.freeze([
    ['composite', 'Composite'], ['echoTops', 'Echo tops'], ['kilxReflectivity', 'KILX radar'],
    ['dualPolType', 'Dual-pol type'], ['hourlyRain', '1-hr rain'], ['stormTotal', 'Storm total'],
  ]);
  const MAX_TEMPERATURE_AGE = 90 * 60 * 1000;
  const ALLOWED_TEMPERATURE_QUALITY = new Set(['C', 'S', 'V', 'G', 'T']);
  // Official NWS station locations, ordered from central Illinois to the wider continental US.
  const TEMPERATURE_STATIONS = [
    ['KCMI', 'Champaign', 40.0324, -88.2755],
    ['KTIP', 'Rantoul', 40.2895, -88.1473],
    ['KBMI', 'Bloomington', 40.4769, -88.9158],
    ['KDEC', 'Decatur', 39.8308, -88.8719],
    ['KPRG', 'Paris', 39.6982, -87.6669],
    ['KMTO', 'Mattoon', 39.4781, -88.2792],
    ['KSPI', 'Springfield', 39.8453, -89.684],
    ['KPIA', 'Peoria', 40.6675, -89.6839],
    ['KIJX', 'Jacksonville', 39.774, -90.2419],
    ['KUIN', 'Quincy', 39.9371, -91.1966],
    ['KGBG', 'Galesburg', 40.9329, -90.4334],
    ['KIKK', 'Kankakee', 41.0687, -87.8537],
    ['KAAA', 'Lincoln', 40.1589, -89.3389],
    ['KLOT', 'Romeoville', 41.6031, -88.1016],
    ['KJOT', 'Joliet', 41.5175, -88.179],
    ['KCMY', 'Sparta', 43.9583, -90.7378],
    ['KMWA', 'Marion', 37.7667, -89.0099],
    ['KOLY', 'Olney', 38.7213, -88.1799],
    ['KRSV', 'Robinson', 39.0136, -87.6485],
    ['KALN', 'Alton', 38.8897, -90.0316],
    ['KPWK', 'Wheeling', 42.1208, -87.9047],
    ['KDPA', 'West Chicago', 41.8964, -88.2511],
    ['KORD', 'Chicago', 41.9797, -87.9044],
    ['KRFD', 'Rockford', 42.1928, -89.0933],
    ['KMLI', 'Moline', 41.4482, -90.5236],
    ['KSTL', 'St. Louis', 38.7525, -90.3736],
    ['KIRK', 'Kirksville', 40.0972, -92.5433],
    ['KCOU', 'Columbia', 38.8169, -92.2183],
    ['KBRL', 'Burlington', 40.7729, -91.1254],
    ['KDBQ', 'Dubuque', 42.3984, -90.7091],
    ['KCID', 'Cedar Rapids', 41.883, -91.7246],
    ['KDSM', 'Des Moines', 41.534, -93.6531],
    ['KEVV', 'Evansville', 38.0431, -87.5203],
    ['KHUF', 'Terre Haute', 39.4429, -87.3221],
    ['KLAF', 'Lafayette', 40.4125, -86.9475],
    ['KIND', 'Indianapolis', 39.7252, -86.2816],
    ['KTYQ', 'Zionsville', 40.0307, -86.2515],
    ['KBMG', 'Bloomington, IN', 39.1431, -86.6167],
    ['KSBN', 'South Bend', 41.7089, -86.3186],
    ['KFWA', 'Fort Wayne', 40.9725, -85.2064],
    ['KGRR', 'Grand Rapids', 42.8808, -85.5228],
    ['KMKE', 'Milwaukee', 42.955, -87.9044],
    ['KMSN', 'Madison', 43.1406, -89.3453],
    ['KDVN', 'Davenport', 41.6134, -90.5948],
    ['KDTW', 'Detroit', 42.2314, -83.3308],
    ['KCLE', 'Cleveland', 41.4057, -81.8519],
    ['KLUK', 'Cincinnati', 39.1058, -84.4158],
    ['KCMH', 'Columbus', 39.9907, -82.8769],
    ['KSDF', 'Louisville', 38.1741, -85.7365],
    ['KBNA', 'Nashville', 36.1189, -86.6892],
    ['KMEM', 'Memphis', 35.0564, -89.9863],
    ['KLIT', 'Little Rock', 34.7267, -92.2361],
    ['KSGF', 'Springfield, MO', 37.2397, -93.3897],
    ['KMCI', 'Kansas City', 39.2972, -94.7306],
    ['KOMA', 'Omaha', 41.3119, -95.9018],
    ['KMSP', 'Minneapolis', 44.8831, -93.2289],
    ['KDLH', 'Duluth', 46.8435, -92.1866],
    ['KFSD', 'Sioux Falls', 43.5769, -96.7536],
    ['KFAR', 'Fargo', 46.9253, -96.8111],
    ['KBIS', 'Bismarck', 46.7825, -100.7572],
    ['KICT', 'Wichita', 37.6472, -97.4294],
    ['KOKC', 'Oklahoma City', 35.3886, -97.6003],
    ['KDFW', 'Dallas–Fort Worth', 32.8974, -97.022],
    ['KSAT', 'San Antonio', 29.5328, -98.4636],
    ['KIAH', 'Houston', 29.9844, -95.3607],
    ['KMSY', 'New Orleans', 29.9928, -90.2508],
    ['KBHM', 'Birmingham', 33.5656, -86.745],
    ['KATL', 'Atlanta', 33.6403, -84.4269],
    ['KJAX', 'Jacksonville, FL', 30.4953, -81.6937],
    ['KMIA', 'Miami', 25.7906, -80.3164],
    ['KCHS', 'Charleston', 32.8989, -80.0406],
    ['KCLT', 'Charlotte', 35.2083, -80.9614],
    ['KRDU', 'Raleigh', 35.8922, -78.7819],
    ['KRIC', 'Richmond', 37.5111, -77.3233],
    ['KDCA', 'Washington', 38.8483, -77.0342],
    ['KPHL', 'Philadelphia', 39.8733, -75.2268],
    ['KJFK', 'New York', 40.6392, -73.7639],
    ['KBOS', 'Boston', 42.3606, -71.0106],
    ['KPIT', 'Pittsburgh', 40.4846, -80.2145],
    ['KBUF', 'Buffalo', 42.94, -78.736],
    ['KBTV', 'Burlington, VT', 44.4681, -73.1503],
    ['KPWM', 'Portland, ME', 43.6422, -70.3044],
    ['KDEN', 'Denver', 39.8466, -104.6562],
    ['KABQ', 'Albuquerque', 35.0417, -106.6147],
    ['KELP', 'El Paso', 31.8111, -106.3758],
    ['KPHX', 'Phoenix', 33.4278, -112.0035],
    ['KLAS', 'Las Vegas', 36.0719, -115.1634],
    ['KLAX', 'Los Angeles', 33.9381, -118.3889],
    ['KSAN', 'San Diego', 32.7336, -117.1831],
    ['KSFO', 'San Francisco', 37.6196, -122.3656],
    ['KRNO', 'Reno', 39.5078, -119.7682],
    ['KSLC', 'Salt Lake City', 40.7707, -111.965],
    ['KBOI', 'Boise', 43.567, -116.2405],
    ['KPDT', 'Pendleton', 45.6976, -118.8344],
    ['KPDX', 'Portland, OR', 45.5958, -122.6092],
    ['KSEA', 'Seattle', 47.4447, -122.3136],
    ['KGEG', 'Spokane', 47.6214, -117.5278],
    ['KMSO', 'Missoula', 46.9208, -114.0925],
    ['KBIL', 'Billings', 45.8069, -108.5422],
    ['KCYS', 'Cheyenne', 41.1579, -104.8081],
    ['KAMA', 'Amarillo', 35.22, -101.7172],
  ].map(([id, name, lat, lon]) => ({ id, name, lat, lon }));
  // Fixed official exports verified as georeferenced PNGs on the branch preview.
  const GEOGRAPHIC_REFERENCE_ENABLED = true;
  const $ = (id) => document.getElementById(id);
  const state = {
    initialized: false, opened: false, active: false, mapReady: false,
    mode: 'live', activeLayer: 'reflectivity', frame: 0, zoom: 4, radarRegion: 'conus', radarStation: null,
    backgroundStyle: 'aerial', grid: false, playbackSpeed: 'normal', loopMinutes: 90, wheelZoomActive: false,
    catalogFrames: [], displayedTime: null,
    showAlerts: true, alerts: [], alertFeedStatus: null, alertStatus: 'Unknown · waiting for the NWS property alert response',
    alertSource: null, alertCheckedAt: null, alertGeometryless: 0,
    enabled: { velocity: false, ptype: false, cloudCover: false, composite: false, echoTops: false,
      kilxReflectivity: false, dualPolType: false, hourlyRain: false, stormTotal: false },
    center: { ...HOTEL }, opacity: 0.65, showRadar: true, roads: false, impacts: false, temperatures: false,
    frames: [], radarStatus: 'Waiting for Weather to open', roadsStatus: 'Unavailable · exact IDOT feed / report timestamps unverified',
    impactsStatus: 'Waiting for Weather to open', openAttempted: false, networkRequests: 0, fetchedAt: null,
    reportTime: null, catalogFetchedAt: null, forecastIssue: null, forecastStart: null, forecastEnd: null,
    forecastFeatures: [], forecastRenderer: [], forecastExtent: null,
    forecastCoverage: { returned: 0, valid: 0, stale: 0, invalid: 0 }, error: '', viewportRevision: 0
  };
  let canvas, context, shell, observer, raf = null, loop = null, gesture = null, viewportTimer = null;
  let playbackRunning = false, followLatest = false, playbackGeneration = 0, frameSelection = 0;
  let queuedFrame = null;
  let frameQueue = [];
  let frameViewport = '';
  let reflectivityLegendUrl = null, reflectivityLegendLoading = false;
  const reflectivity = { ...REFLECTIVITY, legendSource: null, legendStatus: 'Not loaded' };
  const wmsControllers = new Set();
  const pointers = new Map();
  let generation = 0, liveBusy = false;
  let refreshTimer = null, refreshDueAt = null;
  const controllers = new Set();
  const images = new Map();
  // The pixels on screen own a reference independently of the bounded cache.
  // Eviction must never close them before a verified replacement can be drawn.
  let displayedRaster = null;
  const loadingImages = new Map();
  const failedImages = new Set();
  const verified = new Map();
  const reportCells = new Map();
  let stationHost, radarStations = [], stationListLoading = false, stationListRetryAt = 0;
  const stationMarkers = new Map();
  const temperatureCache = new Map();
  const temperatureRequests = new Map();
  const temperaturePins = new Map();
  let temperatureHost, temperatureViewport = '', temperatureTimer = null;
  let visibleTemperatureStations = [];
  const productInfo = {
    velocity: ['Local velocity · KILX', 'The latest advertised KILX velocity image and official legend load through the preview transport. Velocity is radar-relative motion, not hotel surface wind.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows?service=wms&version=1.3.0&request=GetCapabilities'],
    ptype: ['Precipitation type', 'The latest advertised NOAA precipitation-type analysis and official legend load through the preview transport. No rain, snow or ice classification is inferred from reflectivity colors.', 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_pcpn_typ/ows?service=wms&version=1.3.0&request=GetCapabilities'],
    cloudCover: ['Forecast cloud cover', 'NWS NDFD forecast percentage of sky covered by opaque clouds. Uses the current or next advertised UTC valid time and the newest source issuance for that time. The source does not advertise an official PNG color key; no substitute palette is drawn.', 'https://digital.weather.gov/ndfd.conus/wms?service=WMS&version=1.1.1&request=GetCapabilities'],
    composite: ['Composite reflectivity', 'NOAA CONUS composite reflectivity.', 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_cref_qcd/ows'],
    echoTops: ['Echo tops', 'NOAA CONUS enhanced echo tops.', 'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_neet_v18/ows'],
    kilxReflectivity: ['KILX reflectivity', 'Local KILX super-resolution base reflectivity.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows'],
    dualPolType: ['KILX dual-pol type', 'Local KILX dual-polarization hydrometeor classification.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows'],
    hourlyRain: ['KILX 1-hour rain', 'Local KILX one-hour precipitation accumulation.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows'],
    stormTotal: ['KILX storm total', 'Local KILX storm-total precipitation.', 'https://opengeo.ncep.noaa.gov/geoserver/kilx/ows'],
  };
  const WMS_PRODUCTS = Object.freeze({
    velocity: { product: 'velocity', layer: 'kilx_sr_bvel', style: 'radar_velocity', title: 'Local velocity · KILX' },
    ptype: { product: 'precipitation', layer: 'conus_pcpn_typ', style: 'radar_precip_type', title: 'Precipitation type · NOAA analysis' },
    cloudCover: { product: 'cloudCover', layer: 'ndfd.conus.sky', style: '', title: 'Forecast cloud cover', forecast: true, units: '%', staleAfterMinutes: 60 },
    composite: { product: 'composite', layer: 'conus_cref_qcd', style: 'radar_reflectivity', title: productInfo.composite[0] },
    echoTops: { product: 'echoTops', layer: 'conus_neet_v18', style: 'radar_echo_tops', title: productInfo.echoTops[0] },
    kilxReflectivity: { product: 'kilx', layer: 'kilx_sr_bref', style: 'radar_reflectivity', title: productInfo.kilxReflectivity[0] },
    dualPolType: { product: 'kilx', layer: 'kilx_bdhc', style: 'radar_bdhc', title: productInfo.dualPolType[0] },
    hourlyRain: { product: 'kilx', layer: 'kilx_boha', style: 'radar_boha', title: productInfo.hourlyRain[0] },
    stormTotal: { product: 'kilx', layer: 'kilx_bdsa', style: 'radar_bdsa', title: productInfo.stormTotal[0] },
  });
  const wmsLayers = Object.fromEntries(Object.entries(WMS_PRODUCTS).map(([name, product]) => [name, {
    metadata: null, raster: null, legendUrl: null, loading: false, queued: false,
    metadataLoading: false, legendLoading: false, selection: 0, controllers: new Set(),
    state: { product: product.product, layer: null, style: null, time: null, status: 'Not selected', source: productInfo[name][2],
      mapSource: null, legendSource: null, legendStatus: 'Not loaded', displayedTime: null, sourceTime: null, kind: product.forecast ? 'forecast' : 'observation', units: product.units || null }
  }]));
  const controls = [
    ['mapLayersMenu', 'Layers menu', 'CMPRI overlay', 'NOAA observed products, NWS/WPC WSSI and property alerts; IDOT reports unavailable', 'Toggle independent observed, forecast and official-alert overlays over the same aerial map.'],
    ['backgroundAerial', 'Aerial background', 'CMPRI embedded map', 'USGS historical imagery', 'Show published USGS ground imagery; acquisition date may be unknown. This is not a current weather satellite image.'],
    ['geographicReference', 'Geographic roads and town names', 'CMPRI display of official USGS geography', 'USGS Transportation PNG and GNIS incorporated-place GeoJSON', 'Draw actual major roads and deduplicated town names at their official point coordinates over aerial imagery. These are geographic reference features, not reported winter road conditions.'],
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
    ['wmsLegend', 'Official observed-product legends', 'CMPRI image display', 'NOAA WMS GetLegendGraphic for each selected advertised style', 'Render the actual PNG legends returned by NOAA; missing legends stay unavailable. Units and categories are not invented.'],
    ['cloudCover', 'Forecast cloud cover', 'CMPRI overlay', 'NWS NDFD WMS 1.1.1 · ndfd.conus.sky / empty source default style / advertised VTIT', 'Display the official regional opaque-cloud forecast percentage under radar and geographic references. Uses an exact advertised UTC forecast valid time, shown in Central time. No satellite imagery or invented color key is substituted.'],
    ...ADDITIONAL_RADAR_LAYERS.map(([name]) => {
      const [label, description, source] = productInfo[name];
      return [name, label, 'CMPRI overlay', source, description];
    }),
    ['temperatures', 'Temperatures', 'CMPRI overlay', 'National Weather Service station observations', 'Plot quality-checked recent air temperatures at the reporting stations visible in the map.'],
    ['moreNoaaProducts', 'More NOAA products · expand / collapse', 'CMPRI overlay', 'None · local presentation of official product links', 'Expand or collapse optional velocity and precipitation-type choices. This disclosure does not request a feed or change the independent map layers.'],
    ['pin', 'Fixed hotel pin', 'Embedded map component · CMPRI-authored', 'Marriott hotel View Map coordinates', 'Plot 40.138080, −88.251416 in the same projection as every selected layer; no GPS.'],
    ['pan', 'Pan · drag / touch / arrow keys', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Move the shared viewport; every visible layer and hotel pin moves together.'],
    ['zoomIn', 'Zoom in', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Increase shared map scale; plus key also works.'],
    ['zoomOut', 'Zoom out', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Decrease shared map scale; minus key also works.'],
    ['recenter', 'Recenter', 'Embedded map component · CMPRI-authored', 'Marriott fixed hotel coordinates', 'Restore the hotel-centered initial extent without device location access.'],
    ['fullscreen', 'Fullscreen / exit', 'Embedded map component · CMPRI-authored', 'Browser Fullscreen API; CSS fallback', 'Expand the same map. Escape exits; no separate radar app or iframe.'],
    ['opacity', 'Opacity', 'Embedded map component · CMPRI-authored', 'None · local presentation', 'Change weather-layer opacity together. USGS background and hotel pin retain contrast.'],
    ['legend', 'Layer legends', 'Embedded map component · CMPRI-authored', 'Official NOAA product legends and WSSI renderer; IDOT unavailable', 'Show compact official observed-product and forecast-impact legends in the map’s upper-left corner.'],
    ['playLoop', 'Play / pause', 'Embedded map component · CMPRI-authored', 'Exact NOAA catalog rasters', 'Play only while Weather is visible. Close, hidden tab, and pause stop its local timer. No prediction or future radar.'],
    ['frameRange', 'Scan seek slider', 'Embedded map component · CMPRI-authored', 'Actual NOAA catalog times', 'Pause and select one exact frame; live timestamps are never synthesized.'],
    ['showEchoes', 'Show selected observed product', 'Embedded map component · CMPRI-authored', 'Same official NOAA source as selected product', 'Hide/show reflectivity, velocity or precipitation-type rendering without silently switching products; other layers remain independent.'],
    ['automaticRefresh', 'Automatic foreground map refresh', 'CMPRI embedded map', 'NOAA reflectivity WMS, WSSI layer 4 and selected velocity, precipitation-type and NDFD cloud-cover WMS', 'Refresh published map products every five minutes while the Weather map is open and visible. Closing, switching tabs or hiding the document stops its timer and aborts requests. No database work or server scheduler.'],
    ['sourceLink', 'Official product link', 'CMPRI overlay', 'Selected official NOAA/NWS product page', 'Open the source page on explicit click. It does not load a third-party app into this map.']
  ];
  function formatTime(value) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    if (window.cmpriWeatherClock) return window.cmpriWeatherClock.stamp(value);
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
    const edge = 20037508.34;
    return { xmin: Math.max(-edge, geo.center.x - halfWidth), ymin: Math.max(-edge, geo.center.y - halfHeight),
      xmax: Math.min(edge, geo.center.x + halfWidth), ymax: Math.min(edge, geo.center.y + halfHeight) };
  }
  function mosaicRegion(geo) {
    const { xmin, ymin, xmax, ymax } = viewport(geo);
    const sw = unproject(xmin, ymin), ne = unproject(xmax, ymax), center = state.center;
    const contained = MOSAIC_BOUNDS.find(([, west, south, east, north]) => center.lon >= west && center.lon <= east
      && center.lat >= south && center.lat <= north);
    if (contained) return contained[0];
    let region = null, largestOverlap = 0;
    for (const [name, west, south, east, north] of MOSAIC_BOUNDS) {
      const overlap = Math.max(0, Math.min(ne.lon, east) - Math.max(sw.lon, west))
        * Math.max(0, Math.min(ne.lat, north) - Math.max(sw.lat, south));
      if (overlap > largestOverlap) { largestOverlap = overlap; region = name; }
    }
    return region;
  }
  function productAtLocation(name) {
    const product = name === 'reflectivity' ? REFLECTIVITY : WMS_PRODUCTS[name];
    if (state.radarStation && LOCAL_LAYERS[name]) {
      const site = state.radarStation.id.toLowerCase();
      return { ...product, product: 'station', station: state.radarStation.id, layer: site + '_' + LOCAL_LAYERS[name],
        source: 'https://opengeo.ncep.noaa.gov/geoserver/' + site + '/ows' };
    }
    if (!MOSAIC_LAYERS[name] || state.radarRegion === 'conus') return product;
    if (!state.radarRegion) return null;
    const region = state.radarRegion, layer = region + '_' + MOSAIC_LAYERS[name];
    return { ...product, region, layer, source: 'https://opengeo.ncep.noaa.gov/geoserver/' + region + '/' + layer + '/ows' };
  }
  function productParameters(product) {
    return { product: product.product, ...(product.station && { station: product.station }),
      ...(product.region && { region: product.region }) };
  }
  function wmsLayerTitle(name) {
    const title = WMS_PRODUCTS[name].title;
    return state.radarStation && LOCAL_LAYERS[name] ? title.replace('KILX', state.radarStation.id) : title;
  }
  function changeRadarCoverage(region, station) {
    if (region === state.radarRegion && station?.id === state.radarStation?.id) return false;
    const layers = ['reflectivity', ...Object.keys(wmsLayers)];
    const previous = new Map(layers.map((name) => [name, productAtLocation(name)?.layer]));
    state.radarRegion = region; state.radarStation = station;
    stopPlayback(); cancelRequests();
    for (const name of layers) {
      const product = productAtLocation(name);
      if (previous.get(name) === product?.layer) continue;
      if (name === 'reflectivity') {
        const bitmaps = new Set([...images.values(), displayedRaster].filter(Boolean).map(({ bitmap }) => bitmap));
        bitmaps.forEach((bitmap) => bitmap.close?.()); images.clear(); displayedRaster = null;
        state.frames = []; state.catalogFrames = []; state.displayedTime = null; state.catalogFetchedAt = null;
        state.frame = 0; followLatest = true; frameViewport = ''; failedImages.clear();
        if (reflectivityLegendUrl) URL.revokeObjectURL(reflectivityLegendUrl);
        reflectivityLegendUrl = null;
        Object.assign(reflectivity, product || REFLECTIVITY, { region: product?.region || null, station: product?.station || null,
          legendSource: null, legendStatus: 'Not loaded' });
      } else {
        const record = wmsLayers[name]; record.raster?.bitmap.close?.();
        if (record.legendUrl) URL.revokeObjectURL(record.legendUrl);
        Object.assign(record, { raster: null, metadata: null, legendUrl: null });
        Object.assign(record.state, { product: product?.product || WMS_PRODUCTS[name].product, time: null,
          layer: null, style: null, sourceTime: null, displayedTime: null, mapSource: null, legendSource: null,
          source: product?.source || productInfo[name][2], status: 'Not loaded', legendStatus: 'Not loaded' });
      }
    }
    return true;
  }
  function selectRadarStation(station) {
    state.center = { lat: station.lat, lon: station.lon };
    state.zoom = 4; state.showRadar = true; state.viewportRevision += 1;
    closeAlertDetails(); const changed = changeRadarCoverage(mosaicRegion(geometry()), station);
    mark('radarStations', 'Selected official ' + station.id + ' WSR-88D station');
    $('mapLayerKilxReflectivity').querySelector('.cmpri-map-layer-label').textContent = station.id + ' radar';
    $('mapLayerRadar').title = station.name + ' (' + station.id + ') observed radar';
    updateUI(); queueDraw(); if (changed) void tryLive(); else scheduleViewportImage();
  }
  async function loadRadarStations() {
    if (stationListLoading || Date.now() < stationListRetryAt) return;
    const ticket = generation;
    stationListLoading = true; stationListRetryAt = Date.now() + REFRESH_INTERVAL;
    try {
      const catalog = await foregroundRead('/api/weather-preview/wms?product=station&op=stations', false, ticket);
      if (ticket !== generation || !Array.isArray(catalog.stations)) return;
      radarStations = catalog.stations.filter(({ id, name, lat, lon }) => /^[A-Z][A-Z0-9]{3}$/.test(id)
        && typeof name === 'string' && Number.isFinite(lat) && Math.abs(lat) <= 75 && Number.isFinite(lon) && Math.abs(lon) <= 180)
        .sort((a, b) => Number(b.id === 'KDVN') - Number(a.id === 'KDVN'));
      queueDraw();
    } catch (error) {
      if (error.name === 'AbortError') stationListRetryAt = 0;
    } finally { stationListLoading = false; }
  }
  function drawRadarStations(geo) {
    if (!stationHost || document.documentElement.classList.contains('cmpri-weather-radar-widget')) return;
    const selected = state.radarStation;
    const farEnough = geo.width * geo.resolution >= 245_000;
    if (farEnough && !radarStations.length) void loadRadarStations();
    const visible = new Set(), positions = [];
    const stations = farEnough ? radarStations : [];
    for (const station of selected ? [selected, ...stations.filter(({ id }) => id !== selected.id)] : stations) {
      const point = project(station.lat, station.lon, geo);
      if (point.x < 28 || point.x > geo.width - 28 || point.y < 26 || point.y > geo.height - 24
        || positions.some(({ x, y }) => Math.abs(x - point.x) < 44 && Math.abs(y - point.y) < 22)) continue;
      positions.push(point); visible.add(station.id);
      let marker = stationMarkers.get(station.id);
      if (!marker) {
        marker = document.createElement('button'); marker.type = 'button'; marker.className = 'cmpri-map-radar-station';
        marker.dataset.station = station.id; marker.textContent = station.id;
        marker.title = station.name + ' (' + station.id + ') · View station radar';
        marker.setAttribute('aria-label', marker.title);
        marker.addEventListener('click', () => selectRadarStation(station));
        stationMarkers.set(station.id, marker); stationHost.append(marker);
      }
      marker.style.left = point.x + 'px'; marker.style.top = point.y + 'px';
      marker.setAttribute('aria-pressed', String(station.id === selected?.id));
    }
    for (const [id, marker] of stationMarkers) {
      if (!visible.has(id)) { marker.remove(); stationMarkers.delete(id); }
    }
    stationHost.hidden = !visible.size;
  }
  function temperatureInView({ x, y }, geo) {
    return x >= 24 && x <= geo.width - 24 && y >= 27 && y < geo.height;
  }
  function selectTemperatureStations(geo) {
    // Use one station per screen cell, with at most six columns and four rows.
    const width = Math.max(56, geo.width / 6), height = Math.max(38, geo.height / 4);
    const cells = new Set();
    return TEMPERATURE_STATIONS.filter((station) => {
      const point = project(station.lat, station.lon, geo);
      if (!temperatureInView(point, geo)) return false;
      const cell = Math.floor(point.x / width) + ':' + Math.floor(point.y / height);
      if (cells.has(cell)) return false;
      cells.add(cell); return true;
    });
  }
  function isFreshTemperature(report, now) {
    return report && report.time <= now && now - report.time <= MAX_TEMPERATURE_AGE;
  }
  async function readTemperature(station, signal) {
    const url = 'https://api.weather.gov/stations/' + station.id + '/observations/latest?require_qc=true';
    const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/geo+json' } });
    if (!response.ok) throw new Error('NWS station observation unavailable');
    const { geometry: location, properties } = await response.json();
    const [lon, lat] = location?.type === 'Point' ? (location.coordinates || []) : [];
    const temperature = properties?.temperature, unit = temperature?.unitCode?.split(':').at(-1);
    const value = temperature?.value;
    const fahrenheit = !Number.isFinite(value) ? null : unit === 'degC' ? value * 9 / 5 + 32 : unit === 'degF' ? value : null;
    const report = { lon, lat, fahrenheit, time: Date.parse(properties?.timestamp) };
    if (!Number.isFinite(lat) || Math.abs(lat) > 75 || !Number.isFinite(lon) || Math.abs(lon) > 180
      || !Number.isFinite(fahrenheit) || fahrenheit < -130 || fahrenheit > 140
      || (temperature?.qualityControl && !ALLOWED_TEMPERATURE_QUALITY.has(temperature.qualityControl))
      || !isFreshTemperature(report, Date.now())) return null;
    return report;
  }
  function refreshTemperatures() {
    if (!state.temperatures || !state.opened || !state.active || document.hidden) return;
    const now = Date.now();
    for (const station of visibleTemperatureStations) {
      if (temperatureRequests.size >= 6) return;
      const cached = temperatureCache.get(station.id);
      if (temperatureRequests.has(station.id) || cached?.retryAfter > now) continue;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const entry = { report: cached?.report, retryAfter: now + REFRESH_INTERVAL };
      temperatureCache.set(station.id, entry);
      temperatureRequests.set(station.id, controller);
      state.networkRequests += 1;
      readTemperature(station, controller.signal).then((report) => {
        if (report && (!entry.report || report.time >= entry.report.time)) entry.report = report;
      }).catch(() => {
        // A failed refresh may keep a still-current previously fetched observation.
      }).finally(() => {
        clearTimeout(timeout);
        if (temperatureRequests.get(station.id) !== controller) return;
        temperatureRequests.delete(station.id); queueDraw(); refreshTemperatures();
      });
    }
  }
  function stopTemperatures() {
    clearTimeout(temperatureTimer); temperatureTimer = null; temperatureViewport = '';
    for (const [id, controller] of temperatureRequests) {
      temperatureCache.get(id).retryAfter = 0;
      controller.abort();
    }
    temperatureRequests.clear();
    visibleTemperatureStations = [];
    temperaturePins.clear();
    if (temperatureHost) { temperatureHost.replaceChildren(); temperatureHost.hidden = true; }
  }
  function drawTemperatures(geo) {
    if (!state.temperatures || !temperatureHost) return;
    const viewKey = [geo.center.x, geo.center.y, geo.width, geo.height, geo.resolution].join('/');
    if (viewKey !== temperatureViewport) {
      temperatureViewport = viewKey;
      visibleTemperatureStations = selectTemperatureStations(geo);
      clearTimeout(temperatureTimer);
      temperatureTimer = setTimeout(refreshTemperatures, 180);
    }
    const now = Date.now(), shown = [];
    const current = new Set();
    for (const station of visibleTemperatureStations) {
      const report = temperatureCache.get(station.id)?.report;
      if (!isFreshTemperature(report, now)) continue;
      const point = project(report.lat, report.lon, geo);
      if (!temperatureInView(point, geo) || shown.some(({ x, y }) => Math.abs(x - point.x) < 46 && Math.abs(y - point.y) < 25)) continue;
      const color = window.cmpriWeatherVisuals?.colorAt(report.fahrenheit);
      if (!color) continue;
      shown.push(point); current.add(station.id);
      let pin = temperaturePins.get(station.id);
      if (!pin) {
        pin = document.createElement('span'); pin.className = 'cmpri-map-temperature-pin';
        pin.dataset.station = station.id; pin.setAttribute('role', 'img');
        temperaturePins.set(station.id, pin); temperatureHost.append(pin);
      }
      const brightness = [0.2126, 0.7152, 0.0722].reduce((result, weight, index) => {
        const channel = parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255;
        return result + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      }, 0);
      const degrees = Math.round(report.fahrenheit) + '°';
      pin.textContent = degrees;
      pin.title = station.name + ' · ' + degrees + 'F · NWS ' + station.id + ' · ' + formatTime(report.time);
      pin.setAttribute('aria-label', pin.title); pin.style.left = point.x + 'px'; pin.style.top = point.y + 'px';
      pin.style.backgroundColor = color; pin.style.color = brightness > 0.179 ? '#111' : '#fff';
    }
    for (const [id, pin] of temperaturePins) {
      if (current.has(id)) continue;
      pin.remove(); temperaturePins.delete(id);
    }
    temperatureHost.hidden = !shown.length;
    mark('temperatures', shown.length ? shown.length + ' recent NWS station observations on this map'
      : 'No recent NWS station observations displayed for this extent');
  }
  function wmsKey(name, geo) {
    return [name, wmsLayers[name].state.time, Math.round(geo.center.x), Math.round(geo.center.y), geo.resolution.toFixed(6), Math.round(geo.width), Math.round(geo.height)].join('|');
  }
  function stopWms(name) {
    const names = name ? [name] : Object.keys(wmsLayers);
    names.forEach((key) => {
      const record = wmsLayers[key]; record.selection += 1;
      record.controllers.forEach((controller) => controller.abort()); record.controllers.clear();
      record.loading = false; record.queued = false; record.metadataLoading = false; record.legendLoading = false;
    });
  }
  function latestAdvertisedTime(dimension) {
    const candidates = [];
    if (dimension?.default && dimension.default !== 'current') candidates.push(dimension.default);
    String(dimension?.values || '').split(',').forEach((entry) => {
      const parts = entry.trim().split('/'); candidates.push(parts.length > 1 ? parts[1] : parts[0]);
    });
    return candidates.filter((time) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= Date.now())
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  }
  function forecastValidTime(dimension) {
    const candidates = String(dimension?.values || '').split(',').map((value) => value.trim())
      .filter((value) => /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
      .map((sourceTime) => ({ sourceTime, time: sourceTime + 'Z', at: Date.parse(sourceTime + 'Z') }))
      .filter((value) => Number.isFinite(value.at) && value.at >= Date.now() && value.at - Date.now() <= 3 * 3600000)
      .sort((a, b) => a.at - b.at);
    return candidates[0] || null;
  }
  function wmsLoadedStatus(name) { return WMS_PRODUCTS[name].forecast ? 'Forecast cloud-cover image loaded' : 'Observed WMS image loaded'; }
  function wmsFreshness(name) {
    const product = WMS_PRODUCTS[name], time = wmsLayers[name].state.displayedTime;
    const ageMinutes = time && Number.isFinite(Date.parse(time)) ? Math.max(0, (Date.now() - Date.parse(time)) / 60000) : null;
    return { ageMinutes, staleAfterMinutes: product.staleAfterMinutes ?? null,
      stale: ageMinutes !== null && product.staleAfterMinutes !== undefined && ageMinutes > product.staleAfterMinutes };
  }
  async function loadWmsView(name) {
    const record = wmsLayers[name], product = productAtLocation(name);
    if (!record || !product || !state.opened || !state.active || document.hidden || !state.enabled[name] || !record.metadata) return;
    const geo = geometry(); if (!geo.width || !geo.height) return;
    const key = wmsKey(name, geo);
    if (record.raster?.key === key) { if (!record.state.status.startsWith('Unavailable')) record.state.status = wmsLoadedStatus(name); return true; }
    if (record.loading) { record.queued = true; return false; }
    record.loading = true;
    const ticket = generation, selection = record.selection, time = record.state.time, extent = viewport(geo);
    const width = Math.max(1, Math.min(1500, Math.round(geo.width))), height = Math.max(1, Math.min(1500, Math.round(geo.height)));
    record.state.status = product.forecast ? 'Loading NDFD forecast cloud-cover image' : 'Loading observed WMS image'; updateUI();
    try {
      const image = await wmsRequest({ ...productParameters(product), op: 'map', layer: record.state.layer, style: record.state.style,
        time: record.state.sourceTime || time, bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(','), width: String(width), height: String(height) }, true, ticket, record);
      const bitmap = await createImageBitmap(image.blob);
      if (ticket !== generation || selection !== record.selection || !state.opened || !state.active || !state.enabled[name] || key !== wmsKey(name, geometry())) { bitmap.close?.(); return false; }
      if (bitmap.width !== width || bitmap.height !== height) { bitmap.close?.(); throw new Error('Official WMS image dimensions do not match the georeferenced request'); }
      const imageTime = image.time && product.forecast ? image.time + (/Z$/.test(image.time) ? '' : 'Z') : image.time;
      if (imageTime && Date.parse(imageTime) !== Date.parse(time)) { bitmap.close?.(); throw new Error('Official WMS image time did not match the requested source time'); }
      record.raster?.bitmap.close?.(); record.raster = { key, bitmap, extent, time, product: product.product };
      record.state.displayedTime = time; record.state.mapSource = image.source || record.state.source;
      record.state.status = wmsLoadedStatus(name); mark(name, 'Actual independent NOAA WMS layer rendered at its advertised time');
      updateUI(); queueDraw(); return true;
    } catch (error) {
      if (ticket !== generation || selection !== record.selection) return false;
      record.state.status = 'Unavailable · ' + error.message; mark(name, record.state.status); updateUI(); return false;
    } finally {
      if (selection === record.selection && ticket === generation) {
        record.loading = false;
        if (record.queued && state.opened && state.active) { record.queued = false; void loadWmsView(name); }
        updateUI();
      }
    }
  }
  async function loadWmsLegend(name, selection, ticket) {
    const record = wmsLayers[name], product = productAtLocation(name);
    if (!product || !record.metadata || !record.metadata.metadata.legendSupported || record.legendLoading) return;
    record.legendLoading = true; record.state.legendStatus = 'Loading official PNG legend';
    try {
      const image = await wmsRequest({ ...productParameters(product), op: 'legend', layer: record.state.layer, style: record.state.style }, true, ticket, record);
      const bitmap = await createImageBitmap(image.blob);
      const dimensionsMatch = bitmap.width === 500 && bitmap.height === 30; bitmap.close?.();
      if (!dimensionsMatch) throw new Error('Official legend layout changed; compact source key unavailable');
      if (selection !== record.selection || ticket !== generation || !state.opened || !state.active) return;
      if (record.legendUrl) URL.revokeObjectURL(record.legendUrl);
      record.legendUrl = URL.createObjectURL(image.blob); record.state.legendSource = image.source || record.state.source;
      record.state.legendStatus = 'Official NOAA PNG legend loaded'; mark('wmsLegend', 'Actual official GetLegendGraphic PNG decoded'); updateUI();
    } catch (error) {
      if (selection === record.selection && ticket === generation) record.state.legendStatus = 'Unavailable · ' + error.message;
    } finally { if (selection === record.selection && ticket === generation) record.legendLoading = false; }
  }
  async function loadWmsProduct(name, refresh = false) {
    const record = wmsLayers[name], product = productAtLocation(name);
    if (!record || !state.opened || !state.active || !state.enabled[name]) return;
    if (!product) { record.state.status = 'Unavailable · outside the published NOAA coverage'; updateUI(); return; }
    if (record.metadataLoading) return;
    if (!refresh && record.metadata) {
      await Promise.allSettled([loadWmsView(name), record.legendUrl ? Promise.resolve() : loadWmsLegend(name, record.selection, generation)]); return;
    }
    stopWms(name); record.metadataLoading = true;
    const ticket = generation, selection = record.selection;
    record.state.status = 'Loading official WMS capabilities'; updateUI();
    try {
      const metadata = await wmsRequest({ ...productParameters(product), op: 'capabilities' }, false, ticket, record);
      if (ticket !== generation || selection !== record.selection || !state.opened || !state.active || !state.enabled[name]) return;
      const layer = metadata.layers?.find((candidate) => candidate.name === product.layer);
      const style = product.forecast && metadata.version === '1.1.1' ? { name: '', title: 'Official source default style' }
        : layer?.styles?.find((candidate) => candidate.name === product.style);
      if (!layer || !style || !metadata.mapFormats?.some((format) => format.toLowerCase() === 'image/png')
        || !layer.crs?.some((crs) => crs.toUpperCase() === 'EPSG:3857')) throw new Error('Required official layer, style, PNG or EPSG:3857 was not advertised');
      const valid = product.forecast ? forecastValidTime(Object.entries(layer.dimensions || {}).find(([name]) => name.toLowerCase() === 'vtit')?.[1]) : null;
      const time = product.forecast ? valid?.time : latestAdvertisedTime(layer.time);
      if (!time) throw new Error(product.forecast ? 'No current or next NDFD forecast valid time was advertised' : 'No concrete past observation time was advertised');
      record.metadata = { layer, style, metadata }; record.metadataLoading = false;
      Object.assign(record.state, { product: product.product, layer: layer.name, style: style.name, time,
        sourceTime: valid?.sourceTime || null, source: metadata.source || product.source || productInfo[name][2] });
      if (product.forecast && !metadata.legendSupported) record.state.legendStatus = 'Source does not advertise an official PNG color key';
      await Promise.allSettled([loadWmsView(name), metadata.legendSupported && !record.legendUrl ? loadWmsLegend(name, selection, ticket) : Promise.resolve()]);
    } catch (error) {
      if (ticket === generation && selection === record.selection) { record.state.status = 'Unavailable · ' + error.message; mark(name, record.state.status); updateUI(); }
    } finally { if (ticket === generation && selection === record.selection) record.metadataLoading = false; }
  }
  function loadSelectedImage() {
    primeFrames();
    return Promise.allSettled(Object.keys(wmsLayers).filter((name) => state.enabled[name]).map((name) => loadWmsProduct(name)));
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
    frameQueue = []; stopWms(); wmsControllers.clear();
    liveBusy = false;
  }
  async function foregroundRead(path, asBlob, ticket, wms = false) {
    if (!state.opened || !state.active || ticket !== generation) throw new DOMException('Weather closed', 'AbortError');
    const controller = new AbortController();
    controllers.add(controller);
    if (wms && typeof wms === 'object') { wmsControllers.add(controller); wms.controllers.add(controller); }
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
      if (wms && typeof wms === 'object') wms.controllers.delete(controller);
    }
  }
  function request(url, asBlob, ticket) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'mapservices.weather.noaa.gov') throw new Error('Unverified feed host');
    return foregroundRead('/api/weather-preview/map?url=' + encodeURIComponent(parsed.href), asBlob, ticket);
  }
  function wmsRequest(parameters, asBlob, ticket, record) {
    return foregroundRead('/api/weather-preview/wms?' + new URLSearchParams(parameters), asBlob, ticket, record);
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
  function coversViewport(image, geo) {
    const extent = viewport(geo), tolerance = Math.max(1, geo.resolution);
    return image.extent.xmin <= extent.xmin + tolerance && image.extent.ymin <= extent.ymin + tolerance
      && image.extent.xmax >= extent.xmax - tolerance && image.extent.ymax >= extent.ymax - tolerance;
  }
  function cachedFrame(index, geo, touch = false) {
    const time = state.frames[index]?.time;
    if (!time) return null;
    const exact = images.get(imageKey(index, geo));
    let image = exact && coversViewport(exact, geo) ? exact : null;
    if (!image) {
      image = Array.from(images.values()).filter((entry) => entry.time === time && coversViewport(entry, geo))
        .sort((a, b) => (a.extent.xmax - a.extent.xmin) * (a.extent.ymax - a.extent.ymin)
          - (b.extent.xmax - b.extent.xmin) * (b.extent.ymax - b.extent.ymin))[0] || null;
    }
    if (image && touch) { images.delete(image.key); images.set(image.key, image); }
    return image;
  }
  function trimImages(geo) {
    const times = new Set(state.frames.map((frame) => frame.time));
    while (images.size > IMAGE_CACHE_LIMIT) {
      const entries = Array.from(images.entries());
      const score = (image) => (times.has(image.time) ? 2 : 0) + (coversViewport(image, geo) ? 1 : 0);
      entries.sort((a, b) => score(a[1]) - score(b[1]));
      const [key, image] = entries[0]; images.delete(key);
      if (image !== displayedRaster) image.bitmap.close?.();
    }
  }
  function applyLoopWindow() {
    const selectedTime = state.frames[state.frame]?.time;
    const latest = state.catalogFrames[state.catalogFrames.length - 1]?.time;
    state.frames = latest ? state.catalogFrames.filter((frame) => frame.time >= latest - state.loopMinutes * 60000) : [];
    const retained = state.frames.findIndex((frame) => frame.time === selectedTime);
    state.frame = !followLatest && retained >= 0 ? retained : Math.max(0, state.frames.length - 1);
    // Keep the displayed raster and its real scan time until its replacement is ready,
    // including when a refresh advances the catalog beyond the previous loop window.
  }
  function availableWindowMinutes() {
    if (state.frames.length < 2) return 0;
    return Math.round((state.frames[state.frames.length - 1].time - state.frames[0].time) / 6000) / 10;
  }
  function frameProgress() {
    if (!canvas) return [];
    const geo = geometry();
    return state.frames.map((frame, index) => {
      const key = imageKey(index, geo);
      return { time: frame.time, status: cachedFrame(index, geo) ? 'ready' : loadingImages.has(key) ? 'loading' : failedImages.has(key) ? 'failed' : 'pending' };
    });
  }
  function pumpFrames() {
    if (!state.opened || !state.active || document.hidden || !state.showRadar) return;
    while (loadingImages.size < 2 && frameQueue.length) {
      const time = frameQueue.shift(), index = state.frames.findIndex((frame) => frame.time === time);
      if (index < 0) continue;
      const key = imageKey(index, geometry());
      if (!cachedFrame(index, geometry()) && !loadingImages.has(key) && !failedImages.has(key)) void loadFrame(index);
    }
  }
  function primeFrames() {
    if (!state.opened || !state.active || document.hidden || !state.showRadar || !state.frames.length) return;
    const geo = geometry(); if (!geo.width || !geo.height) return;
    const viewportKey = [Math.round(geo.center.x), Math.round(geo.center.y), state.zoom, geo.width, geo.height].join('|');
    if (viewportKey !== frameViewport) { frameQueue = []; queuedFrame = null; frameViewport = viewportKey; }
    const currentTimes = new Set(state.frames.map((frame) => frame.time));
    frameQueue = frameQueue.filter((time) => currentTimes.has(time));
    const order = [state.frames[state.frame], ...state.frames].filter(Boolean);
    const pending = new Set(frameQueue);
    order.forEach((frame) => {
      const index = state.frames.findIndex((entry) => entry.time === frame.time), key = imageKey(index, geo);
      if (!pending.has(frame.time) && !cachedFrame(index, geo) && !loadingImages.has(key) && !failedImages.has(key)) {
        frameQueue.push(frame.time); pending.add(frame.time);
      }
    });
    pumpFrames(); updateUI();
  }
  async function loadFrame(index) {
    const product = productAtLocation('reflectivity');
    if (state.mode !== 'live' || !state.opened || !state.active || !state.showRadar
      || !product || !state.frames[index]) return;
    const geo = geometry();
    if (!geo.width || !geo.height) return;
    const key = imageKey(index, geo);
    if (cachedFrame(index, geo, true)) { state.radarStatus = 'Observed image loaded'; return true; }
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
          ...productParameters(product), op: 'map', layer: product.layer, style: product.style,
          time: raster.advertisedTime, bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(','),
          width: String(width), height: String(height)
        }), true, ticket, 'reflectivity');
        const blob = result.blob;
        if (result.time && Date.parse(result.time) !== raster.time) throw new Error('NOAA reflectivity image time did not match the advertised scan');
        const bitmap = await createImageBitmap(blob);
        if (ticket !== generation || !state.opened || !state.active) { bitmap.close?.(); return; }
        if (bitmap.width !== width || bitmap.height !== height) { bitmap.close?.(); throw new Error('NOAA image dimensions did not match the georeferenced request'); }
        images.set(key, { key, bitmap, extent, time: raster.time });
        trimImages(geometry());
        state.radarStatus = 'Observed image loaded';
        mark('radar', 'Actual NOAA ' + product.layer + ' PNG loaded · explicit advertised scan time and matching map extent');
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
        if (ticket === generation && state.opened && state.active) { primeFrames(); updateUI(); }
      }
    })();
    loadingImages.set(key, task);
    updateUI();
    return task;
  }
  async function loadReflectivityLegend(ticket) {
    const product = productAtLocation('reflectivity');
    if (!product || reflectivityLegendUrl || reflectivityLegendLoading || !state.opened || !state.active) return;
    reflectivityLegendLoading = true;
    try {
      const result = await foregroundRead('/api/weather-preview/wms?' + new URLSearchParams({
        ...productParameters(product), op: 'legend', layer: product.layer, style: product.style
      }), true, ticket, 'reflectivity');
      const bitmap = await createImageBitmap(result.blob); bitmap.close?.();
      if (ticket !== generation || !state.opened || !state.active) return;
      reflectivityLegendUrl = URL.createObjectURL(result.blob);
      reflectivity.legendSource = result.source || product.source;
      reflectivity.legendStatus = 'Official NOAA reflectivity PNG legend loaded';
      mark('legend', 'Actual NOAA legend and observed ' + product.layer + ' imagery use the same advertised style');
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
    const product = productAtLocation('reflectivity');
    if (!product) throw new Error('No published NOAA radar coverage in this extent');
    state.radarStatus = 'Loading NOAA scan catalog'; updateUI();
    const metadata = await foregroundRead('/api/weather-preview/wms?' + new URLSearchParams({ ...productParameters(product), op: 'capabilities' }), false, ticket);
    if (ticket !== generation) return;
    const layer = metadata.layers?.find((candidate) => candidate.name === product.layer);
    const style = layer?.styles?.find((candidate) => candidate.name === product.style);
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
    state.catalogFrames = Array.from(scans.values()).sort((a, b) => a.time - b.time).slice(-64);
    applyLoopWindow();
    if (!state.frames.length) throw new Error('No explicit observed NOAA scan times were advertised');
    state.catalogFetchedAt = Date.now();
    Object.assign(reflectivity, product);
    state.radarStatus = 'Catalog verified · loading exact observed scan';
    mark('radar', 'NOAA ' + product.layer + ' verified · ' + state.frames.length + ' explicit advertised scan times');
    updateUI();
    primeFrames();
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
    void window.nwsLiveView?.refreshObservations?.();
    refreshTemperatures();
    state.mode = 'live'; failedImages.clear();
    state.radarStatus = 'Loading'; state.impactsStatus = 'Loading';
    state.roadsStatus = 'Unavailable · exact IDOT feed / report timestamps unverified';
    mark('roads', 'Live unavailable · concrete IDOT feed / report time unverified');
    state.error = '';
    const ticket = generation;
    mark('automaticRefresh', 'Loading published map products · visible map only; current observed frame retained');
    updateUI(); queueDraw();
    const results = await Promise.allSettled([radarCatalog(ticket), impactForecast(ticket), Promise.allSettled(Object.keys(wmsLayers).filter((name) => state.enabled[name]).map((name) => loadWmsProduct(name, true)))]);
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
    refreshDueAt = (state.fetchedAt || state.catalogFetchedAt || Date.now()) + REFRESH_INTERVAL;
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
    state.alertFeedStatus = envelope && ['live', 'stale'].includes(envelope.status) && Array.isArray(envelope.data?.features)
      ? envelope.status : 'unavailable';
    if (state.alertFeedStatus !== 'unavailable') {
      envelope.data.features.forEach((feature) => {
        const polygons = alertPolygons(feature.geometry);
        if (!polygons.length) state.alertGeometryless += 1;
        state.alerts.push({ id: feature.id, properties: feature.properties || {}, polygons });
      });
    }
    updateAlertStatus(); updateUI(); queueDraw(); return getState();
  }
  function updateAlertStatus() {
    if (state.alertFeedStatus === null) return;
    state.alertStatus = state.alertFeedStatus === 'unavailable'
      ? 'Unknown · official property alerts unavailable; no all-clear is inferred'
      : (state.alertFeedStatus === 'stale' ? 'STALE response · ' : '') + (state.alerts.length
        ? state.alerts.length + ' official alerts applying to hotel; ' + state.alertGeometryless + ' without renderable polygons remain in the official list'
        : 'No active alerts returned for the hotel at ' + formatTime(state.alertCheckedAt))
        + '. Scope is alerts applying to the hotel, not all alerts in the panned map.';
    mark('propertyAlerts', state.alertStatus);
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
    function timeLine(label, value) {
      const row = document.createElement('p'), time = document.createElement('time');
      time.dateTime = value || '';
      time.textContent = formatTime(value);
      row.append(document.createTextNode(label + ': '), time);
      return row;
    }
    panel.append(close, title, scope,
      timeLine('Effective', alert.properties.effective || alert.properties.onset),
      timeLine('Expires', alert.properties.ends || alert.properties.expires));
    const source = [alert.properties.web, alert.properties.id, alert.id].find((value) => {
      try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'weather.gov' || url.hostname.endsWith('.weather.gov')); } catch { return false; }
    });
    if (source) { const link = document.createElement('a'); link.href = source; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Official NWS bulletin ↗'; panel.append(link); }
    else { const note = document.createElement('p'); note.textContent = 'Bulletin link unavailable; read the official alert list above.'; panel.append(note); }
    shell.append(panel); mark('alertDetails', 'Exercised · actual NWS property alert polygon and official validity times');
  }
  function drawRaster(image, geo) {
    const extent = image.extent;
    context.save(); context.globalAlpha = state.opacity;
    context.drawImage(image.bitmap, geo.width / 2 + (extent.xmin - geo.center.x) / geo.resolution,
      geo.height / 2 - (extent.ymax - geo.center.y) / geo.resolution,
      (extent.xmax - extent.xmin) / geo.resolution, (extent.ymax - extent.ymin) / geo.resolution);
    context.restore();
  }
  function drawWms(name, geo) {
    if (state.enabled[name] && wmsLayers[name].raster) drawRaster(wmsLayers[name].raster, geo);
  }
  function drawRadar(geo) {
    let changed = false;
    if (state.showRadar) {
      const image = cachedFrame(state.frame, geo, true) || displayedRaster;
      if (image) {
        const previous = displayedRaster;
        changed = state.displayedTime !== image.time; displayedRaster = image; state.displayedTime = image.time;
        drawRaster(image, geo);
        if (previous && previous !== image && !images.has(previous.key)) previous.bitmap.close?.();
      }
    }
    // These independent observations share the same geographic viewport. Their
    // times remain distinct; velocity is never presented as hotel surface wind.
    drawWms('ptype', geo); drawWms('velocity', geo);
    ADDITIONAL_RADAR_LAYERS.forEach(([name]) => {
      if (name !== 'kilxReflectivity' || !state.radarStation || !state.showRadar || !displayedRaster) drawWms(name, geo);
    });
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
    // The pin tip, rather than the center of its head, is the hotel coordinate.
    context.beginPath(); context.moveTo(pin.x, pin.y); context.lineTo(pin.x - 6, pin.y - 10); context.lineTo(pin.x + 6, pin.y - 10); context.closePath(); context.fill(); context.stroke();
    context.beginPath(); context.arc(pin.x, pin.y - 14, 8, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = '#111'; context.beginPath(); context.arc(pin.x, pin.y - 14, 2.5, 0, Math.PI * 2); context.fill();
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
    drawWms('cloudCover', geo);
    drawImpacts(geo); drawRadar(geo);
    window.cmpriGroundMap?.drawReferences?.(context, geo);
    drawAlerts(geo); drawPin(geo); drawTemperatures(geo); drawRadarStations(geo);
    updateGroundStatus();
    mark('legend', 'Rendered · separate source/type labels for selected layers');
  }
  function queueDraw() {
    if (state.opened && state.active && !document.hidden && raf === null) raf = requestAnimationFrame(draw);
  }
  function frameCount() { return state.frames.length; }
  function scanTime() {
    const times = [];
    if (state.showRadar) {
      if (state.displayedTime !== null) times.push('Reflectivity: ' + formatTime(state.displayedTime));
      else if (state.radarStatus.startsWith('Unavailable')) times.push('Observed reflectivity unavailable');
    }
    Object.keys(wmsLayers).forEach((name) => {
      if (state.enabled[name] && wmsLayers[name].state.displayedTime) times.push(wmsLayerTitle(name) + (WMS_PRODUCTS[name].forecast ? ' valid: ' : ': ') + formatTime(wmsLayers[name].state.displayedTime)
        + (wmsFreshness(name).stale ? (WMS_PRODUCTS[name].forecast ? ' (expired forecast)' : ' (old observation)') : ''));
    });
    return times.join(' · ');
  }
  function legendItem(label, color) {
    const item = document.createElement('span'); item.className = 'cmpri-map-legend-item';
    const swatch = document.createElement('span'); swatch.className = 'cmpri-map-swatch'; swatch.style.backgroundColor = color;
    item.append(swatch, document.createTextNode(label)); return item;
  }
  function renderLegend() {
    const host = $('mapLegend'); if (!host) return;
    const fragment = document.createDocumentFragment();
    Object.entries(wmsLayers).forEach(([name, record]) => {
      if (!state.enabled[name]) return;
      if (WMS_PRODUCTS[name].forecast) {
        const row = document.createElement('div'); row.className = 'cmpri-map-legend-row'; row.dataset.legend = name;
        row.title = 'NWS forecast opaque-cloud percentage. An official PNG color key is not advertised; no unverified colors are shown in this key.';
        row.setAttribute('aria-label', row.title);
        const heading = document.createElement('strong'); heading.textContent = 'Forecast cloud cover · %'; row.append(heading);
        if (record.state.displayedTime) { const valid = document.createElement('span'); valid.className = 'cmpri-map-legend-note';
          valid.textContent = 'Valid ' + formatTime(record.state.displayedTime); row.append(valid); }
        fragment.append(row); return;
      }
      if (!record.legendUrl) return;
      const row = document.createElement('div'); row.className = 'cmpri-map-legend-row cmpri-wms-legend';
      row.dataset.legend = name;
      const heading = document.createElement('strong'); heading.textContent = wmsLayerTitle(name);
      const image = document.createElement('img'); image.id = 'mapWmsLegend-' + name; image.src = record.legendUrl;
      image.alt = 'Official NOAA legend for ' + record.state.layer + ', advertised style ' + record.state.style;
      if (name !== 'velocity' && name !== 'ptype') {
        row.append(heading, image); fragment.append(row); return;
      }
      const scale = document.createElement('div'); scale.className = 'cmpri-reflectivity-scale cmpri-source-scale';
      const ramp = document.createElement('div'); ramp.className = 'cmpri-reflectivity-ramp'; ramp.append(image);
      const ticks = document.createElement('div'); ticks.className = 'cmpri-reflectivity-ticks';
      // Both verified NOAA legends are 500×30, with the unchanged source color
      // band in rows 0–9. Reflow source labels at readable size in the same key.
      if (name === 'velocity') {
        heading.textContent = wmsLayerTitle(name) + ' · knots';
        ticks.classList.add('cmpri-velocity-ticks'); ticks.setAttribute('aria-label', 'Radial velocity in knots; RF is the source range-folded code');
        [['RF', 12], ['−100', 34], ['−80', 80], ['−60', 123], ['−45', 167], ['−20', 211],
          ['+0', 272], ['20', 316], ['45', 359], ['60', 402], ['80', 445], ['100', 488]].forEach(([value, x], index) => {
          const tick = document.createElement('span'); tick.textContent = value; tick.style.left = (x / 5) + '%';
          tick.style.top = index % 2 === 0 ? '12px' : '0'; ticks.append(tick);
        });
      } else {
        heading.textContent = 'Precipitation type · NOAA codes';
        ticks.classList.add('cmpri-source-code-ticks'); ticks.setAttribute('aria-label', 'Category codes printed in the official NOAA key');
        // Preserve the actual printed source glyphs. No category expansion is
        // inferred from colors or ambiguous abbreviations in this source PNG.
        [35.5, 107, 178.5, 250, 321.5, 393, 464.5].forEach((x) => {
          const tick = document.createElement('span'); tick.className = 'cmpri-source-code-tick';
          tick.style.left = (x / 5) + '%'; tick.style.backgroundImage = 'url("' + record.legendUrl + '")';
          tick.style.backgroundPosition = (13 - x * 1.5) + 'px -21px'; ticks.append(tick);
        });
      }
      scale.append(ramp, ticks); row.append(heading, scale);
      fragment.append(row);
    });
    if (state.showRadar) {
      if (reflectivityLegendUrl) {
        const row = document.createElement('div'); row.className = 'cmpri-map-legend-row cmpri-reflectivity-legend';
        const heading = document.createElement('strong'); heading.textContent = 'NOAA ' + (state.radarStation ? state.radarStation.id + ' ' : '') + 'reflectivity · dBZ';
        const image = document.createElement('img'); image.id = 'mapReflectivityLegend'; image.src = reflectivityLegendUrl;
        image.alt = 'Official NOAA reflectivity intensity legend for ' + reflectivity.layer + ', advertised style ' + reflectivity.style;
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
        scale.append(ramp, ticks); row.append(heading, scale); fragment.prepend(row);
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
    const keys = fragment.childElementCount;
    host.replaceChildren(keys ? fragment : 'No legend available for the selected layers.');
    if ($('mapLegendSummary')) $('mapLegendSummary').setAttribute('aria-label', 'Legends for selected map layers: ' + keys + ' keys');
  }
  function updateGroundStatus() {
    const ground = window.cmpriGroundMap?.getState();
    const attribution = (ground?.attribution || 'USGS') + ' · NOAA/NWS';
    const overzoom = Math.log2(156543.03392804097 / (620 / state.zoom)) > 16;
    if ($('mapAttributionSource')) $('mapAttributionSource').textContent = attribution;
    if ($('mapGroundStatus')) $('mapGroundStatus').textContent = ground
      ? (ground.visibleFailed ? (ground.visibleLoaded ? 'Geographic map incomplete. ' : 'Geographic map unavailable. ') : '')
        + (state.backgroundStyle === 'aerial' ? (ground.imageryAcquisitionYear ? 'Aerial capture year: ' + ground.imageryAcquisitionYear + '.' : 'Aerial capture year unavailable.') : '')
        + (state.backgroundStyle === 'aerial' && ground.reference?.enabled && [ground.reference.roads?.status, ground.reference.places?.status, ground.reference.routes?.status].some((status) => /unavailable/i.test(status || '')) ? ' Some roads, highway labels, or town labels are unavailable.' : '')
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
    const count = frameCount(), progress = frameProgress();
    const ready = progress.filter((frame) => frame.status === 'ready').length;
    const buffering = state.opened && state.active && state.showRadar && (loadingImages.size > 0 || state.openAttempted && !count && !state.radarStatus.startsWith('Unavailable'));
    document.querySelectorAll('.loop').forEach((bar) => { bar.dataset.loading = String(Boolean(buffering)); bar.setAttribute('aria-busy', String(Boolean(buffering))); });
    ['playLoop', 'frameRange', 'playbackSpeed', 'loopLength'].forEach((id) => { if ($(id)) $(id).disabled = !state.showRadar || count === 0; });
    if ($('returnLive')) $('returnLive').disabled = !state.showRadar || !count || followLatest;
    if ($('frameRange')) {
      const input = $('frameRange'); input.max = Math.max(0, count - 1); input.value = state.frame;
      input.setAttribute('aria-valuetext', 'Scan ' + (state.frame + 1) + ' of ' + count + '; ' + ready + ' scans ready. ' + scanTime());
      input.title = ready + ' of ' + count + ' observed scans ready; gray segments are loading or pending';
      input.style.backgroundImage = count ? 'linear-gradient(to right,' + progress.map((frame, index) => {
        const color = frame.status === 'ready' ? '#000000' : '#d3d3d3';
        return color + ' ' + index / count * 100 + '%,' + color + ' ' + (index + 1) / count * 100 + '%';
      }).join(',') + ')' : '';
    }
    if ($('scanTime')) $('scanTime').textContent = scanTime();
    if ($('loopLabel')) $('loopLabel').textContent = count ? 'Observed loop · ' + availableWindowMinutes() + ' min available / ' + state.loopMinutes + ' min requested' : '';
    const speed = PLAYBACK_MULTIPLIERS[state.playbackSpeed] + '×';
    if ($('playbackSpeed')) { $('playbackSpeed').value = String(PLAYBACK_SPEEDS.indexOf(state.playbackSpeed)); $('playbackSpeed').setAttribute('aria-valuetext', speed); }
    if ($('playbackSpeedValue')) $('playbackSpeedValue').textContent = speed;
    if ($('loopLength')) { $('loopLength').value = String(state.loopMinutes); $('loopLength').setAttribute('aria-valuetext', state.loopMinutes + ' minutes'); }
    if ($('loopLengthValue')) $('loopLengthValue').textContent = state.loopMinutes + ' min';
    const opacity = Math.round(state.opacity * 100);
    if ($('mapOpacity')) { $('mapOpacity').value = opacity; $('mapOpacity').setAttribute('aria-valuetext', opacity + '%'); }
    if ($('opacityValue')) $('opacityValue').textContent = opacity + '%';
    const selected = layerSelections();
    const unavailableLayer = {
      reflectivity: state.radarStatus.startsWith('Unavailable') && !displayedRaster,
      roads: true, impacts: state.impactsStatus.startsWith('Unavailable') && !state.forecastExtent,
      alerts: state.alertFeedStatus === 'unavailable',
      ...Object.fromEntries(Object.entries(wmsLayers).map(([name, record]) => [name,
        record.state.status.startsWith('Unavailable') && !record.raster])),
    };
    document.querySelectorAll('[data-map-layer]').forEach((button) => {
      const name = button.dataset.mapLayer;
      button.setAttribute('aria-pressed', String(Boolean(selected[name])));
      if (LOCAL_LAYERS[name] && productInfo[name]) button.title = productInfo[name][1].replaceAll('KILX', state.radarStation?.id || 'KILX');
      button.toggleAttribute('data-unavailable', Boolean(unavailableLayer[name]));
      if (unavailableLayer[name]) button.setAttribute('aria-description', 'Source unavailable');
      else button.removeAttribute('aria-description');
    });
    if (canvas) canvas.setAttribute('aria-label', 'USGS geographic map at fixed hotel coordinates. Selected layers: ' + Object.entries(selected).filter(([, on]) => on).map(([name]) => name).join(', ') + '. ' + scanTime() + '. Click the map to enable wheel zoom; leaving resets it. Drag, arrow keys, pinch and zoom buttons also work.');
    if ($('layerUnavailable')) $('layerUnavailable').hidden = true;
    const unavailable = [];
    Object.keys(wmsLayers).filter((name) => state.enabled[name]).forEach((name) => {
      const record = wmsLayers[name], freshness = wmsFreshness(name), title = wmsLayerTitle(name);
      if (record.state.status.startsWith('Unavailable')) unavailable.push(title + ' unavailable.' + (record.raster ? ' Last loaded image retained.' : ''));
      if (freshness.stale) unavailable.push(title + (WMS_PRODUCTS[name].forecast ? ' forecast is expired (' : ' observation is old (') + Math.floor(freshness.ageMinutes) + ' min).');
      if (WMS_PRODUCTS[name].note && record.state.legendStatus.startsWith('Unavailable')) unavailable.push(title + ' key unavailable.');
    });
    if (state.showRadar && state.radarStatus.startsWith('Unavailable')) unavailable.push('Observed reflectivity unavailable.');
    if (state.impacts && state.impactsStatus.startsWith('Unavailable')) unavailable.push('Forecast winter impacts unavailable.');
    if (state.roads) unavailable.push('Reported Illinois winter roads unavailable; exact IDOT report feed unverified.');
    if ($('mapFeedStatus')) $('mapFeedStatus').textContent = unavailable.join(' ');
    updateGroundStatus(); renderLegend(); emit();
  }
  function stopPlayback() {
    const displayed = state.frames.findIndex((frame) => frame.time === state.displayedTime);
    if (playbackRunning && displayed >= 0) state.frame = displayed;
    playbackRunning = false; playbackGeneration += 1;
    if (loop !== null) { clearTimeout(loop); loop = null; }
    const button = $('playLoop');
    if (button) {
      button.classList.remove('is-playing');
      button.setAttribute('aria-label', 'Play observed NOAA radar loop');
    }
    if (state.initialized) updateUI(); else emit();
  }
  async function setFrame(index, source) {
    const count = frameCount(); if (!count) return;
    if (source === 'frameRange') followLatest = false;
    const selection = ++frameSelection;
    state.frame = (index + count) % count;
    if (source) mark(source, 'Exercised · exact NOAA catalog frame selected');
    updateUI(); queueDraw();
    const loaded = await loadFrame(state.frame);
    if (selection === frameSelection && state.opened && state.active) { updateUI(); queueDraw(); }
    return loaded;
  }
  function play() {
    if (playbackRunning) { stopPlayback(); mark('playLoop', 'Paused at displayed scan; remaining frame loads continue'); return; }
    if (!state.opened || !state.active || document.hidden || !state.showRadar || !frameCount()) return;
    playbackRunning = true; followLatest = false; primeFrames();
    const ticket = ++playbackGeneration;
    const delay = () => 850 / PLAYBACK_MULTIPLIERS[state.playbackSpeed];
    const advance = () => {
      loop = null;
      if (!playbackRunning || ticket !== playbackGeneration || !state.opened || !state.active || document.hidden) return;
      const progress = frameProgress();
      for (let offset = 1; offset <= frameCount(); offset += 1) {
        const next = (state.frame + offset) % frameCount();
        if (progress[next]?.status === 'ready') { state.frame = next; break; }
      }
      updateUI(); queueDraw(); loop = setTimeout(advance, delay());
    };
    loop = setTimeout(advance, delay());
    const button = $('playLoop');
    if (button) {
      button.classList.add('is-playing');
      button.setAttribute('aria-label', 'Pause radar loop');
    }
    mark('playLoop', 'Cycles ready observed scans while remaining frames load; new ready scans join automatically'); updateUI();
  }
  function scheduleViewportImage() {
    if (viewportTimer !== null) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      if (!state.opened || !state.active || document.hidden) return;
      if (changeRadarCoverage(mosaicRegion(geometry()), state.radarStation)) void tryLive();
      else void loadSelectedImage();
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
    state.zoom = Math.max(MIN_MAP_ZOOM, Math.min(1024, state.zoom * factor));
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
  function layerSelections() {
    return { reflectivity: state.showRadar, ...state.enabled, roads: state.roads,
      impacts: state.impacts, alerts: state.showAlerts, temperatures: state.temperatures };
  }
  function selectLayer(name, enabled) {
    init();
    if (name === 'radar') name = 'reflectivity';
    if (name === 'winter') name = 'impacts';
    if (name === 'roads') { state.roads = enabled === undefined ? !state.roads : Boolean(enabled); }
    else if (name === 'impacts') {
      state.impacts = enabled === undefined ? !state.impacts : Boolean(enabled);
      if (state.impacts) ensureImpacts();
    }
    else if (name === 'alerts') { state.showAlerts = enabled === undefined ? !state.showAlerts : Boolean(enabled); closeAlertDetails(); }
    else if (name === 'temperatures') {
      state.temperatures = enabled === undefined ? !state.temperatures : Boolean(enabled);
      if (!state.temperatures) stopTemperatures();
    }
    else if (name === 'reflectivity') {
      state.showRadar = enabled === undefined ? !state.showRadar : Boolean(enabled);
      if (!state.showRadar) { stopPlayback(); frameQueue = []; queuedFrame = null; }
      else primeFrames();
    } else if (WMS_PRODUCTS[name]) {
      state.enabled[name] = enabled === undefined ? !state.enabled[name] : Boolean(enabled);
      if (state.enabled[name]) void loadWmsProduct(name); else stopWms(name);
    } else { mark(name, 'Unavailable · no verified embedded source'); return getState(); }
    state.activeLayer = name; mark(name, 'Independent layer ' + layerSelections()[name]);
    updateUI(); queueDraw(); return getState();
  }
  function renderControls() {
    const host = $('mapControlHost'); if (!host) return;
    const opacity = $('mapOpacity')?.closest('.opacity');
    host.innerHTML = `
      <div class="cmpri-map-menu-bar">
        <div class="cmpri-map-layer-buttons" role="group" aria-label="Independent weather map layers">
          <button type="button" id="mapLayerRadar" data-map-layer="reflectivity">Reflectivity</button>
          <button type="button" id="mapLayerVelocity" data-map-layer="velocity">Velocity</button>
          <button type="button" id="mapLayerPtype" data-map-layer="ptype">Precipitation type</button>
          <button type="button" id="mapLayerRoads" data-map-layer="roads">Reported winter roads</button>
          <button type="button" id="mapLayerImpacts" data-map-layer="impacts">Forecast winter impacts</button>
          <button type="button" id="mapLayerAlerts" data-map-layer="alerts">Official alerts</button>
          <button type="button" id="mapLayerCloudCover" data-map-layer="cloudCover">Forecast cloud cover</button>
        </div>
      </div>
      <div class="cmpri-map-playback-options">
        <label class="cmpri-map-slider" for="playbackSpeed">
          <span>Radar Speed <output id="playbackSpeedValue" for="playbackSpeed" aria-hidden="true">1×</output></span>
          <input id="playbackSpeed" type="range" min="0" max="2" step="1" value="1" aria-valuetext="1×">
        </label>
        <label class="cmpri-map-slider" for="loopLength">
          <span>Observation Loop <output id="loopLengthValue" for="loopLength" aria-hidden="true">90 min</output></span>
          <input id="loopLength" type="range" min="60" max="120" step="30" value="90" aria-valuetext="90 minutes">
        </label>
      </div>
      <p id="mapGroundStatus" class="cmpri-map-status-copy" role="status"></p>
      <p id="mapFeedStatus" class="cmpri-map-status-copy" role="status"></p>`;
    const layerGroup = host.querySelector('.cmpri-map-layer-buttons');
    layerGroup.tabIndex = 0;
    for (const [name, label] of [...ADDITIONAL_RADAR_LAYERS, ['temperatures', 'Temperatures']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.mapLayer = name;
      button.id = 'mapLayer' + name[0].toUpperCase() + name.slice(1);
      button.textContent = label; layerGroup.append(button);
    }
    const sliders = host.querySelector('.cmpri-map-playback-options');
    if (opacity) {
      const label = document.createElement('span');
      const value = $('opacityValue');
      value.setAttribute('aria-hidden', 'true');
      label.append(document.createTextNode('Opacity '), value);
      const input = $('mapOpacity');
      opacity.classList.add('cmpri-map-slider'); opacity.replaceChildren(label, input);
      sliders.prepend(opacity);
    }
    const tools = document.querySelector('.map-tools');
    if (tools) tools.prepend(sliders);
    if ($('mapLayerControlsHost')) $('mapLayerControlsHost').append(host.querySelector('.cmpri-map-menu-bar'));
    temperatureHost = document.createElement('div'); temperatureHost.className = 'cmpri-map-temperature-layer'; temperatureHost.hidden = true;
    temperatureHost.setAttribute('role', 'group'); temperatureHost.setAttribute('aria-label', 'NWS observed temperatures');
    shell.append(temperatureHost);
    stationHost = document.createElement('div'); stationHost.className = 'cmpri-map-radar-stations'; stationHost.hidden = true;
    stationHost.setAttribute('role', 'group'); stationHost.setAttribute('aria-label', 'NOAA radar stations');
    shell.append(stationHost);
    const attribution = document.createElement('div'); attribution.id = 'mapAttribution'; attribution.className = 'cmpri-map-attribution';
    const source = document.createElement('span'); source.id = 'mapAttributionSource'; source.textContent = 'USGS · NOAA/NWS';
    attribution.append(source);
    const overlay = document.createElement('div'); overlay.className = 'cmpri-map-overlay';
    const playback = $('playLoop').closest('.map-bottom');
    const latest = document.createElement('button'); latest.type = 'button'; latest.id = 'returnLive'; latest.textContent = 'Latest'; latest.disabled = true;
    $('frameRange').after(latest);
    host.append($('scanTime'), $('loopLabel'));
    overlay.append(playback, attribution); shell.append(overlay);
    if ($('mapLegend')) {
      const accordion = document.createElement('details'); accordion.id = 'mapLegendAccordion'; accordion.className = 'cmpri-map-legend-accordion';
      const summary = document.createElement('summary'); summary.id = 'mapLegendSummary'; summary.textContent = 'Legends';
      const contents = document.createElement('div'); contents.id = 'mapLegendContents';
      const legendRow = $('mapLegend').parentElement;
      contents.append($('mapLegend')); legendRow.remove();
      accordion.append(summary, contents); shell.append(accordion);
      accordion.addEventListener('toggle', () => { mark('legend', 'Legends ' + (accordion.open ? 'expanded' : 'collapsed') + '; no feed request'); emit(); });
    }
    ['mapHelp', 'mapStatus', 'openMapReference', 'observedRadarNote', 'tryLiveFeeds'].forEach((id) => $(id)?.remove());
    document.querySelectorAll('[data-map-layer]').forEach((button) => {
      const label = document.createElement('span'); label.className = 'cmpri-map-layer-label';
      label.textContent = button.textContent; button.replaceChildren(label);
      if (productInfo[button.dataset.mapLayer]) button.title = productInfo[button.dataset.mapLayer][1];
      button.addEventListener('click', () => selectLayer(button.dataset.mapLayer));
    });
    $('showEchoes')?.closest('label')?.remove();
    $('playbackSpeed').addEventListener('input', (event) => { state.playbackSpeed = PLAYBACK_SPEEDS[Number(event.target.value)] || 'normal'; mark('playbackSpeed', 'Selected · ' + state.playbackSpeed + '; actual scan times unchanged'); updateUI(); });
    $('loopLength').addEventListener('input', (event) => { const requested = Number(event.target.value); stopPlayback(); state.loopMinutes = requested; applyLoopWindow(); mark('loopLength', 'Selected · ' + state.loopMinutes + ' min requested / ' + availableWindowMinutes() + ' min published coverage'); updateUI(); queueDraw(); primeFrames(); });
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
    Object.entries({ zoomIn: 'Zoom In', zoomOut: 'Zoom Out', recenter: 'Recenter On Hotel', fullscreen: 'Fullscreen' }).forEach(([id, label]) => {
      if ($(id)) $(id).title = window.cmpriWeatherTooltips?.titleCase(label) || label;
    });
    window.cmpriGroundMap?.init({ referenceEnabled: GEOGRAPHIC_REFERENCE_ENABLED, onChange: () => { updateGroundStatus(); queueDraw(); emit(); } });
    const on = (id, event, handler) => { if ($(id)) $(id).addEventListener(event, handler); };
    on('moreNoaaProducts', 'toggle', () => mark('moreNoaaProducts', 'Exercised · optional NOAA product choices ' + ($('moreNoaaProducts').open ? 'expanded' : 'collapsed') + '; no feed request'));
    on('mapLayersMenu', 'toggle', () => mark('mapLayersMenu', 'Exercised · Layers menu ' + ($('mapLayersMenu').open ? 'opened' : 'closed')));
    on('playLoop', 'click', play);
    on('returnLive', 'click', () => { stopPlayback(); followLatest = true; void setFrame(frameCount() - 1); });
    on('frameRange', 'input', (event) => { const requested = Number(event.target.value); stopPlayback(); setFrame(requested, 'frameRange'); });
    on('mapOpacity', 'input', (event) => { state.opacity = Number(event.target.value) / 100; mark('opacity', 'Exercised · weather-layer opacity ' + Math.round(state.opacity * 100) + '%'); updateUI(); queueDraw(); });
    on('showEchoes', 'change', (event) => { selectLayer('radar', event.target.checked); mark('showEchoes', 'Exercised · selected observed product ' + (state.showRadar ? 'shown' : 'hidden') + '; playback stopped'); });
    on('zoomIn', 'click', () => zoomBy(1.4, 'zoomIn'));
    on('zoomOut', 'click', () => zoomBy(1 / 1.4, 'zoomOut'));
    on('recenter', 'click', () => {
      stopPlayback(); closeAlertDetails(); state.center = { ...HOTEL }; state.zoom = 4; state.viewportRevision += 1;
      const changed = changeRadarCoverage('conus', null);
      $('mapLayerKilxReflectivity').querySelector('.cmpri-map-layer-label').textContent = 'KILX radar';
      $('mapLayerRadar').removeAttribute('title');
      mark('recenter', 'Exercised · fixed hotel center and initial regional zoom restored');
      queueDraw(); if (changed) void tryLive(); else scheduleViewportImage(); emit();
    });
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
        state.zoom = Math.max(MIN_MAP_ZOOM, Math.min(1024, gesture.zoom * distance / gesture.distance));
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
    window.cmpriTimeFormat?.subscribe(() => {
      updateAlertStatus();
      updateUI();
      queueDraw();
      $('mapAlertDetails')?.querySelectorAll('time').forEach((time) => { time.textContent = formatTime(time.dateTime); });
    });
    updateUI(); return window.cmpriWeatherMap;
  }
  function beginOpenAttempt() {
    if (state.opened && state.active && !document.hidden && (!state.openAttempted || !state.catalogFrames.length)) {
      state.openAttempted = true;
      void tryLive();
    }
  }
  function ensureImpacts() {
    if (!state.impacts || state.forecastExtent || liveBusy || !state.opened || !state.active) return;
    const ticket = generation;
    void impactForecast(ticket).catch((error) => {
      if (ticket === generation && state.opened && state.active) { state.impactsStatus = 'Unavailable · ' + error.message; updateUI(); }
    });
  }
  function open() {
    init(); if (!state.initialized) return getState();
    state.opened = true; state.active = true;
    window.cmpriGroundMap?.open();
    if (!state.mapReady) { context = canvas.getContext('2d'); observer = new ResizeObserver(queueDraw); state.mapReady = true; }
    observer.observe(canvas); updateUI(); queueDraw(); beginOpenAttempt(); if (state.catalogFrames.length) void loadSelectedImage(); ensureImpacts(); scheduleRefresh(); emit(); return getState();
  }
  function pause() {
    state.active = false; state.wheelZoomActive = false; stopRefreshTimer(); stopPlayback(); cancelRequests();
    stopTemperatures();
    window.cmpriGroundMap?.close(); pointers.clear(); gesture = null;
    canvas?.classList.remove('dragging'); closeAlertDetails();
    if (viewportTimer !== null) { clearTimeout(viewportTimer); viewportTimer = null; }
    if (images.size && !state.radarStatus.startsWith('Unavailable')) state.radarStatus = 'Observed image loaded';
    Object.entries(wmsLayers).forEach(([name, record]) => { if (record.raster && !record.state.status.startsWith('Unavailable')) record.state.status = wmsLoadedStatus(name); });
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    emit(); return getState();
  }
  function resume() {
    if (!state.opened || document.hidden) return getState();
    state.active = true; window.cmpriGroundMap?.open(); queueDraw(); updateUI(); beginOpenAttempt(); if (state.catalogFrames.length) void loadSelectedImage(); ensureImpacts(); scheduleRefresh(); return getState();
  }
  function close() {
    pause(); state.opened = false; observer?.disconnect();
    if (document.fullscreenElement === shell) void document.exitFullscreen().catch(() => {});
    shell?.classList.remove('expanded'); emit(); return getState();
  }
  function wmsSnapshot(name) {
    const record = wmsLayers[name];
    return { ...record.state, ...wmsFreshness(name), pending: record.controllers.size, loading: record.loading || record.metadataLoading,
      queued: record.queued, imageLoaded: Boolean(record.raster), legendLoaded: Boolean(record.legendUrl),
      extent: record.raster ? { ...record.raster.extent } : null };
  }
  function getState() {
    const progress = frameProgress();
    const hotelPoint = canvas ? project(HOTEL.lat, HOTEL.lon, geometry()) : null;
    const currentWms = WMS_PRODUCTS[state.activeLayer] ? state.activeLayer : Object.keys(wmsLayers).find((name) => state.enabled[name]) || 'velocity';
    return { initialized: state.initialized, opened: state.opened, active: state.active,
      mapReady: state.mapReady, mode: state.mode, activeLayer: state.activeLayer,
      radarRegion: state.radarRegion, radarStation: state.radarStation?.id || null, radarStationsVisible: [...stationMarkers.keys()],
      layers: { radar: state.showRadar, ...layerSelections() },
      frame: state.frame, frameCount: frameCount(), playing: playbackRunning,
      displayedFrame: state.frames.findIndex((frame) => frame.time === state.displayedTime), displayedScanTime: state.displayedTime,
      catalogFrameCount: state.catalogFrames.length, availableWindowMinutes: availableWindowMinutes(), loopMinutes: state.loopMinutes, playbackSpeed: state.playbackSpeed,
      backgroundStyle: state.backgroundStyle, grid: state.grid, ground: window.cmpriGroundMap?.getState() || null,
      alerts: { count: state.alerts.length, geometryless: state.alertGeometryless, checkedAt: state.alertCheckedAt, status: state.alertStatus, source: state.alertSource },
      wms: wmsSnapshot(currentWms), wmsLayers: Object.fromEntries(Object.keys(wmsLayers).map((name) => [name, wmsSnapshot(name)])),
      reflectivity: { ...reflectivity, legendLoaded: Boolean(reflectivityLegendUrl) },
      center: { ...state.center }, zoom: state.zoom, opacity: state.opacity, wheelZoomActive: state.wheelZoomActive,
      pinAnchor: { ...HOTEL, x: hotelPoint?.x ?? null, y: hotelPoint?.y ?? null, anchor: 'tip' },
      legend: { expanded: Boolean($('mapLegendAccordion')?.open), keyCount: $('mapLegend')?.childElementCount || 0 },
      refresh: { intervalMs: REFRESH_INTERVAL, nextAt: refreshTimer !== null ? refreshDueAt : null, scheduled: refreshTimer !== null },
      networkRequests: state.networkRequests, pendingRequests: controllers.size + temperatureRequests.size,
      temperatureStations: [...temperaturePins.keys()], temperaturePending: temperatureRequests.size,
      rasterLoads: loadingImages.size, rasterQueue: frameQueue.length + (queuedFrame === null ? 0 : 1), rasterLoadLimit: 2,
      imageCacheSize: images.size, imageCacheLimit: IMAGE_CACHE_LIMIT, frameProgress: progress,
      displayedRasterLoaded: Boolean(displayedRaster), displayedRasterRetained: Boolean(displayedRaster && !images.has(displayedRaster.key)),
      displayedRasterExtent: displayedRaster ? { ...displayedRaster.extent } : null,
      readyFrameCount: progress.filter((frame) => frame.status === 'ready').length,
      buffering: document.querySelector('.loop')?.dataset.loading === 'true', databaseCalls: 0, pushes: 0,
      status: { radar: state.radarStatus, roads: state.roadsStatus, impacts: state.impactsStatus },
      fetchedAt: state.fetchedAt, forecastIssue: state.forecastIssue, forecastStart: state.forecastStart, forecastEnd: state.forecastEnd,
      forecastCoverage: { ...state.forecastCoverage }, forecastExtent: state.forecastExtent ? { ...state.forecastExtent } : null,
      scanTimes: state.frames.map((frame) => frame.time), verified: Object.fromEntries(verified) };
  }
  window.cmpriWeatherMap = { init, open, close, pause, resume, getState, selectLayer, setAlerts };
}());
