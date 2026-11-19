# Weather: published NWS feeds in the CMPRI branch preview

The review entry is the actual CMPRI Engineering dashboard: **Operations → Weather**. It opens through the existing `DesktopWindow` / `DesktopFrame` system, with one native titlebar and the embedded Weather content. The launcher is enabled in Vercel preview builds and local development, and disabled in production builds. The preview HTML and read-only weather endpoints return 404 in production.

## Live NWS content first

Opening Weather now reads the actual official NOAA/NWS feeds. Sample temperatures, forecasts, radar echoes, road geometry and forecast-impact polygons have been removed from the Weather view. A failure displays unavailable / unknown; it never substitutes a simulated weather result or an all-clear.

The property is fixed at 40.138080, -88.251416, from the [Residence Inn Champaign Marriott map link](https://www.marriott.com/en-us/hotels/cmpri-residence-inn-champaign/overview/), 502 West Marketview Drive. No GPS or user-supplied location is requested.

`GET /api/weather-preview` is a preview-only read transport for `api.weather.gov`. It discovers the property's forecast, hourly forecast, forecast grid and observation stations from `/points`, then reads the nearest returned station's latest report. The property alert point query runs independently so failed forecast discovery cannot hide alerts. Original NWS response documents, official URLs, source timestamps, retrieval times and independent resource states are retained in the response and shown in the view. Applicable alerts without polygons remain included.

`GET /api/weather-preview/map?url=...` transports only allowlisted read resources on `mapservices.weather.noaa.gov`: the time-enabled MRMS radar catalog / exact raster exports, WSSI overall Days 1–3 layer 4, and generated NOAA PNGs. It rejects arbitrary hosts, credentials, redirects, unsupported operations and oversized responses. Observed scan labels come from actual catalog times and LockRaster IDs. WSSI guidance is separate from reported road surfaces, with issue / valid times, incomplete coverage and stale guidance labeled.

Both endpoints omit upstream credentials and have bounded requests. Neither imports CMPRI authentication, Supabase, notification dispatch, storage or scheduling code. Weather loads once on open or an explicit refresh, aborts pending requests on close, and stops map playback on close, hiding, or leaving the map tab. There is no real adaptive scheduler.

IDOT's official reported winter-road map is linked but its concrete feed and report timestamps remain unverified. The map therefore labels current road reports unavailable and draws no substitute road network or conditions. Local velocity, precipitation type, satellite and lightning retain official source links with their actual availability limitations.

## Review behavior retained

The existing compact layout is retained while the feed is verified. Hourly and extended forecasts use matching horizontal cards populated with official NWS periods and text. Observation values use source units with explicit conversions; null values remain unavailable. Snow and ice use only provided forecast-grid interval amounts and disclose partial coverage.

Notification and adaptive-check examples remain explicitly simulated, as requested. They do not interpret a simulated warning as a live NWS bulletin or send a real push. Watches and Weather Prep heads-ups stay regular simulated notifications; applicable warning and forecast walkway-icing examples can open the Guest Safety demonstration with the specified property instructions. The 24/12-hour year-round Weather Prep and separate within-12-hour Winter Prep examples remain available in the Notifications tab.

The virtual shared checker retains 5 / 2 / 1-minute modes, cached-result comparisons and delivery keys. It models database work only for material alert state changes or notification work; it performs no database activity.

## Verification

Unit tests validate fixed-source routing, independent failed-resource handling, raw response preservation, polygonless alerts, missing/stale data, production blocking, map URL restrictions, binary response limits and native dashboard launcher behavior. Browser fixture tests exercise the actual `/engineering` dashboard and native window on desktop/mobile without live accounts or database writes. Fixtures are implementation tests, not proof of live feed availability.

The draft PR records the separate published endpoint verification results. Successful endpoint envelopes and actual NOAA catalog/export responses are required before describing a feed as verified live. No production deployment or main branch is changed.

```sh
node --experimental-strip-types --test tests/weather-dashboard-launcher.test.mjs tests/weather-preview-api.test.mjs tests/weather-preview-map-api.test.mjs tests/weather-preview-routing.test.mjs tests/manual-preview.test.mjs
VERCEL_ENV=preview NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=ci-build-placeholder npm run build
VERCEL_ENV=preview npm run start -- --port 3018
python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3018 --output /tmp/cmpri-weather-dashboard-review
```

Reviewed guidelines remain the current Illinois / Iowa palette and native dashboard / DesktopWindow / profile notification patterns. No applicable root/source `AGENTS.md` is present; the only discovered AGENTS file is in an archived `.bridge` subdirectory.
