# CMPRI Weather branch review

Open the [branch preview](https://cmpri-engineering-git-codex-weather-branc-c2aab5-hawkeye-hotels.vercel.app/engineering), sign in normally, and select **Operations → Weather**. The existing native DesktopWindow hosts the Weather iframe. This work stays on draft PR #55; main and production are not changed. The launcher, static review files and read-only weather transports are enabled only for preview/development.

## Observations and forecasts

The property remains fixed at **40.138080, −88.251416**, Residence Inn Champaign, 502 West Marketview Drive, verified from Marriott's property map. No device location is requested.

The view launches three independent foreground reads when Weather opens:

- `/api/weather-preview?part=observation` reads **Willard (KCMI)** directly, without waiting for point discovery, stations, forecasts, alerts or radar.
- `?part=alerts` reads the official property-point alert collection independently, including applicable county/zone alerts without polygons.
- `?part=forecast` resolves NWS's canonical four-decimal property point, then reads extended, hourly and grid forecasts. It does not repeat the observation request.

The original no-part response remains compatible with the seven-resource verification response. Transports preserve the raw official payload, units, source and source timestamp. They have fixed NWS sources, deadlines, no upstream credentials or redirects, and production blocking.

Current Conditions renders immediately when its observation arrives. **As of: YYYY-MM-DD HH:mm CST/CDT** appears directly below the heading and uses KCMI's observation timestamp, never the fetch time. Reported wind chill or heat index supplies Feels Like; absent values remain Not reported. Observed gusts are separately labeled from forecast gusts. The published KCMI check at 12:06 PM Central on November 19 returned 19°C with null wind chill, heat index and gust; the view does not turn those missing values into zero or substitute forecast data.

Local condition SVGs and a compact wind-from compass remain. Temperature colors are now a **hard-coded, screenshot-based Fahrenheit palette**, independent of CMPRI's seasonal theme: cyan at and below 0°F, periwinkle around 15°F, magenta at 32°F, a reset to deep violet at 34°F, blue at 40–45°F, mint at 55°F, lime at 63°F, yellow at 80°F, orange at 85°F, red at 95°F and pink at 106°F. Intermediate colors interpolate between the fixed stops. This approximates the supplied screenshots; it is not claimed to reconstruct the reference app's undocumented formula. Numeric temperatures retain their actual value, including outside the color ramp, and missing values are not zero.

**Current Conditions and each daily forecast use a 24-hour Central-time temperature timeline.** Position around the dial represents the hour of the local day; color represents that hour's actual NWS forecast air temperature. Current Conditions keeps KCMI's observed reading in the center, separate from the forecast ring. High/low markers and their times come only from supplied hourly forecast samples. Missing hours remain gaps, partial days are labeled, and days beyond hourly coverage remain unknown rather than receiving an invented curve. Central calendar-day handling also accounts for 23/25-hour daylight-saving transitions.

Hourly Forecast keeps its existing card layout and values, with the same screenshot-based colors. Forecast validity, official text and snow/ice interval coverage remain available.

## Map and observed playback

The regional default is actual **USGS/USDA aerial imagery**, overlaid with official USGS National Transportation Dataset roads and GNIS town names. Route shields are reduced to keep the view compact. Place labels use official incorporated-place features and source coordinates, choose one point for a repeated name and omit colliding labels. Background road lines are geographic reference data, not reported winter road conditions.

USGS ImageryOnly, Topo and ShadedReliefOnly supply the Map choices. The aerial service's refresh date does not establish capture year at the hotel; capture year is labeled unavailable. The obsolete ImageryTopo endpoint is not used. Compact USGS/USDA credits remain visible. The hotel pin remains, without a permanent text label. Reference requests share the four-request USGS budget, are tied to the map extent and stop on close; tile caches are bounded and native tiles stop at zoom 16. Closer zoom explicitly enlarges existing detail.

The default observed radar is now **NOAA NCEP MRMS BREF QCD WMS**, using advertised layer `conus_bref_qcd` and style `radar_reflectivity` from [the official NCEP service](https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows). Frames use explicit observed instants advertised by its capabilities, never a guessed time grid. This replaces the processed RGBA ImageServer as the default reflectivity source so imagery and its legend come from the same verified product/style.

The compact in-map legend uses NOAA's actual 500×30 PNG legend. Only its original top 10-pixel color band is displayed; source-verified printed dBZ ticks are reflowed for narrow screens. Their positions remain tied to the official image, including the inset first tick. The labels are not inferred from generic NWS colors, and −20 dBZ is not relabeled as the ramp's left-edge minimum.

While playing, the next actual scan preloads and the current image remains visible until the next is ready. The playback controls mute while buffering; no radar loading or stale label is added. The visible timestamp belongs to the displayed image and uses Central time. There is no predicted radar, proprietary smoothing or invented scan time.

Wheel input scrolls the Weather view until the map is clicked. A click activates cursor-anchored wheel zoom; pointer leave resets activation. Pinch, double click, buttons, recenter and fullscreen remain. Opacity, playback speed and observation-loop duration are colocated sliders. Gridlines, manual-refresh controls, redundant map help and the old footer are removed.

A **five-minute foreground map refresh** updates published map products only while Weather's map is open and visible. Hiding the document, switching away from the map or closing Weather stops its timer and pending requests. This is separate from the simulated adaptive checker: it is not a server or background alert scheduler, and it causes no database work.

KILX velocity and precipitation type retain their verified advertised WMS layers/styles, exact observation times and official PNG legends. These latest observed products disable reflectivity-only playback controls. WSSI is separate forecast impact guidance, with its issue/validity information. Official hotel-alert polygons remain optional; polygonless alerts remain listed. IDOT reported winter road conditions, embedded satellite and embedded lightning remain unavailable and link to their official sources. Missing data never becomes a clear-road or all-clear claim.

## Guest Safety and ticker

All applicable official NWS alert categories create **in-app Guest Safety notifications**, regardless of preparation-example opt-ins. There is no delivery selector, phone setting, device permission, push or database write. Each message includes the official NWS summary/bulletin and the user's hazard-specific hotel action. Other hazards use the actual official bulletin action.

Applicable warnings and the agreed simulated forecast-freeze example automatically open the full-screen native Guest Safety dialog on desktop/mobile. Watches and advisories remain standard in-app notifications; opening their details uses the compact dialog. A dismissed unchanged warning batch does not reopen on a repeated result. Material changes have a new identity.

Active watches/warnings appear in a clickable ticker directly after the native Weather titlebar, flush to its lower edge and following its width during resize. It moves left to right, yellow for watches and red for warnings, and shows the hazard and official expiration. Closing Guest Safety leaves the ticker and inbox intact; clicking reopens details. Cancellations, expirations and earlier official end times remove inactive entries. Earlier ends control cleanup without rewriting official expires. Failed alert reads retain last-known notices with an unverified label; they cannot imply all-clear. The official alert section itself appears only while applicable alerts are active, with unknown status reported separately.

The preview bridge validates origin, source iframe and modal token. The optional titlebar slot is unused by other windows. All notification state is in memory. Display-only expiration timers remove expired UI; they never poll NWS or call a backend.

## Simulations and checks

Year-round Weather Prep examples at 24/12 hours, the separate within-12-hour Winter Prep opt-in, sample messages, forecast freeze and adaptive checks remain explicitly **simulations**. The shared checker still demonstrates 5 minutes clear, 2 minutes during a watch/advisory and 1 minute during a warning, slowing again after cancellation/expiry. It compares cached state, models database work only for material alert state or notification work, and deduplicates unchanged messages. It runs no real scheduler, database transaction or push.

Applicable dashboard, DesktopWindow, notification and seasonal-theme patterns were reviewed. No applicable root/source AGENTS.md was present. The native host uses the shared palette; iframe content mirrors those colors. Preview preparation preferences are not persisted to profiles.

## Verification

The preview-mode production build, TypeScript, targeted ESLint and all **68 focused Weather tests** passed. All five browser suites passed at **1440×1000 desktop and 390×844 mobile** (10 cases). The actual downloaded NOAA legend PNG was also rendered and inspected at both sizes, separately from the synthetic weather and geographic fixtures.

Published source checks and browser acceptance are separate. The source checks verify independent KCMI/property-alert/forecast responses, NOAA's advertised reflectivity instants/style and matching legend, and actual USGS transportation/GNIS responses. Browser acceptance uses the actual Engineering dashboard with synthetic accounts and explicit NWS/USGS fixtures, with application API and WebSocket traffic intercepted. It covers observation-first rendering, Central-time daily coverage/gaps, fixed temperature colors with unchanged Hourly layout, exact-time buffered playback, compact legend, click-activated wheel behavior, foreground refresh cleanup, and inherited Guest Safety/ticker behavior.

```sh
node --experimental-strip-types --test tests/weather*.test.mjs
VERCEL_ENV=preview NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
```

Browser checks ran against a fresh local preview server at `http://127.0.0.1:3030`:

```sh
python tests/browser/weather_current_notices.py --base http://127.0.0.1:3030
python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3030
python tests/browser/weather_map_basemaps.py --base http://127.0.0.1:3030
python tests/browser/weather_map_wms.py --base http://127.0.0.1:3030
```

The current/notices command exercises two suites. Published deployment checks are recorded in the draft PR. No device GPS, paid feed, API key, database write, notification permission or external push is introduced.
