# Weather branch preview

The compact Weather review is an isolated static surface at:

`/previews/cmpri-weather-preview.html?weather=open`

It preserves CMPRI's Illinois / Iowa colors, Operations launcher vocabulary, window titlebar, dark controls and mobile layout. It does not import the application shell, start an authenticated session, or access CMPRI APIs, Supabase, service workers, real notifications or background jobs. A production routing gate returns 404 for the entire `/previews` namespace, including its assets. Preview responses use `no-store` and `noindex, nofollow`.

## Scope

Current conditions, official alert status and Guest Safety sit above the map. Hourly and extended forecasts use the same horizontal card component, scroll area, previous/next controls and touch behavior. Forecast, observation-layout and notification examples are marked simulated. Missing values remain unavailable rather than zero. Official alert status is unknown; the simulated warning state never becomes a claim about live NWS warnings.

The hotel is fixed at 40.138080, -88.251416, from the [official Marriott hotel's View Map link](https://www.marriott.com/en-us/hotels/cmpri-residence-inn-champaign/overview/), at 502 West Marketview Drive. No device geolocation is used. Dates and scan labels use `America/Chicago`, with CST/CDT derived from the actual timestamp.

## Map layers and controls

The embedded component is a CMPRI-authored canvas, not a third-party radar app. Its pan, zoom, recenter, fullscreen and scan controls are distinguished from CMPRI's layer and feed-loading controls. The **Sources & limits** tab contains a control-by-control table with owner, official source, exact effect and current-session exercise status (27 entries, including disclosures and source links).

Radar, reported Illinois winter roads and forecast winter travel impacts are separate independently selectable layers on the same map. The default generated examples are explicitly simulated. Schematic road lines are not an actual road network or IDOT report. Simulated impact areas are not official WSSI polygons. Optional live mode clears sample graphics and retains unavailable labels until valid data is loaded.

| Layer | Official source | Verified limit |
| --- | --- | --- |
| Observed regional reflectivity | [NOAA time-enabled MRMS ImageServer](https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer) | Metadata and time/object-ID fields verified. Exact NOAA catalog records and raster images are required for any observed loop; default loop is simulated. |
| Reported Illinois winter roads | [IDOT Getting Around Illinois](https://www.gettingaroundillinois.com/WinterConditions/index.html) and its [official ArcGIS app](https://idot.maps.arcgis.com/apps/webappviewer/index.html?id=aecf2a45940444d3b3cf206da9af803c) | Official app verified. Underlying service, timestamp fields and browser access could not be verified. No guessed service URL or current road condition is used. Maintained-highway reports are not complete local-street coverage. |
| Forecast winter travel impacts | [NWS Central Illinois WSSI](https://www.weather.gov/ilx/wssi) and [WPC WSSI service](https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer) | Overall-impact layer 4, categories, issue and valid-time fields verified. Regional forecast guidance is not a road report, official warning, or assurance that a particular road is safe. |
| Local velocity, precipitation type, satellite and lightning | Official NOAA source links in the preview | Unavailable in this review. Reflectivity is not reclassified into precipitation type; no strike counts are fabricated. |

Live attempts occur only after Weather opens and the reviewer explicitly selects **Try official map feeds**. Only allowlisted NOAA hosts can be contacted. Closing the view stops playback, cancels drawing and aborts pending requests. There is no adaptive live polling or scheduler. Fetch failures and stale or incomplete products remain unavailable / stale rather than all-clear.

## Notifications and Guest Safety

All preferences, messages, cached comparisons and delivery keys are in memory. Phone registration and notification permission are never requested.

Year-round **Weather Prep** examples at 24 and 12 hours require fresh, applicable forecast guidance. Examples cover snow, freezing rain, thunderstorms, heat and wind. A separate opt-in **Winter Prep** heads-up remains available for snow or freezing rain within 12 hours without an NWS advisory. Missing, stale, expired or inapplicable guidance is suppressed. Official watches, advisories and preparation heads-ups use regular simulated notifications.

Applicable warning samples and a forecast walkway-icing sample can auto-open the simulated **Guest Safety** dialog. The walkway-icing example is distinct from an agricultural NWS Freeze Warning, which does not establish ice on guest walkways.

- Tornado: “Staff and guests go to the first-floor interior hallways, away from windows and exterior doors.”
- Severe thunderstorm: “Staff and guests stay indoors and away from windows.”
- Freeze alert: “Check guest walkways for ice. Ice melt is in the boiler room. Available staff, including front desk and housemen, can treat sidewalks as needed.”

Identical event/version/recipient keys do not add another message or reopen a dismissed dialog. A material update can produce a new version. There are no real pushes.

## Shared property checks

The click-driven virtual clock demonstrates Clear → Watch → Warning → Clear at 5 → 2 → 1 → 5 minutes. The most urgent active alert wins. Canceling or expiring a warning while a watch remains returns to 2 minutes; clearing the remaining alert returns to 5 minutes.

Each virtual tick increments one simulated NWS request. An unchanged cached result creates zero simulated database transactions and zero duplicate pushes. New or materially changed alerts, cancellation, expiry or new eligible notification work create simulated transactions. One transaction represents the changed alert and associated outbox/delivery key together. No per-user polling is introduced.

## Guidelines and differences

Reviewed applicable guidance and source patterns:

- `docs/seasonal-theme-updates.md`, `docs/preview-production-parity.md`
- `src/lib/ui/site-palette.json`, `src/app/globals.css`, `src/app/modal-theme.css`
- `src/app/engineering/page.tsx`, `src/components/desktop/DesktopWindow.tsx`
- `src/app/profile/page.tsx`, `src/components/PhoneNotificationRow.tsx`

No applicable root or source `AGENTS.md` is present. The discovered AGENTS file lives only in an archived `.bridge/old shit` directory. Native palette imports, persistent multiwindow positioning, the seasonal stadium, authenticated role rules, saved notification schedules and installed-device behavior cannot be reproduced by this isolated preview. These differences are also listed in the review UI.

## Reproduce verification

```sh
npm ci
node --experimental-strip-types --test tests/weather-preview-routing.test.mjs tests/manual-preview.test.mjs
npm run lint
npm run typecheck
NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
python tests/browser/weather_preview.py
```

The browser script uses a local static server by default and requires Python Playwright plus Chromium. It can instead receive the running Next preview URL. It writes screenshots and a JSON verification report under `/tmp/cmpri-weather-review`, never to application storage. The Next production guard is additionally verified against a locally started server with `VERCEL_ENV=production`; no hosted production deployment is needed or changed.

## Verification evidence for this draft

- Full repository test suite, HTTP smoke, build, TypeScript and ESLint passed using synthetic public build configuration; no environment secrets were pulled.
- Routing regression + existing read-only guard tests: 12 passed.
- Browser review harness: 39 passed at 1440×1000, 390×844 and 320×740, including both forecast-strip arrows and native mobile touch scrolling.
- Actual Next static boundary: HTML and JS return 200 with no-store/noindex in preview mode and 404 in a local production-environment server.
- Default browser scenarios made no external requests. Controlled failure tests exercise unavailable states and are not proof of live-feed availability.
- Actual NOAA attempts from this environment failed, so no live radar scan, current observation, forecast or property alert is claimed verified. IDOT live reports remain unavailable. WSSI live response handling is implemented with explicit missing/stale labels.
- Fixtures verify successful NOAA catalog/raster and WSSI rendering semantics separately; fixture results are implementation checks, not live weather.

Screenshot and JSON evidence is generated under `/tmp/cmpri-weather-review` by the browser script. Test reports and screenshots contain no application credentials or session state.

Persistent browser regressions additionally cover hidden radar stopping playback / requests, repeated material updates preserving opaque source versions, and cached WSSI guidance becoming stale on reopen without fetching again.
