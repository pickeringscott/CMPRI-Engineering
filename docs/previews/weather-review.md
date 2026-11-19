# Weather: published NWS feeds in the CMPRI branch preview

The review entry is the actual CMPRI Engineering dashboard: **Operations → Weather**. It opens through the existing `DesktopWindow` / `DesktopFrame` system, with one native titlebar and the embedded Weather content. The launcher is enabled in Vercel preview builds and local development, and disabled in production builds. The preview HTML and read-only weather endpoints return 404 in production.

## Live NWS content first

Opening Weather now reads the actual official NOAA/NWS feeds. Sample temperatures, forecasts, radar echoes, road geometry and forecast-impact polygons have been removed from the Weather view. A failure displays unavailable / unknown; it never substitutes a simulated weather result or an all-clear.

The property is fixed at 40.138080, -88.251416, from the [Residence Inn Champaign Marriott map link](https://www.marriott.com/en-us/hotels/cmpri-residence-inn-champaign/overview/), 502 West Marketview Drive. No GPS or user-supplied location is requested.

`GET /api/weather-preview` is a preview-only read transport for `api.weather.gov`. It requests NWS's canonical four-decimal point (`40.1381,-88.2514`, derived from the verified fixed hotel coordinates) to discover the property's forecast, hourly forecast, forecast grid and observation stations from `/points`, then reads the nearest returned station's latest report. The property alert point query runs independently so failed forecast discovery cannot hide alerts. Original NWS response documents, official URLs, source timestamps, retrieval times and independent resource states are retained in the response and shown in the view. Applicable alerts without polygons remain included.

`GET /api/weather-preview/map?url=...` transports only allowlisted read resources on `mapservices.weather.noaa.gov`: the time-enabled MRMS radar catalog / exact raster exports and WSSI overall Days 1–3 layer 4. Radar reads the authoritative extent/dimensions as JSON, then requests the same LockRaster IDs directly as PNG, avoiding NOAA temporary-file URLs. It rejects arbitrary hosts, credentials, redirects, unsupported operations and oversized responses. Observed scan labels come from actual catalog times and LockRaster IDs. WSSI guidance is separate from reported road surfaces, with issue / valid times, incomplete coverage and stale guidance labeled.

`GET /api/weather-preview/basemap` reads only fixed USGS Topo, ImageryOnly and ShadedReliefOnly tile services. The Map menu provides Gray, Roads, Aerial and Terrain backgrounds beneath the same NOAA weather and fixed property pin. Gray is a local presentation of Topo; Roads retains the original Topo colors and labels. Aerial is historical USGS/USDA ground imagery, not a live cloud image. Tile levels are bounded to 0–16; closer zoom enlarges existing pixels. The engine limits concurrent tile requests to four, retains at most 150 decoded tiles, and keeps USGS request counts separate from NOAA requests.

The preview-only endpoints omit upstream credentials and have bounded requests. They do not import CMPRI authentication, Supabase, notification dispatch, storage or scheduling code. Weather loads on open or an explicit refresh, aborts pending requests on close, and stops map playback on close, hiding, or leaving the map tab. Panning and changing backgrounds request only the necessary geographic tiles; observed playback requests actual selected radar scans. There is no real adaptive scheduler.

IDOT's official reported winter-road map is linked but its concrete feed and report timestamps remain unverified. The map therefore labels current road reports unavailable and draws no substitute road network or conditions. Satellite and lightning retain official source links and are unavailable in the embedded map.

`GET /api/weather-preview/wms` reads only the fixed official KILX and CONUS precipitation-type NCEP services. Capabilities preserve actual named layers, inherited CRS/time dimensions, styles and raw XML. Map requests use EPSG:3857 and only advertised layer/style/time values; legends use the same fixed service. PNG type/signature, size and request duration are bounded. Unknown outer preview-sharing parameters are ignored and never forwarded. Velocity and precipitation type load their latest actual observed image and official legend when selected; reflectivity retains its catalog-based observed loop.

Map and Layers menus are separate. Layers independently select observed radar, reported-road availability, WSSI forecast impacts and actual property-applicable alert polygons. Alerts without polygons remain in the alert list and are counted in the map explanation. Wheel, double click and two-finger pinch zoom around the interaction point; dragging pans; recenter returns to the fixed hotel. Observed playback has speed and 60/90/120-minute window choices limited to actual available scans. Each control records its CMPRI component owner, official feed, effect and browser exercise in the Sources tab.

## Review behavior retained

The existing compact layout is retained while the feed is verified. Hourly and extended forecasts use matching horizontal cards populated with official NWS periods and text. Observation values use source units with explicit conversions; null values remain unavailable. Snow and ice use only provided forecast-grid interval amounts and disclose partial coverage.

Notification and adaptive-check examples remain explicitly simulated, as requested. They do not interpret a simulated warning as a live NWS bulletin or send a real push. Watches and Weather Prep heads-ups stay regular simulated notifications; applicable warning and forecast walkway-icing examples can open the Guest Safety demonstration with the specified property instructions. The 24/12-hour year-round Weather Prep and separate within-12-hour Winter Prep examples remain available in the Notifications tab.

The virtual shared checker retains 5 / 2 / 1-minute modes, cached-result comparisons and delivery keys. It models database work only for material alert state changes or notification work; it performs no database activity.

## Verification

Unit tests validate fixed-source routing, independent failed-resource handling, raw response preservation, polygonless alerts, missing/stale data, production blocking, map URL restrictions, binary response limits and native dashboard launcher behavior. Browser fixture tests exercise the actual `/engineering` dashboard and native window on desktop/mobile without live accounts or database writes. Fixtures are implementation tests, not proof of live feed availability.

The draft PR records the separate published endpoint verification results. Successful endpoint envelopes and actual NOAA catalog/export responses are required before describing a feed as verified live. No production deployment or main branch is changed.

```sh
node --experimental-strip-types --test tests/weather-dashboard-launcher.test.mjs tests/weather-preview-api.test.mjs tests/weather-preview-map-api.test.mjs tests/weather-preview-basemap-api.test.mjs tests/weather-preview-wms-api.test.mjs tests/weather-preview-routing.test.mjs tests/manual-preview.test.mjs
VERCEL_ENV=preview NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
VERCEL_ENV=preview npm run start -- --port 3019
python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3019 --output /tmp/cmpri-weather-dashboard-review
python tests/browser/weather_map_basemaps.py --base http://127.0.0.1:3019 --output /tmp/cmpri-weather-ground-review
python tests/browser/weather_map_wms.py --base http://127.0.0.1:3019 --output /tmp/cmpri-weather-wms-review
```

Reviewed guidelines remain the current Illinois / Iowa palette and native dashboard / DesktopWindow / profile notification patterns. No applicable root/source `AGENTS.md` is present; the only discovered AGENTS file is in an archived `.bridge` subdirectory.

## Published source check

On November 19, 2026 at 2:14 AM Central, the published preview returned HTTP 200 with live responses for all seven NWS resources. Point discovery selected ILX grid 95,74; the reported station was KCMI (Willard), observed at 1:15 AM Central. The response contained 14 extended periods, 156 hourly periods, and zero active alerts returned at that check time. The interface displays those actual source times and does not treat an earlier empty result as a continuing all-clear.

The NOAA radar catalog also returned HTTP 200 with 18 actual catalog records, and an exact raster export returned its real extent and dimensions. The WSSI property-point query returned HTTP 200 with no mapped impact polygon at that point; this does not guarantee clear travel conditions. At 2:25 AM Central, the published direct export returned HTTP 200, image/png, 1,661 bytes for the exact NOAA raster ID and the 1200×340 extent. The proxy verifies the PNG signature before returning bytes. A separate NWS recheck at 2:25 AM Central again returned all seven resources live, with a KCMI observation time of 2:00 AM Central.

The subsequent ground-map revision returned HTTP 200 JPEG tiles for all three official USGS datasets at the hotel tile (`12/1548/1043`): Topo 24,972 bytes, ImageryOnly 24,890 bytes and ShadedReliefOnly 5,556 bytes. The decoded published responses were visually inspected: Champaign roads and labels, historical ground imagery and elevation relief respectively. These are actual source tiles, not browser test fixtures. [myradar-reference.md](myradar-reference.md) distinguishes the documented MyRadar behavior from the unviewed recording and records each source's limits.

The published integration revision (`4c1d0ad`) served the HTML, ground-map engine and new map controls with HTTP 200. Its hotel-detail Topo tile (`16/24777/16702`) also returned HTTP 200, JPEG, 15,289 bytes; visual inspection showed West Marketview Drive and North Moreland Boulevard. A 9:42 AM Central NWS recheck returned all seven resources live, with 14 extended periods, 156 hourly periods and zero active property alerts returned at that check. The KCMI observation was from 8:40 AM Central; forecast issue and observation times remain independently visible.

Both native-dashboard and map-interaction browser suites passed at 1440×1000 and 390×844 using intercepted local fixtures. They verify source-raster composition, all four backgrounds, viewport retention, anchored wheel/double-click/pinch zoom, actual-catalog loop filtering, speed, stale/missing states, bounded requests/cache and cancellation on native close. Rapid scrubbing is limited to two raster loads and one latest desired scan. API/route/launcher tests passed all 50 cases; the preview build and targeted lint also passed. Fixture tests establish behavior; the separate published checks above establish source availability.

The published NOAA WMS checks returned HTTP 200 for both capabilities documents, exact-time maps and official legends. KILX advertised `kilx_sr_bvel`, style `radar_velocity`, EPSG:3857, and a latest/default scan of November 19 at 9:39:21 AM Central: its 800×600 map was a validated 67,239-byte PNG and its legend 5,356 bytes. Precipitation type advertised `conus_pcpn_typ`, style `radar_precip_type`, with a 9:40 AM Central scan: its map was a validated 9,688-byte PNG and its legend 902 bytes. These published byte checks establish source availability; their binary images were not visually interpreted through the text-only deployment connector.

The final native-dashboard, ground-map and WMS browser suites all passed on desktop and mobile. WMS tests decoded the image and legend fixtures, checked exact advertised layer/style/latest-time selection and Central labels, verified composition and pan/background preservation, disabled reflectivity controls, visible stale and unavailable states, and cancellation on close. Six pans during an 800 ms delayed legend response produced one shared legend request. These runs intercepted all application APIs and WebSockets, used synthetic accounts and made no live database or push requests.
