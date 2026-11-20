# CMPRI Weather branch review

Open the [branch preview](https://cmpri-engineering-git-codex-weather-branc-c2aab5-hawkeye-hotels.vercel.app/engineering), sign in normally, and select **Operations → Weather**. The existing native DesktopWindow hosts the Weather iframe. This work stays on draft PR #55; main and production are not changed. The launcher, static review files and read-only weather transports are enabled only for preview/development.

## Observations and forecasts

The property remains fixed at **40.138080, −88.251416**, Residence Inn Champaign, 502 West Marketview Drive, verified from Marriott's property map. No device location is requested.

The view launches four independent foreground reads when Weather opens:

- `/api/weather-preview?part=observation` reads **Willard (KCMI)** directly, without waiting for point discovery, stations, forecasts, alerts or radar.
- `?part=history` reads raw KCMI reports since Central midnight, including a bounded 90-minute pre-midnight anchor for real report pairs that span midnight. It preserves report timestamps and null temperatures rather than inventing hourly observations.
- `?part=alerts` reads the official property-point alert collection independently, including applicable county/zone alerts without polygons.
- `?part=forecast` resolves NWS's canonical four-decimal property point, then reads extended, hourly and grid forecasts. It does not repeat the observation request.

The original no-part response remains compatible with the seven-resource verification response. Transports preserve the raw official payload, units, source and source timestamp. They have fixed NWS sources, deadlines, no upstream credentials or redirects, and production blocking.

Current Conditions renders immediately when its observation arrives. **As of** appears directly below the heading and uses KCMI's observation date and Central time, never the fetch time. Clock labels use 24-hour time for the existing verified Chief Engineer identity/layout rule, including its maint mapping; other users, including ordinary administrators, use 12-hour AM/PM. Reported wind chill or heat index supplies Feels Like. The condition icon, wind arrow/speed and reported gusts (G … MPH) sit inside the enlarged wheel; visibility is directly beneath the degree-only Fahrenheit value. The As of line names Willard (KCMI). Forecast gusts and the old notes/source lines are removed from Current Conditions. Missing values do not become zero or forecast substitutes.

Local condition SVGs and a compact wind-from compass remain. Temperature colors are now a **hard-coded, screenshot-based Fahrenheit palette**, independent of CMPRI's seasonal theme: cyan at and below 0°F, periwinkle around 15°F, magenta at 32°F, a reset to deep violet at 34°F, blue at 40–45°F, mint at 55°F, lime at 63°F, yellow at 80°F, orange at 85°F, red at 95°F and pink at 106°F. Intermediate colors interpolate between the fixed stops. This approximates the supplied screenshots; it is not claimed to reconstruct the reference app's undocumented formula. Numeric temperatures retain their actual value, including outside the color ramp, and missing values are not zero.

**Current Conditions and each daily forecast use a 24-hour Central-time temperature timeline.** Position around the dial represents the hour of the local day; color represents temperature. Current Conditions keeps the latest KCMI reading in the center, an outer forecast track and a distinct inner observed-history track. Its forecast markers are **F H/F L** and observed extrema are **O H/O L**; daily forecast rings and badges use **H/L**. Observed colors interpolate only between actual reports no more than 90 minutes apart. A real report pair can bridge midnight using the bounded anchor; null reports and longer gaps remain unknown. No report is fabricated at midnight.

Observed high/low values use only supplied reports since Central midnight, excluding the pre-midnight anchor. The earliest actual time wins a tied extreme, including when historical reports arrive after the latest observation. A later equal report does not move the marker. These are extrema of the supplied readings; missing reports may hide an earlier extreme. Forecast markers remain independent. Daily forecast high/low times use supplied hourly samples; an official period high/low can appear without an invented time when hourly guidance is unavailable. Missing forecast hours remain gaps and days beyond hourly coverage remain unknown; coverage is described in accessible labels and tooltips without notes below the wheels. Central calendar days account for 23/25-hour daylight-saving transitions.

Hourly Forecast retains horizontally scrolling cards, with a centered main condition icon and matching colored temperature dot/text beneath it. Available hourly gusts are labeled **Gusts … MPH/mph**, using the existing role formatting, without a redundant Forecast prefix or repeated bottom date/time. The separate temperature key and text below the section are removed; phone flick-scrolling uses native momentum. Daily cards use the same inside-wheel presentation, with forecast H/L values inside and the existing NWS Forecast Details accordion retained. Forecast validity, official text and snow/ice interval coverage remain available.

Closing Weather keeps its iframe mounted but hidden/inactive, preserving its decoded map images, view, layer choices, controls and rendered forecasts. Reopening uses the same document and RAM cache; reload/navigation or closing the browser discards it. No browser storage or database is added. All four response caches are memory-only, with a five-minute freshness window. Reopening Weather renders cached data immediately and refreshes only parts that are due. Failed reads preserve last-known data with stale/unknown status. The existing visible-map refresh can request due observation/history data; it adds no separate background timer, database call or scheduler.

## Map and observed playback

The regional default is actual **USGS/USDA aerial imagery**, overlaid with official USGS National Transportation Dataset roads and GNIS town names. Road-line PNGs omit provider-rendered shields. CMPRI places route shields on actual visible official route polylines, groups route class/number and scales the shield budget to zoom and visible map area. Major routes take priority at wide views; local highways appear where space permits. The property view prioritizes I-57 north and south of the hotel and I-74 to the east when those actual source segments are visible, while limiting other repeats. Labels avoid the hotel pin, towns, controls and one another. Place labels use official incorporated-place features and source coordinates, choose one point for a repeated name and omit colliding labels. Background road lines are geographic reference data, not reported winter road conditions.

The fixed `route-features` transport uses USGS transportation layer 8 (10M-scale) at tile zoom 7 or below, layer 9 (1M-scale) at zoom 8–9, and separate Interstate/US/State route layers 16/17/18 at zoom 10 or above. Very wide requests prioritize Interstates; zoom 8 adds US routes and zoom 9 adds state routes. Route numbers and WGS84 geometry remain official source attributes, including concurrent-route splits; no road coordinates or names are handwritten. Viewport bounds, a shared deadline, a combined response-size cap and incomplete-result rejection keep queries bounded.

Local sign artwork follows the [FHWA M1-1 Interstate design](https://mutcd.fhwa.dot.gov/kno-shs_2024-release-status/index.htm) and [IDOT's M1-I100 Illinois standard](https://public.powerdms.com/IDOT/documents/2608579). Interstate markers have the recognizable red INTERSTATE header, white border and blue shield; Illinois markers have a black inset rounded border, ILLINOIS header and white square body. M1-I100 does not use a geographic Illinois outline. These sanitized public-domain visual templates are standard-design map artwork, not verbatim official fabrication downloads. Actual route digits are drawn from the official USGS attributes.

State-specific artwork requires actual source jurisdiction: generalized `STFIPS`/`STATE` or detailed `stco_fipscode` identifies Illinois as 17/IL. Unknown or out-of-state jurisdiction is never inferred from a route number or the hotel's location. State-route grouping preserves jurisdiction so identically numbered routes across state lines do not inherit the Illinois sign.

USGS ImageryOnly supplies the only geographic background; the Gray, Roads and Terrain alternatives are removed. Highway lines and town labels remain geographic overlays. The aerial service's refresh date does not establish capture year at the hotel; capture year is labeled unavailable. The obsolete ImageryTopo endpoint is not used. Compact USGS/USDA credits remain visible. The hotel pin remains, without a permanent text label. Reference requests share the four-request USGS budget, are tied to the map extent and stop on close; tile caches are bounded and native tiles stop at zoom 16. Closer zoom explicitly enlarges existing detail.

The default observed radar is now **NOAA NCEP MRMS BREF QCD WMS**, using advertised layer `conus_bref_qcd` and style `radar_reflectivity` from [the official NCEP service](https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows). Frames use explicit observed instants advertised by its capabilities, never a guessed time grid. This replaces the processed RGBA ImageServer as the default reflectivity source so imagery and its legend come from the same verified product/style.

When available, the compact in-map legend uses NOAA's actual 500×30 PNG legend. Only its original top 10-pixel color band is displayed; source-verified printed dBZ ticks are reflowed for narrow screens. Their positions remain tied to the official image, including the inset first tick. The labels are not inferred from generic NWS colors, and −20 dBZ is not relabeled as the ramp's left-edge minimum. Provider failures remain unavailable; earlier successful source checks do not establish current availability.

Available observed scans can play while remaining frames load in the background; newly ready scans join automatically. The current image and actual scan time remain visible until a ready replacement is selected. Pause freezes the displayed scan and timestamp even when another download finishes. Per-frame scan-bar segments show ready, loading, pending and failed status without a radar loading/stale label or muting the entire control bar. Controls stay in place, and the scan-seek, opacity, speed and loop-length bars use vertical-bar thumbs. The visible timestamp belongs to the displayed image and uses Central time. There is no predicted radar, proprietary smoothing or invented scan time.

Radar caching protects the displayed bitmap and current loop coverage instead of closing the visible image during FIFO eviction. A cached raster remains georeferenced to its actual source extent while replacements load; it is not stretched into a different location. Available ground tiles likewise provide a georeferenced aerial fallback during viewport loading. Caches stay bounded and survive the hidden cached Weather window; closing, hiding or switching away still stops foreground requests and playback.

Wheel input scrolls the Weather view until the map is clicked. A click activates cursor-anchored wheel zoom; pointer leave resets activation. Pinch, double click, buttons, recenter and fullscreen remain. Opacity, playback speed and observation-loop duration are colocated sliders. Gridlines, manual-refresh controls, redundant map help and the old footer are removed.

A **five-minute foreground map refresh** updates published map products only while Weather's map is open and visible. Hiding the document, switching away from the map or closing Weather stops its timer and pending requests. This is separate from the simulated adaptive checker: it is not a server or background alert scheduler, and it causes no database work.

Verified observed layers, WSSI and property-alert geometry can be toggled independently and stacked on the same viewport. Only reported winter roads and forecast winter impacts are mutually exclusive. Reflectivity playback applies to its actual observed sequence; KILX velocity and precipitation type retain their own latest advertised WMS layers/styles, exact observation times and official PNG legends. WSSI is separate forecast impact guidance, with its issue/validity information. Official hotel-alert polygons remain optional; polygonless alerts remain listed. IDOT reported winter road conditions, embedded satellite and embedded lightning remain explicitly unavailable. Missing data never becomes a clear-road or all-clear claim.

## Guest Safety and ticker

All applicable official NWS alert categories create **in-app Guest Safety notifications**, regardless of preparation-example opt-ins. There is no delivery selector, phone setting, device permission, push or database write. Each message includes the official NWS summary/bulletin and the user's hazard-specific hotel action. Other hazards use the actual official bulletin action.

Applicable warnings and the agreed simulated forecast-freeze example automatically open the full-screen native Guest Safety dialog on desktop/mobile. Watches and advisories remain standard in-app notifications; opening their details uses the compact dialog. A dismissed unchanged warning batch does not reopen on a repeated result. Material changes have a new identity.

New warning batches can play the local `/previews/weather/warning-siren.mp3` clip through native Web Audio, armed only by a genuine Weather-launcher click. The clip comes solely from the user-uploaded `Recording 2026-11-20 011107.mp4`: the 0.50–12.22-second excerpt is 11.72 seconds long, with a 3.2-second soft attack and a fade from 7.2 seconds to the end. No video is committed and the sound is not an NWS data feed. Watches, advisories, unchanged repeats and reopening details do not retrigger it. Clear, dismissal, cancellation or downgrade fades/cancels playback. A browser-blocked attempt offers an explicit Enable warning sound retry; it never requests notification permission or sends a push.

Active watches/warnings appear in a clickable bulletin ticker outside Weather, directly below the desktop header across its full available width. It scrolls right to left at the revised faster pace, with yellow watches and red warnings, and shows the hazard and official expiration. Closing Guest Safety or the cached Weather window leaves the bulletin and inbox intact; clicking reopens details. Cancellations, expirations and earlier official end times remove inactive entries. Earlier ends control cleanup without rewriting official expires. Failed alert reads retain last-known notices with an unverified label; they cannot imply all-clear. The official alert section itself appears only while applicable alerts are active, with unknown status reported separately.

The preview bridge validates origin, source iframe and modal token. A portal places the bulletin in the desktop header host without moving other window content. All notification state is in memory. Display-only expiration timers remove expired UI; they never poll NWS or call a backend. The Weather iframe omits the Sources tab, orange review box and Guest Safety test control; inherited official in-app delivery remains active in the preview host.

**Clear notifications** clears the inbox presentation only; it does not cancel an active official hazard or remove its bulletin. Revisions for the same official alert ID reconcile their current state instead of leaving superseded warning entries active. Warning-to-watch changes retain the yellow watch while removing the red warning state.

## Simulations and checks

Year-round Weather Prep examples at 24/12 hours, the separate within-12-hour Winter Prep opt-in, sample messages, forecast freeze and adaptive checks remain explicitly **simulations**. The shared checker still demonstrates 5 minutes clear, 2 minutes during a watch/advisory and 1 minute during a warning, slowing again after cancellation/expiry. It compares cached state, models database work only for material alert state or notification work, and deduplicates unchanged messages. It runs no real scheduler, database transaction or push.

**Reset samples** and the shared-check Reset clear simulated notifications across their shared scope, including pending simulated sound, modal and ticker state. They preserve actual official alerts. These actions do not write a database or clear another user's records.

Applicable dashboard, DesktopWindow, notification and seasonal-theme patterns were reviewed. No applicable root/source AGENTS.md was present. The native host uses the shared palette; iframe content mirrors those colors. Preview preparation preferences are not persisted to profiles.

## Verification

The preview-mode production build, TypeScript, targeted ESLint and 102 focused Weather tests pass. All 12 desktop/mobile browser cases pass, including Chief Engineer and ordinary-administrator clocks, cache/retention, sign placement, notification colors/clearing and local warning sound. Published source checks are separate from browser fixtures: actual KCMI history and USGS route geometry were verified at local, regional and widest extents. The draft PR records final counts, the published commit and current feed availability.

Published source checks and browser acceptance are separate. Source checks record current independent KCMI/property-alert/forecast responses, NOAA reflectivity/legend availability and actual USGS transportation/GNIS responses, including failed or unavailable feeds. Product provenance and earlier successful responses are distinct from present availability. Browser acceptance uses the actual Engineering dashboard with synthetic accounts and explicit NWS/USGS fixtures, with application API and WebSocket traffic intercepted. It covers observation-first rendering, Central-time daily coverage/gaps, fixed temperature colors and revised Hourly layout, exact-time buffered playback, compact legend, click-activated wheel behavior, foreground refresh cleanup, and inherited Guest Safety/ticker behavior.

```sh
node --experimental-strip-types --test tests/weather*.test.mjs
VERCEL_ENV=preview NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
```

Browser checks ran against a fresh local preview server at `http://127.0.0.1:3032`:

```sh
python tests/browser/weather_current_notices.py --base http://127.0.0.1:3032
python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3032
python tests/browser/weather_map_basemaps.py --base http://127.0.0.1:3032
python tests/browser/weather_map_wms.py --base http://127.0.0.1:3032
```

The current/notices command exercises two suites. The final blocked-sound retry check runs the Notices suite separately against the rebuilt host at http://127.0.0.1:3033. Browser audio decoding was done with the real AudioContext suspended, with no output; notification playback behavior used mocks. The extracted MP3 decodes as 11.72 seconds, mono at 48 kHz, with peak amplitude 0.722 and first/last 100 ms RMS approximately 0.00290/0.00231. Published deployment checks are recorded in the draft PR. No device GPS, paid feed, API key, database write, notification permission or external push is introduced.
