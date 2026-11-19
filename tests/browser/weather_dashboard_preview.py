"""Fixture acceptance for the real Engineering dashboard's Weather preview.

Start a local build with VERCEL_ENV=preview and synthetic public auth settings,
then run: python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3116

Every browser API request is intercepted. Accounts and application responses use
cmpri_fixture; NWS/map responses below are explicit local test fixtures. External
requests are blocked. This verifies UI integration and lifecycle, not live-feed
availability, real accounts, persistence, pushes, or Supabase behavior.
"""

import argparse
import asyncio
import json
import os
import struct
import sys
import time
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.dont_write_bytecode = True
os.environ.setdefault("CMPRI_UI_OUTPUT", "/tmp/cmpri-weather-dashboard-review")
from cmpri_fixture import install
from playwright.async_api import async_playwright


PREVIEW = "/previews/cmpri-weather-preview.html"
RADAR = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer"
WSSI = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer"
API = "https://api.weather.gov"
POINT = "40.138080,-88.251416"
HOUR = timedelta(hours=1)
PROBE = r"""(() => {
  window.__weatherReviewForbidden = [];
  const forbid = (owner, name) => {
    try { if (owner && typeof owner[name] === 'function') owner[name] = () => {
      window.__weatherReviewForbidden.push(name);
      return name === 'requestPermission' ? Promise.resolve('denied') : undefined;
    }; } catch (_) {}
  };
  forbid(window.Notification, 'requestPermission');
  forbid(navigator.geolocation, 'getCurrentPosition');
  forbid(navigator.geolocation, 'watchPosition');
  if (window.PushManager) forbid(PushManager.prototype, 'subscribe');
  if (window === window.top || !location.pathname.includes('/previews/cmpri-weather-preview.html')) return;
  const audit = {closed: false, intervalIds: [], aborts: 0, map: null, nws: null,
    forbidden: window.__weatherReviewForbidden};
  try { (parent.__weatherFrameAudits ||= []).push(audit); } catch (_) {}
  const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
  window.setInterval = (handler, delay, ...args) => {
    const id = set(handler, delay, ...args); audit.intervalIds.push(id); return id;
  };
  window.clearInterval = id => { audit.intervalIds = audit.intervalIds.filter(value => value !== id); return clear(id); };
  const abort = AbortController.prototype.abort;
  AbortController.prototype.abort = function (...args) { audit.aborts++; return abort.apply(this, args); };
  window.addEventListener('pagehide', () => queueMicrotask(() => {
    audit.closed = true;
    audit.map = window.cmpriWeatherMap?.getState?.() || null;
    audit.nws = window.nwsLiveView?.getState?.() || null;
  }));
})();"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def iso(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def png_fixture(width=16, height=16):
    """A local green raster fixture, not generated weather or a remote image."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + bytes([30, 170, 75, 180]) * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


async def wait_for(page_or_frame, expression, arg=None, timeout=15000):
    # DevTools evaluation avoids CSP-blocked eval() in Playwright wait functions.
    deadline = time.monotonic() + timeout / 1000
    while True:
        if await page_or_frame.evaluate(expression, arg):
            return
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out: " + expression)
        await asyncio.sleep(.05)


