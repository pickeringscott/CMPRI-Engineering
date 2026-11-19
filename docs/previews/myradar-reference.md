# MyRadar reference and CMPRI ground maps

Reviewed November 19, 2026. This revision uses MyRadar as an interaction reference for the existing CMPRI preview branch. It does not embed MyRadar or use its API, map tiles, proprietary radar processing, or paid features.

## What was reviewed

The user supplied a MyRadar screen recording. Its metadata was readable, but the approximately 45 MB Drive download was blocked. The uploaded MP4 also exceeds the workspace's 32 MiB transfer limit. **The recording has not been watched.** The descriptions below come from primary MyRadar documentation, not observations of that recording.

MyRadar distinguishes a **Map Type**, the ground background, from **Radar Type** and other weather overlays. Its [current FAQ](https://acmeaom.freshdesk.com/support/solutions/articles/44002780015-frequently-asked-questions) lists seven map types: Gray, Roads, Aerial, Topography, Pro Dark, Pro Light, and Daylight. The older [Map Type guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261773-map-type) describes Gray as the default, with Roads and Aerial alternatives. These pages reflect different app versions; they do not establish exactly which options appear in the user's recording.

The separate [Radar Type guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261737-radar-type) documents Classic, Hi-Def, Heat/Temperature, and Per-Station products. Another [official article refers to four radar thumbnails](https://acmeaom.freshdesk.com/support/solutions/articles/44001822597-what-s-the-difference-between-the-radar-types-). Consequently, the user's recollection of four choices must not be presented as verified evidence of four MyRadar basemaps.

## Verified reference behavior and limits

The [main toolbar guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261763-main-toolbar) separates the background-map selector from the Layers menu. The radar guide documents opacity, playback speed, scan interval, and loop duration controls. The [warnings guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261738-warnings-and-watches) describes selectable alert shapes and separate watch/warning visibility and opacity. The [forecast guide](https://acmeaom.freshdesk.com/support/solutions/articles/44001261753-forecast) describes a compact forecast bar that expands to current conditions, hourly details, and an extended forecast.

These are useful behavior references for CMPRI's map selector, independent weather overlays, shared pan/zoom viewport, legend, timeline, and forecast panels. MyRadar's forecast can follow the map's center, whereas this CMPRI preview retains the verified hotel as its forecast and alert location when the map is panned. Recenter returns to the hotel; it does not locate the device.

The [official upgrade list](https://acmeaom.freshdesk.com/support/solutions/articles/44001261755-upgrades-available-for-ios) identifies Per-Station Radar, Historical Radar, hurricanes, the CONUS-wide Road Weather toggle, and RouteCast as Premium Features; aviation charts use a separate subscription. The current documentation does not establish a complete free/paid entitlement table for every basemap style. In particular, a name containing “Pro” alone is not sufficient evidence of its subscription requirement.

The [MyRadar embedding documentation](https://myradar.com/apidocs/embed-a-weather-map/) requires a MyRadar API key. CMPRI does not use that embed. MyRadar's Hi-Def smoothing/morphing and precipitation models are not equivalent to a direct NOAA observed composite. CMPRI's observed radar must continue to use NOAA catalog valid times and exact raster IDs, with unavailable scans and stale data labeled. No proprietary HD, predicted radar, storm tracking, or paid road-weather capability is implied by adopting similar controls.

## Chosen CMPRI ground-map choices

The four CMPRI choices below are implementation choices for this revision. **They are not claimed to be the exact four choices the user recalls.** They provide actual geographic context beneath the NOAA/NWS weather overlays.

| CMPRI choice | Ground data and presentation | Official service |
| --- | --- | --- |
| Gray | USGS Topo tiles with a local grayscale presentation for weather contrast; not a separate MyRadar map service | [USGSTopo](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer) |
| Roads | USGS Topo's roads, place names, boundaries, hydrography, and other reference features; this is a topographic reference map, not a dedicated traffic or road-condition feed | [USGSTopo](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer) |
| Aerial | USGS/USDA orthoimagery of the ground | [USGSImageryOnly](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer) |
| Terrain | USGS elevation-derived shaded relief; labels and road detail are not guaranteed by this backdrop | [USGSShadedReliefOnly](https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer) |

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

Ground-map requests must remain bounded to the current viewport and stop with the Weather view. No device GPS, user tracking, MyRadar account, API key, Supabase activity, notification permission, real push delivery, or background scheduler is introduced. Existing live NWS forecasts, observations, applicable point alerts—including alerts without polygons—and their provenance remain in place. Notification and adaptive-check demonstrations remain explicitly simulated.

## Validation status

- **Verified from primary sources:** MyRadar's map/product distinction and documented controls; its explicitly listed subscription features; USGS service descriptions, tile/projection metadata, public-domain terms, and the `USGSImageryTopo` 404.
- **Not verified:** playback or exact menu contents of the supplied Drive recording. No video-derived behavior or exact four-option match is claimed.
- **Verified published source pixels:** all three USGS datasets returned HTTP 200 JPEG tiles for the fixed hotel's tile (`12/1548/1043`). Decoded responses were visually inspected: Topo 24,972 bytes, ImageryOnly 24,890 bytes and ShadedReliefOnly 5,556 bytes. Gray and Roads use different presentations of the same Topo data.
- **Implementation acceptance:** desktop/mobile browser tests use explicit synthetic geographic and weather fixtures to check composition, selector behavior, shared viewport/pin, gestures, timeline controls, attribution, failures, request bounds and close cancellation. These tests are separate from the actual published source-pixel checks; fixture images are not evidence of feed availability.

For the existing live NWS transport, native dashboard entry, and prior published weather-feed checks, see [weather-review.md](weather-review.md). Those weather-feed checks do not establish the new basemap's tile availability.
