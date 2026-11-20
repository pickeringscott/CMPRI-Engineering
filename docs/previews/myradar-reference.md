# MyRadar reference and CMPRI ground maps

Reference review began November 19, 2026; implementation notes below reflect the current revision. This revision uses MyRadar as an interaction reference for the existing CMPRI preview branch. It does not embed MyRadar or use its API, map tiles, proprietary radar processing, or paid features.

## What was reviewed

The user supplied a MyRadar screen recording. Its metadata was readable, but the approximately 45 MB Drive download was blocked. The uploaded MP4 also exceeds the workspace's 32 MiB transfer limit. **The recording has not been watched.** The descriptions below come from primary MyRadar documentation, not observations of that recording.

MyRadar distinguishes a **Map Type**, the ground background, from **Radar Type** and other weather overlays. Its [current FAQ](https://acmeaom.freshdesk.com/support/solutions/articles/44002780015-frequently-asked-questions) lists seven map types: Gray, Roads, Aerial, Topography, Pro Dark, Pro Light, and Daylight. The older [Map Type guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261773-map-type) describes Gray as the default, with Roads and Aerial alternatives. These pages reflect different app versions; they do not establish exactly which options appear in the user's recording.

The separate [Radar Type guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261737-radar-type) documents Classic, Hi-Def, Heat/Temperature, and Per-Station products. Another [official article refers to four radar thumbnails](https://acmeaom.freshdesk.com/support/solutions/articles/44001822597-what-s-the-difference-between-the-radar-types-). Consequently, the user's recollection of four choices must not be presented as verified evidence of four MyRadar basemaps.

## Verified reference behavior and limits

The [main toolbar guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261763-main-toolbar) separates the background-map selector from the Layers menu. The radar guide documents opacity, playback speed, scan interval, and loop duration controls. The [warnings guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261738-warnings-and-watches) describes selectable alert shapes and separate watch/warning visibility and opacity. The [forecast guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261753-forecast) describes a compact forecast bar that expands to current conditions, hourly details, and an extended forecast.

These are useful behavior references for CMPRI's map selector, independent weather overlays, shared pan/zoom viewport, legend, timeline, and forecast panels. MyRadar's forecast can follow the map's center, whereas this CMPRI preview retains the verified hotel as its forecast and alert location when the map is panned. Recenter returns to the hotel; it does not locate the device.

The [official upgrade list](https://acmeaom.freshdesk.com/support/solutions/articles/44001261755-upgrades-available-for-ios) identifies Per-Station Radar, Historical Radar, hurricanes, the CONUS-wide Road Weather toggle, and RouteCast as Premium Features; aviation charts use a separate subscription. The current documentation does not establish a complete free/paid entitlement table for every basemap style. In particular, a name containing “Pro” alone is not sufficient evidence of its subscription requirement.

The [MyRadar embedding documentation](https://myradar.com/apidocs/embed-a-weather-map/) requires a MyRadar API key. CMPRI does not use that embed. MyRadar's Hi-Def smoothing/morphing and precipitation models are not equivalent to a direct NOAA observed composite. CMPRI's default observed radar now uses NOAA NCEP MRMS BREF QCD WMS, layer `conus_bref_qcd` and advertised style `radar_reflectivity`, with explicit observed instants and the actual displayed Central scan time retained. Its matching official legend is described below. Playback uses a muted bar for buffering, with no radar loading/stale label. No proprietary HD, predicted radar, storm tracking, or paid road-weather capability is implied by adopting similar controls.

## Chosen CMPRI ground-map choices

The four CMPRI choices below are implementation choices for this revision. **They are not claimed to be the exact four choices the user recalls.** They provide actual geographic context beneath the NOAA/NWS weather overlays.

| CMPRI choice | Ground data and presentation | Official service |
| --- | --- | --- |
| Gray | USGS Topo tiles with a local grayscale presentation for weather contrast; not a separate MyRadar map service | [USGSTopo](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer) |
| Roads | USGS Topo's roads, place names, boundaries, hydrography, and other reference features; this is a topographic reference map, not a dedicated traffic or road-condition feed | [USGSTopo](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer) |
| Aerial | USGS/USDA orthoimagery of the ground | [USGSImageryOnly](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer) |
| Terrain | USGS elevation-derived shaded relief; labels and road detail are not guaranteed by this backdrop | [USGSShadedReliefOnly](https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer) |

The current CMPRI default is **Aerial at regional zoom**, with official USGS transportation roads and GNIS incorporated-place town labels above it, with fewer route shields. GNIS labels use actual source names and one actual Point/MultiPoint coordinate per town, with deduplication and collision decluttering. This geographic reference overlay is separate from reported winter road conditions. Its source can refresh without establishing the aerial imagery's acquisition year; capture year at the hotel remains unavailable. Credits are compact, and the hotel pin has no permanent text label.

The [USGS basemap overview](https://www.usgs.gov/faqs/what-are-base-map-services-or-urls-used-national-map) describes the underlying products. The [current service directory](https://basemap.nationalmap.gov/arcgis/rest/services?f=pjson) and individual service metadata were checked. They expose cached, 256×256-pixel Web Mercator tiles using:

```text
https://basemap.nationalmap.gov/arcgis/rest/services/{service}/MapServer/tile/{z}/{y}/{x}
```

Tile addressing is row before column (`y/x`), unlike some other tile URL conventions. A basemap switch changes the ground presentation while preserving the shared viewport, hotel pin, and independently selected weather overlays. A basemap does not report precipitation or road safety.

Use native tile levels through **zoom 16**, consistent with the services' documented maximum display scale of approximately 1:9,028. Their metadata also contains higher LOD entries; the presence of those entries is not proof of additional native detail. If the interface permits closer zoom, overzoom already available tiles instead of claiming greater source resolution or requesting unsupported native levels. Show unavailable coverage honestly. USGS sources cover the United States and territories with product-specific detail; worldwide display does not imply uniform local road or aerial coverage.

The aerial metadata describes historical NAIP imagery, including CONUS source years 2017–2021, and a service refresh credit of June 2024. A service refresh is not the capture date of every image. **Aerial is historical ground imagery, not live weather satellite imagery.** GOES cloud imagery, when supported, remains a separate NOAA weather overlay. The Topo attribution declares a September 4, 2026 service refresh; this likewise does not date every individual road or feature.

### Source catalog correction

Some older USGS help/catalog pages still list `USGSImageryTopo`. Its REST metadata returned a service-not-found **404** during this review, and the current service directory omits it. Do not use that obsolete endpoint or describe it as a verified working alternative. The selected aerial endpoint is `USGSImageryOnly`.

## Cost, attribution, and retained constraints

USGS explicitly states that [National Map services and data are free and public domain](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map). These public services require no paid feed or API key. Keep visible attribution with the map, including USGS National Map and USDA where aerial imagery is used, and preserve applicable service credits. USGS requests this acknowledgment:

> Map services and data available from U.S. Geological Survey, National Geospatial Program.

Ground-map requests remain bounded to the current viewport and stop with the Weather view. Map click activates wheel zoom and pointer leave resets it; three sliders group opacity, playback speed and loop duration. Gridlines, manual-refresh controls, redundant help and the old footer are removed. A five-minute refresh runs only while the map is open and visible, stopping on hide/tab change/close; it is a foreground display refresh, not the adaptive background scheduler. No device GPS, user tracking, MyRadar account, API key, Supabase activity, notification permission, real push delivery, or background scheduler is introduced. Existing live NWS forecasts, observations, applicable point alerts—including alerts without polygons—and their provenance remain in place. Weather Prep and adaptive-check demonstrations remain explicitly simulated. Actual official point alerts now create local in-app Guest Safety notices; no device push or database work is added.

The existing Local velocity and Precipitation type buttons use verified free NOAA WMS products rather than MyRadar's proprietary products. Both official capabilities documents, exact-time PNG maps and legends succeeded through the published preview transport. These latest observed views retain their actual scan times and geographic extents. Regional reflectivity uses the observed time dimension of the verified NCEP BREF QCD WMS; selecting another product must not imply that NOAA supplied a corresponding loop or MyRadar smoothing.

## Screenshot temperature reference and 24-hour timelines

The supplied temperature screenshots are a separate visual reference from the unviewed MyRadar recording. CMPRI's current temperature colors are hard-coded in Fahrenheit and independent of the theme: cyan at/below 0°F, periwinkle around 15°F, magenta at 32°F, a reset to deep violet at 34°F, blue at 40–45°F, mint at 55°F, lime at 63°F, yellow at 80°F, orange at 85°F, red at 95°F and pink at 106°F. These are screenshot-based approximations, not an assertion about the reference app's exact formula. The numeric value is never clamped to the ramp or replaced with zero when unknown.

Current Conditions and every daily forecast now use a 24-hour Central-time forecast-temperature dial. Hour position is chronological and color encodes the actual hourly forecast temperature. High/low markers use only supplied hourly samples. Missing hours are gaps, partial coverage is labeled, and later days without hourly guidance remain unknown. Current Conditions keeps its observed KCMI value separate from the forecast ring. Daylight-saving clock changes do not silently manufacture or discard forecast hours. Hourly Forecast keeps its existing card layout and values, using the same color palette.

## Matching radar legend

The previous processed RGBA ImageServer does not supply a usable authoritative dBZ palette through its generic RGB legend. The default radar therefore moved to the [official NCEP MRMS BREF QCD WMS](https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows), with advertised `conus_bref_qcd` / `radar_reflectivity` imagery and legend. This makes the compact legend refer to the product actually rendered, rather than borrowing unrelated NWS colors.

The in-map color ramp is the unchanged top 10-pixel band of NOAA's actual 500×30 PNG. Printed dBZ tick labels are reflowed at source-verified positions for mobile readability; the first tick remains inset and is not claimed to be the ramp's minimum. No rainfall-rate conversion or precipitation classification is inferred from those colors.

## Validation status

- **Primary reference evidence:** MyRadar's map/product distinction and documented controls, explicitly listed subscription features, USGS service descriptions/projection/terms, and official NCEP MRMS service provenance.
- **Not verified:** playback or exact menu contents of the supplied Drive recording. No video-derived behavior or exact four-option match is claimed.
- **Source and acceptance checks are distinct:** actual official capabilities, imagery, legends and geographic responses establish source availability; intercepted browser fixtures establish interaction behavior.
- **Current revision acceptance:** 68 focused Weather tests, the preview build/TypeScript and targeted lint passed. All five browser suites passed at desktop 1440×1000 and mobile 390×844. The actual NOAA legend PNG was inspected at both sizes separately from the fixture map. Published deployment checks are recorded in the draft PR.

For the native dashboard entry, live NWS transports, safety behavior and current verification instructions, see [weather-review.md](weather-review.md).