class OfficialFeedFixtures:
    """Deterministic official-response shapes; no service is contacted."""
    def __init__(self):
        self.now = datetime.now(timezone.utc).replace(microsecond=0)
        self.forecast_calls = 0
        self.map_urls = []
        self.exports = []
        self.image_exports = []
        self.hold_forecast = True
        self.hold_map = False
        self.forecast_gate = asyncio.Event()
        self.map_gate = asyncio.Event()
        self.forecast_pending = asyncio.Event()
        self.map_pending = asyncio.Event()
        self.scan_times = [int((self.now - timedelta(minutes=10)).timestamp() * 1000),
                           int((self.now - timedelta(minutes=5)).timestamp() * 1000)]

    def envelope(self, source, data, station=None):
        result = {"status": "live", "source": source, "receivedAt": iso(self.now),
                  "sourceTimestamp": iso(self.now - timedelta(minutes=15)),
                  "data": data, "error": None}
        if station:
            result["station"] = station
        return result

    def nws(self):
        issued = iso(self.now - timedelta(minutes=15))
        point = {"type": "Feature", "properties": {
            "forecast": API + "/gridpoints/ILX/95,74/forecast",
            "forecastHourly": API + "/gridpoints/ILX/95,74/forecast/hourly",
            "forecastGridData": API + "/gridpoints/ILX/95,74",
            "observationStations": API + "/gridpoints/ILX/95,74/stations"}}
        station = {"id": "KCMI", "name": "TEST FIXTURE Champaign station", "latitude": 40.04,
                   "longitude": -88.28, "distanceMeters": 11265}
        observation = {"type": "Feature", "properties": {
            "timestamp": iso(self.now - timedelta(minutes=6)), "station": API + "/stations/KCMI",
            "textDescription": "TEST FIXTURE observed conditions",
            "temperature": {"value": 17.7777778, "unitCode": "wmoUnit:degC"},
            "windSpeed": {"value": 16.09344, "unitCode": "wmoUnit:km_h-1"},
            "windDirection": {"value": 225, "unitCode": "wmoUnit:degree_(angle)"},
            "windGust": {"value": None, "unitCode": "wmoUnit:km_h-1"},
            "visibility": {"value": None, "unitCode": "wmoUnit:m"},
            "windChill": {"value": None, "unitCode": "wmoUnit:degC"},
            "heatIndex": {"value": None, "unitCode": "wmoUnit:degC"}}}
        def forecast(hourly):
            return {"type": "Feature", "properties": {"updated": issued, "updateTime": issued,
                "generatedAt": issued, "periods": [{"number": n + 1,
                    "name": "TEST FIXTURE " + ("hourly" if hourly else "extended") + " " + str(n + 1),
                    "startTime": iso(self.now + n * (HOUR if hourly else 12 * HOUR)),
                    "endTime": iso(self.now + (n + 1) * (HOUR if hourly else 12 * HOUR)),
                    "isDaytime": True, "temperature": 67 + n, "temperatureUnit": "F",
                    "probabilityOfPrecipitation": {"value": 73, "unitCode": "wmoUnit:percent"},
                    "windSpeed": "12 mph", "windDirection": "SW",
                    "shortForecast": "TEST FIXTURE hourly rain signal" if hourly else "TEST FIXTURE extended forecast",
                    "detailedForecast": "Explicit local forecast fixture; no live conditions are claimed."}
                    for n in range(12 if hourly else 7)]}}
        interval = iso(self.now + HOUR) + "/PT1H"
        grid = {"type": "Feature", "properties": {"updateTime": issued,
            "snowfallAmount": {"uom": "wmoUnit:mm", "values": [{"validTime": interval, "value": 25.4}]},
            "iceAccumulation": {"uom": "wmoUnit:mm", "values": [{"validTime": interval, "value": None}]}}}
        bulletin = API + "/alerts/urn:oid:TEST-FIXTURE-POLYGONLESS"
        alerts = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": bulletin,
            "geometry": None, "properties": {"@id": bulletin, "id": "TEST-FIXTURE-POLYGONLESS",
                "status": "Test", "messageType": "Alert", "event": "Winter Weather Advisory",
                "headline": "TEST FIXTURE applicable polygonless county advisory", "areaDesc": "Champaign County",
                "effective": iso(self.now - timedelta(minutes=5)), "expires": iso(self.now + 2 * HOUR),
                "description": "Explicit local test fixture. No NWS alert has been issued by this test.",
                "instruction": "Fixture instructions."}}]}
        return {"location": {"name": "Residence Inn Champaign", "latitude": 40.138080,
                "longitude": -88.251416, "timeZone": "America/Chicago"}, "checkedAt": iso(self.now),
            "resources": {
                "points": self.envelope(API + "/points/" + POINT, point),
                "forecast": self.envelope(API + "/gridpoints/ILX/95,74/forecast", forecast(False)),
                "hourly": self.envelope(API + "/gridpoints/ILX/95,74/forecast/hourly", forecast(True)),
                "grid": self.envelope(API + "/gridpoints/ILX/95,74", grid),
                "stations": self.envelope(API + "/gridpoints/ILX/95,74/stations", {"type": "FeatureCollection", "features": []}),
                "observation": self.envelope(API + "/stations/KCMI/observations/latest", observation, station),
                "alerts": self.envelope(API + "/alerts/active?point=" + POINT, alerts)}}

    async def route(self, route):
        parsed = urlparse(route.request.url)
        require(route.request.method == "GET", "Weather endpoints must remain read-only")
        if parsed.path == "/api/weather-preview":
            self.forecast_calls += 1
            self.forecast_pending.set()
            if self.hold_forecast:
                await self.forecast_gate.wait()
            try:
                await route.fulfill(content_type="application/json", body=json.dumps(self.nws()))
            except Exception:
                if not self.forecast_gate.is_set():
                    raise
            return
        require(parsed.path == "/api/weather-preview/map", "Unexpected Weather endpoint: " + parsed.path)
        target = parse_qs(parsed.query).get("url", [""])[0]
        source = urlparse(target)
        require(source.scheme == "https" and source.hostname == "mapservices.weather.noaa.gov", "Map proxy accepted an unofficial source")
        self.map_urls.append(target)
        query = parse_qs(source.query)
        if target.startswith(RADAR):
            if source.path.endswith("/query"):
                data = {"objectIdFieldName": "objectid", "features": [
                    {"attributes": {"objectid": 99001 + n, "idp_validtime": stamp}}
                    for n, stamp in enumerate(self.scan_times)]}
            elif source.path.endswith("/exportImage"):
                rule = json.loads(query.get("mosaicRule", ["{}"])[0])
                self.exports.append(rule)
                require(rule.get("lockRasterIds") in [[99001], [99002]], "Export did not lock to an exact catalog fixture raster")
                if self.hold_map:
                    self.map_pending.set()
                    await self.map_gate.wait()
                if query.get("f") == ["image"]:
                    self.image_exports.append(rule)
                    width, height = map(int, query["size"][0].split(","))
                    await route.fulfill(content_type="image/png", body=png_fixture(width, height))
                    return
                bbox = list(map(float, query["bbox"][0].split(",")))
                width, height = map(int, query["size"][0].split(","))
                data = {"href": "https://mapservices.weather.noaa.gov/TEST-FIXTURE-RADAR.png",
                        "width": width, "height": height,
                        "extent": dict(zip(["xmin", "ymin", "xmax", "ymax"], bbox))}
            else:
                data = {"objectIdField": "objectid", "timeInfo": {"startTimeField": "idp_validtime"},
                        "fields": [{"name": "objectid"}, {"name": "idp_validtime"}]}
        elif source.path.endswith("TEST-FIXTURE-RADAR.png"):
            await route.fulfill(content_type="image/png", body=png_fixture())
            return
        elif target.startswith(WSSI):
            data = {"features": []} if source.path.endswith("/query") else {
                "fields": [{"name": name} for name in ["impact", "issue_time", "start_time", "end_time", "idp_filedate"]],
                "drawingInfo": {"renderer": {"uniqueValueInfos": []}}}
        else:
            raise AssertionError("Unexpected official map fixture request: " + target)
        try:
            await route.fulfill(content_type="application/json", body=json.dumps(data))
        except Exception:
            if not self.map_gate.is_set():
                raise

    def release(self):
        self.hold_forecast = False
        self.hold_map = False
        self.forecast_gate.set()
        self.map_gate.set()


