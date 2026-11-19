# CMPRI Weather branch review

Open the [branch preview](https://cmpri-engineering-git-codex-weather-branc-c2aab5-hawkeye-hotels.vercel.app/engineering), sign in normally, and select **Operations → Weather**. The existing native DesktopWindow hosts the Weather iframe. This work stays on draft PR #55; main and production are not changed. The launcher, static review files and read-only weather transports are enabled only for preview/development.

## Observations and forecasts

The property remains fixed at **40.138080, −88.251416**, Residence Inn Champaign, 502 West Marketview Drive, verified from Marriott's property map. No device location is requested.

The view launches three independent foreground reads on open or explicit refresh:

- `/api/weather-preview?part=observation` reads **Willard (KCMI)** directly, without waiting for point discovery, stations, forecasts, alerts or radar.
- `?part=alerts` reads the official property-point alert collection independently, including applicable county/zone alerts without polygons.
- `?part=forecast` resolves NWS's canonical four-decimal property point, then reads extended, hourly and grid forecasts. It does not repeat the observation request.

The original no-part response remains compatible with the seven-resource verification response. Transports preserve the raw official payload, units, source and source timestamp. They have fixed NWS sources, deadlines, no upstream credentials or redirects, and production blocking.

Current Conditions renders immediately when its observation arrives. **As of: YYYY-MM-DD HH:mm CST/CDT** appears directly below the heading and uses KCMI's observation timestamp, never the fetch time. Reported wind chill or heat index supplies Feels Like; absent values remain Not reported. Observed gusts are separately labeled from forecast gusts. The published KCMI check at 12:06 PM Central on November 19 returned 19°C with null wind chill, heat index and gust; the view does not turn those missing values into zero or substitute forecast data.

Local condition SVGs, a compact wind-from compass and the same air-temperature visual appear in Current Conditions, Hourly Forecast and Extended Forecast. All temperatures use one fixed Fahrenheit domain: −15 white, 0 purple, 15 dark blue, 32 light blue, 50 green, 70 yellow, 90 red and 110 brown. Numeric values remain readable on a dark background. The scale is actual air temperature, not a card-relative range or Feels Like. Both forecast sections use the same horizontally scrolling cards. Forecast validity, official text and snow/ice interval coverage remain available.

## Map and observed playback

The regional default is actual **USGS/USDA aerial imagery**, overlaid with official USGS National Transportation Dataset roads/shields and GNIS town names. Place labels use official incorporated-place features and source coordinates, choose one point for a repeated name and omit colliding labels. Background road lines are geographic reference data, not reported winter road conditions.

USGS ImageryOnly, Topo and ShadedReliefOnly supply the Map choices. The aerial service's refresh date does not establish capture year at the hotel; capture year is labeled unavailable. The obsolete ImageryTopo endpoint is not used. USGS public-domain credits remain visible. Reference requests share the four-request USGS budget, are tied to the map extent and stop on close; tile caches are bounded and native tiles stop at zoom 16. Closer zoom explicitly enlarges existing detail.

NOAA reflectivity uses actual catalog times and exact raster IDs. While playing, the next actual scan preloads and the current image remains visible until the next is ready. The playback controls mute while buffering; radar loading text and the radar stale label are removed as requested. The visible timestamp always belongs to the displayed image and uses Central time. Playback stops when the view is hidden or closed. There is no predicted radar or invented scan time.

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

Published checks verified the independent KCMI, property-alert and forecast responses. Official transportation PNGs and GNIS metadata/feature responses were fetched through the deployed transports. Tests separately exercise API source restrictions/production gates, exact hazard actions, cancellation references, deduplication, raw values/units and expiration behavior.

Browser acceptance uses the actual Engineering dashboard with synthetic accounts and explicit NWS/USGS fixtures, with application API and WebSocket traffic intercepted. It verifies observation-first rendering, 24-hour Central time, available and missing chill/gust values, the shared temperature scale, icons, default aerial/reference composition, buffered scan timing, all-in-app delivery and native Guest Safety/ticker behavior. Fixture tests establish UI behavior; published source checks establish feed availability.

```sh
node --experimental-strip-types --test tests/weather*.test.mjs
VERCEL_ENV=preview NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
VERCEL_ENV=preview npm run start -- --hostname 127.0.0.1 --port 3022
python tests/browser/weather_current_notices.py --base http://127.0.0.1:3022
python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3022
python tests/browser/weather_map_basemaps.py --base http://127.0.0.1:3022
python tests/browser/weather_map_wms.py --base http://127.0.0.1:3022
```

Final verification passed at **1440×1000 desktop and 390×844 mobile**. The production-mode preview build, TypeScript, targeted lint and all **62 Weather tests** passed. The four browser suites passed, including available/zero/missing chill and gust values, observation-first rendering, actual-time buffered playback, aerial/reference composition, native full-screen and standard notices, titlebar ticker geometry/motion/lifecycle, cancellation ordering and early ends with the official expiration preserved. The full-screen dialog suppresses CMPRI's injected floating shortcut only inside this preview-specific safety dialog.

Actual published GNIS verification returned 51 MultiPoint features for the reviewed regional extent. Rendering that exact payload in browser acceptance produced 49 normalized unique town names, with no duplicate rendered names or town-to-town overlaps; Champaign, Urbana and Savoy remained visible on desktop and mobile. The ground/radar rasters in that compatibility run were explicit fixtures. Actual source PNGs and feature coordinates were verified separately.