async def weather_frame(page):
    locator = page.locator('iframe[src*="' + PREVIEW + '"]')
    await locator.wait_for(state="visible", timeout=30000)
    require(await locator.count() == 1, "Expected one Weather iframe")
    element = await locator.element_handle()
    frame = await element.content_frame()
    await wait_for(frame, "Boolean(window.weatherPreview && window.nwsLiveView && window.cmpriWeatherMap)", timeout=30000)
    return frame


async def run_viewport(browser, base, output, width, height):
    context = await browser.new_context(viewport={"width": width, "height": height},
        has_touch=width < 640, is_mobile=width < 640, service_workers="block", reduced_motion="reduce")
    feed = OfficialFeedFixtures()
    counts, posts, external, mutations, errors = {}, [], [], [], []
    await install(context, "chief_engineer", counts=counts, posts=posts)
    await context.route("**/api/weather-preview**", feed.route)

    async def protect(route):
        request = route.request
        parsed = urlparse(request.url)
        if parsed.hostname not in ["127.0.0.1", "localhost"]:
            external.append({"url": request.url, "method": request.method})
            await route.abort("blockedbyclient")
            return
        if parsed.path.startswith("/api/") and request.method not in ["GET", "HEAD"]:
            mutations.append({"path": parsed.path, "method": request.method})
        # Existing fixture route fulfills every application API; no API reaches
        # the running server, and no browser request can reach a database host.
        await route.fallback()

    await context.route("**/*", protect)
    await context.add_init_script(PROBE)
    page = await context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    evidence = {"viewport": [width, height], "fixtureOnly": True}
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.wait_for(state="visible", timeout=60000)
        require(feed.forecast_calls == 0 and not feed.map_urls, "Weather feeds requested before opening Weather")
        operations = page.locator("fieldset").filter(has=page.locator("legend", has_text="Operations"))
        require(await operations.get_by_role("button", name="Weather", exact=True).count() == 1, "Weather launcher is outside existing Operations")
        before_mutations = len(mutations)
        await launcher.click()
        frame = await weather_frame(page)
        # Native close dispatches this event before React unmounts the iframe.
        # Observe after the content's registered close handler; removed iframes
        # need not deliver pagehide in every Chromium configuration.
        await frame.evaluate("""() => document.addEventListener('cmpri-modal-cancel-request', () => {
          const audit = parent.__weatherFrameAudits.at(-1);
          audit.closed = true;
          audit.map = window.cmpriWeatherMap.getState();
          audit.nws = window.nwsLiveView.getState();
        })""")
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        require(await native.count() == 1, "Weather did not use one native DesktopWindow")
        require(parse_qs(urlparse(frame.url).query).get("embedded") == ["1"], "Weather iframe did not use embedded=1")
        for selector in [".appbar", ".navbar", "#dashboard", ".titlebar"]:
            for item in await frame.locator(selector).all():
                require(not await item.is_visible(), "Duplicate standalone chrome in native window: " + selector)
        require(await native.locator(".cmpri-desktop-titlebar").count() == 1, "Native window must own the only titlebar")
        await wait_for(frame, "window.nwsLiveView.getState().loading")
        require(await frame.locator("#liveTemperature").inner_text() == "Unavailable", "A fabricated temperature appeared while loading")
        require(await frame.locator("#hourlyForecast .forecast-card").count() == 0, "Sample forecasts appeared while loading")
        require("Jan 15" not in await frame.locator("#panel-weather").inner_text(), "Old weather examples remain in live view")
        evidence["loadingHasNoSampleValues"] = True
        feed.release()
        await wait_for(frame, "document.getElementById('liveTemperature').textContent === '64°F'")
        require("TEST FIXTURE observed conditions" in await frame.locator("#liveConditionText").inner_text(), "Observation response was not rendered")
        require("TEST FIXTURE Champaign station" in await frame.locator("#liveConditionSource").inner_text(), "Observation station provenance missing")
        for element in ["liveFeelsLike", "liveGusts", "liveVisibility", "liveIce"]:
            require((await frame.locator("#" + element).inner_text()).startswith("Unavailable"), "Missing " + element + " became a value")
        require("10 mph" in await frame.locator("#liveWind").inner_text(), "Observation wind conversion failed")
        require(await frame.locator("#hourlyForecast .forecast-card").count() == 12, "Hourly response periods missing")
        require(await frame.locator("#extendedForecast .forecast-card").count() == 7, "Extended response periods missing")
        require("73% precip." in await frame.locator("#hourlyForecast").inner_text(), "Hourly precipitation chance missing")
        require("TEST FIXTURE extended forecast" in await frame.locator("#extendedForecast").inner_text(), "Extended response not rendered")
        issued = await frame.evaluate("value => new Intl.DateTimeFormat('en-US', {timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value))", iso(feed.now - timedelta(minutes=15)))
        require(issued in await frame.locator("#nwsHourlySource").inner_text(), "Forecast issue time not rendered in Central")
        require(await frame.locator('#nwsHourlySource a').get_attribute("href") == API + "/gridpoints/ILX/95,74/forecast/hourly", "Forecast source does not match the response")
        alerts = frame.locator("#liveAlertsHost")
        require("no polygon supplied" in await alerts.inner_text(), "Applicable polygonless alert was dropped")
        require("TEST FIXTURE applicable polygonless county advisory" in await alerts.inner_text(), "Official alert response missing")
        require(await alerts.get_by_role("link", name="Read official bulletin").count() == 1, "Official bulletin link missing")
        require(not await frame.locator("#guestSafetyDialog").evaluate("el => el.open"), "Actual-display feed unexpectedly triggered a simulated safety dialog")
        evidence["nwsResponseRendering"] = {"temperature": "64°F", "hourly": 12, "extended": 7,
            "missingRemainsUnavailable": True, "polygonlessAlertRetained": True, "issuedCentral": issued}
        await wait_for(frame, "window.cmpriWeatherMap.getState().status.radar === 'Observed image loaded'")
        state = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(state["mode"] == "live" and state["frameCount"] == 2, "Map used fabricated/default frames")
        require(state["scanTimes"] == feed.scan_times, "Observed scan times differ from exact catalog fixtures")
        require(bool(feed.exports) and feed.exports[0]["lockRasterIds"] == [99002], "Latest radar export did not use its exact catalog raster ID")
        require(bool(feed.image_exports), "Map did not decode a direct exportImage?f=image response")
        evidence["mapResponseRendering"] = {"scanTimes": state["scanTimes"], "latestRasterId": 99002,
            "fixtureBitmapLoaded": True, "directImageExportDecoded": True}
        await page.screenshot(path=str(output / f"weather-dashboard-{width}.png"), full_page=True)
        sizes = await frame.evaluate("({width:innerWidth,document:document.documentElement.scrollWidth,body:document.getElementById('windowBody').clientWidth,content:document.getElementById('windowBody').scrollWidth})")
        require(sizes["document"] <= sizes["width"] + 1 and sizes["content"] <= sizes["body"] + 1, "Embedded Weather horizontal overflow: " + str(sizes))
        if width < 640:
            box = await native.bounding_box()
            desktop = await page.locator(".cmpri-desktop").bounding_box()
            require(abs(box["width"] - (desktop["width"] - 8)) < 2, "Mobile Weather did not match the native 4px desktop insets")
        await frame.locator("#tab-notifications").click()
        await frame.locator("#npScenario").select_option("tornado-warning")
        await frame.locator("#npReceive").click()
        require(await frame.locator("#npSafetyInstruction").inner_text() == "Staff and guests go to the first-floor interior hallways, away from windows and exterior doors.", "Guest Safety instructions changed")
        await frame.locator("#npSafetyClose").click()
        await frame.locator("#npRepeat").click()
        require(not await frame.locator("#guestSafetyDialog").evaluate("el => el.open"), "Unchanged sample reopened Guest Safety")
        await frame.locator("#tab-weather").click()
        await frame.locator("#playLoop").click()
        await wait_for(frame, "window.cmpriWeatherMap.getState().playing")
        # Hold two real foreground fetches (fulfilled locally) while unmounting:
        # closing must stop playback and abort both map and forecast requests.
        feed.hold_forecast = True
        feed.forecast_gate.clear()
        feed.forecast_pending.clear()
        feed.hold_map = True
        feed.map_gate.clear()
        feed.map_pending.clear()
        await frame.locator("#refreshNws").click()
        await asyncio.wait_for(feed.forecast_pending.wait(), timeout=5)
        await frame.locator("#zoomIn").click()
        await asyncio.wait_for(feed.map_pending.wait(), timeout=5)
        await wait_for(frame, "window.cmpriWeatherMap.getState().pendingRequests > 0 && window.nwsLiveView.getState().pendingRequests > 0")
        calls_before_close = feed.forecast_calls
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="detached")
        require(await native.count() == 0, "Native Weather window remained mounted after its X")
        feed.release()
        await wait_for(page, "window.__weatherFrameAudits?.at(-1)?.closed === true")
        closed = await page.evaluate("window.__weatherFrameAudits.at(-1)")
        require(closed["intervalIds"] == [] and not closed["map"]["playing"], "Playback survived native window close")
        require(closed["map"]["pendingRequests"] == 0 and closed["nws"]["pendingRequests"] == 0, "Requests survived native window close")
        require(closed["aborts"] >= 2, "Pending map and NWS fetches were not aborted")
        await asyncio.sleep(.25)
        require(feed.forecast_calls == calls_before_close, "A check ran after Weather closed")
        await launcher.click()
        reopened = await weather_frame(page)
        await wait_for(reopened, "document.getElementById('liveTemperature').textContent === '64°F'")
        require(feed.forecast_calls == calls_before_close + 1, "Reopening did not request a fresh NWS response")
        require(await native.count() == 1, "Reopening created duplicate native windows")
        evidence["nativeCloseAndReopen"] = {"playbackStopped": True, "pendingFetchesAborted": True,
            "frameUnmounted": True, "freshNwsRequestOnReopen": True}
        require(not await frame_forbidden(page), "Weather requested GPS, notification permission, or push registration")
        require(len(mutations) == before_mutations, "Opening Weather caused an application mutation: " + str(mutations[before_mutations:]))
        require(not errors, "JavaScript errors: " + str(errors))
        evidence.update({"passed": True, "externalRequestsBlocked": external, "applicationApiRequestsIntercepted": counts,
            "weatherRequests": feed.forecast_calls, "mapRequests": len(feed.map_urls), "noApplicationMutation": True,
            "noRealDatabaseOrPush": True, "errors": errors})
        print(f"PASS actual dashboard Weather integration {width}×{height} (local feed fixtures)", flush=True)
        return evidence
    finally:
        feed.release()
        await context.close()


async def frame_forbidden(page):
    found = await page.evaluate("(window.__weatherFrameAudits || []).flatMap(audit => audit.forbidden || [])")
    for frame in page.frames:
        try:
            found.extend(await frame.evaluate("window.__weatherReviewForbidden || []"))
        except Exception:
            pass
    return found


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3116"))
    parser.add_argument("--output", default=os.environ["CMPRI_UI_OUTPUT"])
    args = parser.parse_args()
    require(urlparse(args.base).hostname in ["127.0.0.1", "localhost"], "Only a local fixture server is permitted")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True,
            executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"), args=["--no-sandbox"])
        try:
            for width, height in [(1440, 1000), (390, 844)]:
                try:
                    results.append(await run_viewport(browser, args.base.rstrip("/"), output, width, height))
                except Exception as error:
                    results.append({"viewport": [width, height], "passed": False, "error": str(error), "fixtureOnly": True})
                    print(f"FAIL {width}×{height}: {error}", flush=True)
        finally:
            await browser.close()
    report = {"fixtureOnly": True, "liveFeedAvailabilityVerified": False, "results": results}
    (output / "weather-dashboard-report.json").write_text(json.dumps(report, indent=2))
    require(all(row["passed"] for row in results), "Dashboard Weather fixture acceptance failed; see " + str(output / "weather-dashboard-report.json"))


if __name__ == "__main__":
    asyncio.run(main())
