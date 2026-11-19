"""Verify the isolated Weather review without starting CMPRI or contacting its APIs.

Run: python tests/browser/weather_preview.py [URL] [--output /tmp/cmpri-weather-review]
Without URL, a temporary read-only HTTP server serves this checkout's public/.
External browser requests are intercepted and aborted, except explicit WSSI
responses fulfilled with local test fixtures. No external service is contacted.
These controlled feed tests do not establish live-feed availability.
Requires Python Playwright and Chromium (CHROMIUM_EXECUTABLE or /usr/bin/chromium).
"""

import argparse
import asyncio
import functools
import json
import os
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"
PREVIEW_PATH = "/previews/cmpri-weather-preview.html"
VIEWPORTS = [(1440, 1000), (390, 844), (320, 740)]
PROBE = """(() => {
  const calls = window.__weatherReviewProbe = [];
  const wrap = (owner, name, result) => {
    try { if (owner && typeof owner[name] === 'function') owner[name] = (...args) => {
      calls.push(name); return result(...args);
    }; } catch (_) {}
  };
  wrap(window.Notification, 'requestPermission', () => Promise.resolve('denied'));
  wrap(navigator.geolocation, 'getCurrentPosition', () => undefined);
  wrap(navigator.geolocation, 'watchPosition', () => 0);
  wrap(navigator.serviceWorker, 'register', () => Promise.reject(new Error('Review forbids service workers')));
  if (window.PushManager) wrap(PushManager.prototype, 'subscribe', () => Promise.reject(new Error('Review forbids push')));
})();"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


@contextmanager
def local_preview(url):
    if url:
        yield url
        return
    handler = functools.partial(QuietHandler, directory=str(PUBLIC))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}{PREVIEW_PATH}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


async def wait_for(page, expression, arg=None, timeout=5000):
    """Poll through DevTools evaluation without the page's CSP-blocked eval()."""
    deadline = time.monotonic() + timeout / 1000
    while True:
        if await page.evaluate(expression, arg):
            return
        if time.monotonic() >= deadline:
            raise AssertionError(f"Timed out waiting for: {expression}")
        await asyncio.sleep(.05)


class Review:
    def __init__(self, output, url):
        self.output = output
        self.url = url
        self.results = []
        self.requests = []
        self.errors = []
        self.stage = "initial"
        self.control_results = []

    async def check(self, name, action, **details):
        try:
            result = await action()
            row = {"test": name, "passed": True, **details}
            if result is not None:
                row["evidence"] = result
            self.results.append(row)
            print("PASS", name, flush=True)
            return result
        except Exception as exc:
            self.results.append({"test": name, "passed": False, "error": str(exc), **details})
            print("FAIL", name, str(exc), flush=True)
            return None

    async def context(self, browser, width, height):
        context = await browser.new_context(
            viewport={"width": width, "height": height},
            has_touch=width < 640, is_mobile=width < 640,
            service_workers="block", reduced_motion="reduce",
        )
        await context.add_init_script(PROBE)
        origin = urlparse(self.url)

        async def route(request_route):
            request = request_route.request
            parsed = urlparse(request.url)
            external = (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)
            forbidden = "/api/" in parsed.path or "supabase" in parsed.netloc.lower()
            if external or forbidden:
                self.requests.append({"stage": self.stage, "url": request.url,
                                      "method": request.method, "blocked": True,
                                      "forbidden_application_api": forbidden})
                await request_route.abort("blockedbyclient")
            else:
                await request_route.continue_()

        await context.route("**/*", route)
        page = await context.new_page()
        page.on("pageerror", lambda error: self.errors.append({"stage": self.stage, "error": str(error)}))
        await page.goto(self.url, wait_until="load")
        await wait_for(page, "Boolean(window.weatherPreview && window.cmpriWeatherMap && window.notificationPreview && window.weatherSim)", timeout=20000)
        return context, page

    async def open(self, page):
        await page.locator("#openWeather").click()
        await wait_for(page, "window.weatherPreview.getState().opened === true")

    async def tab(self, page, name):
        await page.locator("#tab-" + name).click()
        await wait_for(page, "name => window.weatherPreview.getState().activeTab === name", arg=name)

    async def screenshot(self, page, name):
        path = self.output / (name + ".png")
        await page.screenshot(path=str(path), full_page=True)
        return str(path)

    async def overflow(self, page):
        sizes = await page.evaluate("""() => {
          const body = document.getElementById('windowBody');
          return {viewport: innerWidth, document: document.documentElement.scrollWidth,
            bodyWidth: body.clientWidth, bodyScroll: body.scrollWidth};
        }""")
        require(sizes["document"] <= sizes["viewport"] + 1, f"Document overflow: {sizes}")
        require(sizes["bodyScroll"] <= sizes["bodyWidth"] + 1, f"Weather window overflow: {sizes}")
        return sizes

    async def forecast(self, page, strip_id, touch=False):
        strip = page.locator("#" + strip_id)
        await strip.scroll_into_view_if_needed()
        sizes = await strip.evaluate("""el => ({width: el.clientWidth, content: el.scrollWidth,
          overflow: getComputedStyle(el).overflowX,
          heights: Array.from(el.children, x => x.getBoundingClientRect().height),
          classes: Array.from(el.children, x => x.className)})""")
        require(sizes["content"] > sizes["width"], f"{strip_id} should scroll horizontally: {sizes}")
        require(sizes["overflow"] in ("auto", "scroll"), f"{strip_id} lacks native scrolling")
        require(set(sizes["classes"]) == {"forecast-card"}, f"{strip_id} does not use shared cards")
        require(max(sizes["heights"]) - min(sizes["heights"]) < 2, f"Uneven {strip_id} card heights")
        await strip.evaluate("el => el.scrollTo({left: 0, behavior: 'instant'})")
        await page.locator(f'[data-scroll-target="{strip_id}"][data-direction="1"]').click()
        await wait_for(page, "id => document.getElementById(id).scrollLeft > 10", arg=strip_id)
        right = await strip.evaluate("el => el.scrollLeft")
        await page.locator(f'[data-scroll-target="{strip_id}"][data-direction="-1"]').click()
        await wait_for(page, "arg => document.getElementById(arg.id).scrollLeft < arg.right - 5", arg={"id": strip_id, "right": right})
        if touch:
            await strip.evaluate("el => el.scrollTo({left: 0, behavior: 'instant'})")
            await strip.scroll_into_view_if_needed()
            box = await strip.bounding_box()
            session = await page.context.new_cdp_session(page)
            start = box["x"] + box["width"] * .82
            end = box["x"] + box["width"] * .2
            y = box["y"] + min(60, box["height"] / 2)
            await session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": start, "y": y}]})
            for step in range(1, 9):
                await session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": start + (end - start) * step / 8, "y": y}]})
                await page.wait_for_timeout(25)
            await session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            await session.detach()
            await wait_for(page, "id => document.getElementById(id).scrollLeft > 10", arg=strip_id)
            sizes["nativeTouchScrollLeft"] = await strip.evaluate("el => el.scrollLeft")
        return sizes

    async def notification_safety(self, page):
        await self.tab(page, "notifications")
        expected = {
            "tornado-warning": "Staff and guests go to the first-floor interior hallways, away from windows and exterior doors.",
            "severe-warning": "Staff and guests stay indoors and away from windows.",
            "freeze-risk": "Check guest walkways for ice. Ice melt is in the boiler room. Available staff, including front desk and housemen, can treat sidewalks as needed.",
        }
        evidence = []
        for key, instruction in expected.items():
            await page.evaluate("window.notificationPreview.reset()")
            await page.locator("#npScenario").select_option(key)
            await page.locator("#npReceive").click()
            require(await page.locator("#guestSafetyDialog").evaluate("el => el.open"), f"{key} did not auto-open")
            require(await page.locator("#npSafetyInstruction").inner_text() == instruction, f"Incorrect {key} instructions")
            require("SIMULATED" in await page.locator("#guestSafetyDialog").inner_text(), "Safety message lacks simulation label")
            require(await page.locator("#npSafetyClose").is_visible(), "Close X missing")
            await self.screenshot(page, "guest-safety-" + key)
            await page.locator("#npSafetyClose").click()
            before = await page.evaluate("window.notificationPreview.snapshot()")
            await page.locator("#npRepeat").click()
            after = await page.evaluate("window.notificationPreview.snapshot()")
            require(not await page.locator("#guestSafetyDialog").evaluate("el => el.open"), "Unchanged sample reopened Guest Safety")
            require(after["safetyOpens"] == before["safetyOpens"], "Duplicate safety auto-open")
            require(len(after["inbox"]) == len(before["inbox"]), "Duplicate regular message")
            evidence.append({"scenario": key, "instruction": instruction, "duplicateSuppressed": True})
        return evidence

    async def notification_regular(self, page):
        await self.tab(page, "notifications")
        await page.locator("#npWeatherPrep").check()
        cases = ["tornado-watch", "severe-watch", "winter-advisory", "winter-watch", "freeze-agriculture"]
        cases += [hazard + lead for hazard in ["snow", "freezing", "storms", "heat", "wind"] for lead in ["24", "12"]]
        evidence = []
        for key in cases:
            await page.evaluate("window.notificationPreview.reset()")
            await page.locator("#npScenario").select_option(key)
            await page.locator("#npReceive").click()
            state = await page.evaluate("window.notificationPreview.snapshot()")
            require(len(state["inbox"]) == 1, f"{key} did not produce one regular sample")
            require(state["safetyOpens"] == 0, f"{key} should not auto-open Guest Safety")
            evidence.append(key)
        for key in ["flash-flood-warning", "winter-storm-warning", "ice-storm-warning", "blizzard-warning", "snow-squall-warning"]:
            await page.evaluate("window.notificationPreview.reset()")
            result = await page.evaluate("key => window.notificationPreview.receive(window.notificationPreview.sample(key))", key)
            require(result["regular"] and result["safety"], f"Warning coverage missing: {key}")
            await page.evaluate("window.notificationPreview.closeSafety()")
        await page.locator("#npWeatherPrep").uncheck()
        await page.locator("#npWinterPrep").check()
        for key in ["snow12", "freezing12"]:
            await page.evaluate("window.notificationPreview.reset()")
            result = await page.evaluate("key => window.notificationPreview.receive(window.notificationPreview.sample(key))", key)
            require(result["regular"] and not result["safety"], f"Independent Winter Prep failed: {key}")
        await page.evaluate("window.notificationPreview.reset()")
        result = await page.evaluate("window.notificationPreview.receive(window.notificationPreview.sample('snow24'))")
        require(not result["regular"], "12-hour Winter Prep sent a 24-hour message")
        await page.locator("#npWeatherPrep").check()
        await page.evaluate("window.notificationPreview.reset()")
        await page.evaluate("window.notificationPreview.receive(window.notificationPreview.sample('snow12'))")
        state = await page.evaluate("window.notificationPreview.snapshot()")
        require(len(state["inbox"]) == 1, "Overlapping Winter Prep and Weather Prep duplicated delivery")
        return {"regularNoAutoOpen": evidence, "yearRoundWarningsCovered": True, "independentWinterPrep": True, "overlapDeduplicated": True}

    async def notification_suppression(self, page):
        await self.tab(page, "notifications")
        await page.locator("#npWeatherPrep").check()
        results = []
        for key in ["stale-forecast", "missing-forecast", "outside-property", "expired-warning"]:
            await page.evaluate("window.notificationPreview.reset()")
            result = await page.evaluate("key => window.notificationPreview.receive(window.notificationPreview.sample(key))", key)
            state = await page.evaluate("window.notificationPreview.snapshot()")
            require(result["suppressed"] and not result["regular"] and not result["safety"], f"Unsafe suppression: {key}: {result}")
            require(not state["inbox"] and state["safetyOpens"] == 0, f"Suppressed sample delivered: {key}")
            results.append({"scenario": key, "reason": result["suppressed"]})
        for action in ["canceled", "expired"]:
            await page.evaluate("window.notificationPreview.reset()")
            result = await page.evaluate("action => {const a=window.notificationPreview.sample('tornado-warning'); a.action=action; return window.notificationPreview.receive(a);}", action)
            require(result["suppressed"] and not result["regular"] and not result["safety"], f"{action} sample delivered")
        return results

    async def safety_mobile(self, page, width):
        await self.tab(page, "notifications")
        await page.evaluate("window.notificationPreview.reset(); window.notificationPreview.receive(window.notificationPreview.sample('tornado-warning'))")
        dialog = page.locator("#guestSafetyDialog")
        require(await dialog.evaluate("el => el.open"), "Mobile Guest Safety did not open")
        sizes = await dialog.evaluate("""el => {const b=el.getBoundingClientRect(); return {
          left:b.left,right:b.right,width:b.width,height:b.height,viewportWidth:innerWidth,
          viewportHeight:innerHeight,scroll:el.scrollWidth,client:el.clientWidth};}""")
        require(sizes["left"] >= 0 and sizes["right"] <= sizes["viewportWidth"], f"Safety dialog outside viewport: {sizes}")
        require(sizes["height"] <= sizes["viewportHeight"] and sizes["scroll"] <= sizes["client"] + 1, f"Safety dialog overflow: {sizes}")
        require("first-floor interior hallways" in await page.locator("#npSafetyInstruction").inner_text(), "Mobile tornado instructions missing")
        await self.screenshot(page, f"{width}-guest-safety")
        await page.locator("#npSafetyClose").click()
        return sizes

    async def shared_checks(self, page):
        await self.tab(page, "checks")
        await page.evaluate("window.notificationPreview.reset(); window.weatherSim.reset()")
        await page.locator("#simPushEnabled").check()
        sequence = [await page.evaluate("window.weatherSim.snapshot()")]
        for _ in range(3):
            await page.locator("#simStep").click()
            sequence.append(await page.evaluate("window.weatherSim.snapshot()"))
            await page.evaluate("window.notificationPreview.closeSafety()")
        require([x["mode"]["minutes"] for x in sequence] == [5, 2, 1, 5], "Shared interval sequence differs from 5/2/1/5")
        require(all(x["nextCheck"] - x["now"] == x["mode"]["minutes"] * 60000 for x in sequence), "Next shared check incorrect")
        for state_index in (0, 1, 2):
            await page.evaluate("window.notificationPreview.reset(); window.weatherSim.reset()")
            for _ in range(state_index):
                await page.evaluate("window.weatherSim.step(); window.notificationPreview.closeSafety()")
            before = await page.evaluate("window.weatherSim.snapshot()")
            after = await page.evaluate("window.weatherSim.unchanged()")
            require(after["requests"] == before["requests"] + 1, "Unchanged result did not add exactly one shared NWS request")
            require(after["transactions"] == before["transactions"], "Unchanged result added simulated database activity")
            require(after["pushes"] == before["pushes"], "Unchanged result duplicated simulated push")
        fallback = {}
        for action in ("cancel", "expire"):
            await page.evaluate("window.notificationPreview.reset(); window.weatherSim.reset(); window.weatherSim.step(); window.weatherSim.step(); window.notificationPreview.closeSafety()")
            first = await page.evaluate(f"window.weatherSim.{action}()")
            second = await page.evaluate(f"window.weatherSim.{action}()")
            require([first["mode"]["minutes"], second["mode"]["minutes"]] == [2, 5], f"{action} did not slow back to 2 then 5")
            require(all(row["db"] > 0 for row in second["checks"] if row["changes"]), "Alert transition omitted simulated database record")
            fallback[action] = [first["mode"]["minutes"], second["mode"]["minutes"]]
        await page.evaluate("window.notificationPreview.reset(); window.weatherSim.reset(); window.weatherSim.step()")
        before = await page.evaluate("window.weatherSim.snapshot()")
        after = await page.evaluate("window.weatherSim.change()")
        require(after["transactions"] == before["transactions"] + 1 and after["pushes"] == before["pushes"] + 1, "Material update did not add one transaction/push")
        return {"sequenceMinutes": [x["mode"]["minutes"] for x in sequence], "unchangedChecks": 3, "fallback": fallback, "materialUpdate": True}

    async def opaque_version_updates(self, page):
        await self.tab(page, "notifications")
        await page.locator("#simPushEnabled").check()
        await page.locator("#npOfficial").check()
        await page.locator("#npGuestSafety").check()
        await self.tab(page, "checks")
        await page.evaluate("window.notificationPreview.reset(); window.weatherSim.reset()")
        for _ in range(2):
            await page.locator("#simStep").click()
            if await page.locator("#guestSafetyDialog").evaluate("el => el.open"):
                await page.locator("#npSafetyClose").click()
        baseline = await page.evaluate("window.notificationPreview.snapshot()")
        version = baseline["lastSample"]["version"]
        require(isinstance(version, str) and isinstance(json.loads(version), list), "Shared check did not exercise an opaque JSON fingerprint version")
        require(baseline["lastSample"]["event"] == "Severe Thunderstorm Warning", "Shared check did not leave the warning as the update subject")
        await self.tab(page, "notifications")
        versions = [version]
        counts = [{"regular": len(baseline["inbox"]), "safety": baseline["safetyOpens"]}]
        for update in range(1, 3):
            await page.locator("#npUpdated").click()
            state = await page.evaluate("window.notificationPreview.snapshot()")
            versions.append(state["lastSample"]["version"])
            require(len(state["inbox"]) == len(baseline["inbox"]) + update, "Material update of opaque version did not add a new regular message")
            require(state["safetyOpens"] == baseline["safetyOpens"] + update, "Material update of opaque version did not auto-open Guest Safety")
            require(await page.locator("#guestSafetyDialog").evaluate("el => el.open"), "Updated warning safety dialog not visible")
            await page.locator("#npSafetyClose").click()
            counts.append({"regular": len(state["inbox"]), "safety": state["safetyOpens"]})
        require(len(set(versions)) == 3 and all(value and "NaN" not in value for value in versions), f"Opaque material update versions collided: {versions}")
        before_repeat = await page.evaluate("window.notificationPreview.snapshot()")
        await page.locator("#npRepeat").click()
        after_repeat = await page.evaluate("window.notificationPreview.snapshot()")
        require(len(after_repeat["inbox"]) == len(before_repeat["inbox"]) and after_repeat["safetyOpens"] == before_repeat["safetyOpens"], "Unchanged opaque update duplicated delivery or safety opening")
        require(not await page.locator("#guestSafetyDialog").evaluate("el => el.open"), "Unchanged latest version reopened dismissed Guest Safety")
        return {"versions": versions, "counts": counts, "latestRepeatSuppressed": True}

    async def map_controls(self, page):
        await self.tab(page, "weather")
        before = await page.evaluate("window.cmpriWeatherMap.getState()")
        await page.locator("#zoomIn").click()
        zoomed = await page.evaluate("window.cmpriWeatherMap.getState()")
        require(zoomed["zoom"] > before["zoom"], "Zoom in did not change map zoom")
        await page.locator("#zoomOut").click()
        canvas = page.locator("#radarCanvas")
        await canvas.scroll_into_view_if_needed()
        await canvas.focus()
        pre_pan = await page.evaluate("window.cmpriWeatherMap.getState()")
        await page.keyboard.press("ArrowRight")
        panned = await page.evaluate("window.cmpriWeatherMap.getState()")
        require(panned["center"] != pre_pan["center"], "Keyboard pan did not change map center")
        box = await canvas.bounding_box()
        await page.mouse.move(box["x"] + box["width"] * .45, box["y"] + box["height"] * .5)
        await page.mouse.down()
        await page.mouse.move(box["x"] + box["width"] * .6, box["y"] + box["height"] * .6, steps=6)
        await page.mouse.up()
        pointer_panned = await page.evaluate("window.cmpriWeatherMap.getState()")
        require(pointer_panned["center"] != panned["center"], "Pointer drag did not pan map")
        await page.locator("#recenter").click()
        centered = await page.evaluate("window.cmpriWeatherMap.getState()")
        require(centered["center"] != panned["center"], "Recenter did not change panned map")
        await page.locator("#mapOpacity").evaluate("el => {el.value='35'; el.dispatchEvent(new Event('input', {bubbles:true}));}")
        require("35" in await page.locator("#opacityValue").inner_text(), "Opacity output did not update")
        await page.locator("#previousFrame").click()
        frame = await page.locator("#frameRange").input_value()
        await page.locator("#nextFrame").click()
        require(await page.locator("#frameRange").input_value() != frame, "Previous/next scan controls did not advance")
        await page.locator("#frameRange").evaluate("el => {el.value='3'; el.dispatchEvent(new Event('input', {bubbles:true}));}")
        require(await page.locator("#frameRange").input_value() == "3", "Scan scrubber failed")
        scan_time = await page.locator("#scanTime").inner_text()
        require(any(zone in scan_time for zone in ("CST", "CDT", "Central")), "Scan time lacks Central timezone")
        await page.locator("#playLoop").click()
        require((await page.evaluate("window.cmpriWeatherMap.getState()"))["playing"], "Loop did not start")
        running_frame = await page.locator("#frameRange").input_value()
        await wait_for(page, "old => document.getElementById('frameRange').value !== old", arg=running_frame)
        await page.locator("#playLoop").click()
        require(not (await page.evaluate("window.cmpriWeatherMap.getState()"))["playing"], "Loop did not pause")
        await page.locator("#fullscreen").click()
        await wait_for(page, "Boolean(document.fullscreenElement || document.getElementById('mapShell').classList.contains('expanded'))")
        await page.locator("#fullscreen").click()
        await wait_for(page, "!document.fullscreenElement && !document.getElementById('mapShell').classList.contains('expanded')")
        await page.locator("#mapLayerRoads").check()
        await page.locator("#mapLayerImpacts").check()
        layers = (await page.evaluate("window.cmpriWeatherMap.getState()"))["layers"]
        require(all(layers.values()), f"Three layers cannot coexist: {layers}")
        await page.locator("#mapLayerRadar").uncheck()
        layers = (await page.evaluate("window.cmpriWeatherMap.getState()"))["layers"]
        require(not layers["radar"] and layers["roads"] and layers["impacts"], "Radar toggle changed independent road/impact overlays")
        await page.locator("#showEchoes").check()
        require((await page.evaluate("window.cmpriWeatherMap.getState()"))["layers"]["radar"], "Echoes toggle did not restore radar")
        await self.screenshot(page, "1440-all-map-layers")
        details = page.locator("details.additional-map-products")
        if await details.count() and not await details.evaluate("el => el.open"):
            await details.locator("summary").click()
        if await details.count():
            require(await details.evaluate("el => el.open"), "More NOAA products disclosure did not open")
            await details.locator("summary").click()
            require(not await details.evaluate("el => el.open"), "More NOAA products disclosure did not close")
            await details.locator("summary").click()
        product_labels = {}
        for key in ["velocity", "ptype", "satellite", "lightning", "winter", "reflectivity"]:
            if key == "winter":
                await page.locator("#mapLayerImpacts").uncheck()
            await page.locator(f'[data-layer="{key}"]').click()
            require(await page.locator(f'[data-layer="{key}"]').get_attribute("aria-pressed") == "true", f"Layer {key} not selected")
            product_labels[key] = await page.locator("#mapStatus").inner_text()
        provenance = await page.locator("#mapControlReport [data-control-report]").evaluate_all("rows => rows.map(row => ({id:row.dataset.controlReport,cells:Array.from(row.cells,cell=>cell.textContent)}))")
        require(len(provenance) >= 20 and all(len(row["cells"]) == 5 and all(row["cells"]) for row in provenance), "Map control owner/source/effect/status coverage incomplete")
        required_ids = ["radar", "roads", "impacts", "velocity", "ptype", "satellite", "lightning", "moreNoaaProducts", "pin", "pan", "zoomIn", "zoomOut", "recenter", "fullscreen", "opacity", "legend", "previousFrame", "playLoop", "frameRange", "nextFrame", "showEchoes", "tryLiveFeeds", "mapUseDemo", "sourceLink"]
        require(set(required_ids) <= {row["id"] for row in provenance}, "Map provenance omits a control")
        require(await page.locator("iframe").count() == 0, "Preview embeds a separate radar app")
        self.control_results = ["zoom in", "zoom out", "keyboard pan", "pointer drag", "recenter", "opacity", "previous scan", "next scan", "scrub", "play", "pause", "fullscreen enter", "fullscreen exit", "independent radar/roads/impacts", "show echoes", "six product selectors", "NOAA choices expand/collapse", f"{len(provenance)} control provenance rows"]
        return {"initial": before, "zoomed": zoomed, "panned": panned, "centered": centered, "productLabels": product_labels, "controls": self.control_results, "provenance": provenance}

    async def map_lifecycle(self, page):
        await self.tab(page, "weather")
        await page.locator('[data-layer="reflectivity"]').click()
        if not (await page.evaluate("window.cmpriWeatherMap.getState()"))["playing"]:
            await page.locator("#playLoop").click()
        await page.locator("#closeWeather").click()
        closed = await page.evaluate("window.weatherPreview.getState()")
        require(not closed["opened"] and not closed["playing"], "Closing Weather failed to stop map/playback")
        require(closed["pendingRequests"] == 0 and not closed["active"], "Closed map retains pending requests or activity")
        frame = await page.locator("#frameRange").input_value()
        count = len(self.requests)
        await page.wait_for_timeout(900)
        require(await page.locator("#frameRange").input_value() == frame, "Closed map still advances scans")
        require(len(self.requests) == count, "Closed map still requests feeds")
        require(await page.locator("#weatherWindow").is_hidden(), "Weather window not closed")
        await self.open(page)
        await self.tab(page, "notifications")
        require(not (await page.evaluate("window.cmpriWeatherMap.getState()"))["playing"], "Hidden weather panel still plays")
        return closed

    async def hidden_radar_stops(self, page):
        await self.tab(page, "weather")
        evidence = []
        for control in ("showEchoes", "mapLayerRadar"):
            await page.locator("#mapUseDemo").click()
            await page.locator("#playLoop").click()
            running = await page.evaluate("window.cmpriWeatherMap.getState()")
            require(running["playing"], f"Playback did not start before testing {control}")
            await wait_for(page, "frame => window.cmpriWeatherMap.getState().frame !== frame", arg=running["frame"])
            await page.locator("#" + control).uncheck()
            hidden = await page.evaluate("window.cmpriWeatherMap.getState()")
            request_count = len(self.requests)
            require(not hidden["playing"] and not hidden["layers"]["radar"], f"{control} hid radar but left playback running")
            await page.wait_for_timeout(1000)
            frozen = await page.evaluate("window.cmpriWeatherMap.getState()")
            require(frozen["frame"] == hidden["frame"] and not frozen["playing"], f"{control} advanced frames while radar hidden")
            require(frozen["networkRequests"] == hidden["networkRequests"] and len(self.requests) == request_count, f"{control} requested hidden radar")
            require(await page.locator("#playLoop").is_disabled(), f"{control} left hidden-radar Play enabled")
            await page.locator("#" + control).check()
            restored = await page.evaluate("window.cmpriWeatherMap.getState()")
            require(restored["layers"]["radar"] and not restored["playing"], f"{control} restoring radar unexpectedly restarted playback")
            evidence.append({"control": control, "frozenFrame": frozen["frame"], "networkRequestsWhileHidden": 0, "restoredPaused": True})
        return evidence

    async def live_failure(self, page):
        self.stage = "intentional-live-failure-fixture"
        await self.tab(page, "weather")
        before = len(self.requests)
        await page.locator("#tryLiveFeeds").click()
        await wait_for(page, "/unavailable|failed|could not|unable/i.test(document.getElementById('mapStatus').textContent + document.getElementById('observedRadarNote').textContent)", timeout=15000)
        attempted = self.requests[before:]
        require(attempted, "Live button did not attempt an official request")
        require(all(urlparse(x["url"]).hostname.endswith(("noaa.gov", "weather.gov")) for x in attempted), "Live failure test attempted an unapproved feed")
        state = await page.evaluate("window.cmpriWeatherMap.getState()")
        text = await page.locator("#mapStatus").inner_text()
        require("unavailable" in text.lower() or "failed" in text.lower(), "Failed live radar lacks unavailable label")
        require(state["frameCount"] == 0 and not state["scanTimes"], "Failed live radar fabricated observed scan times")
        require(not state["playing"], "Failed live radar plays nonexistent scans")
        await page.locator("#mapUseDemo").click()
        demo = await page.evaluate("window.cmpriWeatherMap.getState()")
        require(demo["mode"] == "simulation" and demo["pendingRequests"] == 0, "Use simulated map did not restore labeled samples/abort requests")
        await page.locator("#closeWeather").click()
        closed = await page.evaluate("window.cmpriWeatherMap.getState()")
        require(not closed["playing"], "Closing failed live view left playback active")
        return {"fixture": "All external requests deliberately aborted; not a live-feed verification", "attempts": attempted, "label": text, "state": state}

    async def wssi_freshness(self, browser):
        self.stage = "mocked-wssi-freshness-fixture"
        context, page = await self.context(browser, 1440, 1000)
        fixture_requests = []
        try:
            now = await page.evaluate("Date.now()")
            attributes = {"impact": "MODERATE", "issue_time": now - 60000,
                          "start_time": now - 120000, "end_time": now + 3600000,
                          "idp_filedate": now - 60000}
            metadata = {"fields": [{"name": key} for key in attributes],
                        "drawingInfo": {"renderer": {"uniqueValueInfos": [
                            {"value": "MODERATE", "label": "Moderate impacts",
                             "symbol": {"color": [247, 150, 47, 255]}}
                        ]}}}
            result = {"features": [{"attributes": attributes, "geometry": {"rings": [[
                [-88.4, 40.0], [-88.1, 40.0], [-88.1, 40.3], [-88.4, 40.3], [-88.4, 40.0]
            ]]}}]}

            async def wssi_route(route):
                fixture_requests.append(route.request.url)
                payload = result if urlparse(route.request.url).path.endswith("/query") else metadata
                await route.fulfill(json=payload, headers={"access-control-allow-origin": "*"})

            await page.route("**/outlooks/wpc_wssi/MapServer/**", wssi_route)
            await self.open(page)
            await page.locator("#mapLayerImpacts").check()
            await page.locator("#tryLiveFeeds").click()
            await wait_for(page, "window.cmpriWeatherMap.getState().status.impacts.includes('1 fresh, 0 STALE')")
            fresh = await page.evaluate("window.cmpriWeatherMap.getState()")
            require(fresh["forecastCoverage"]["stale"] == 0, "Fresh mocked WSSI area incorrectly stale")
            await page.locator("#closeWeather").click()
            await page.evaluate("""() => {
              const originalNow = Date.now.bind(Date);
              window.__weatherReviewOriginalNow = originalNow;
              Date.now = () => originalNow() + 7 * 3600000;
            }""")
            await self.open(page)
            await wait_for(page, "window.cmpriWeatherMap.getState().forecastCoverage.stale === 1")
            stale = await page.evaluate("window.cmpriWeatherMap.getState()")
            stale_label = await page.locator("#mapImpactStatus").text_content()
            require("STALE" in stale["status"]["impacts"] and "STALE" in stale_label, f"Reopened aged WSSI area lacks stale label: state={stale['status']['impacts']!r}; label={stale_label!r}")
            require(stale["networkRequests"] == fresh["networkRequests"], "WSSI reopening started automatic feed requests")
            require(len(fixture_requests) == 2, "WSSI freshness regression did not use exactly metadata/query fixtures")
            return {"fixture": "Mocked NOAA-format WSSI metadata/polygon; not live weather verification",
                    "freshStatus": fresh["status"]["impacts"], "afterSevenHours": stale["status"]["impacts"],
                    "staleAreas": stale["forecastCoverage"]["stale"], "newRequestsOnReopen": 0}
        finally:
            await context.close()

    async def run(self, browser):
        for width, height in VIEWPORTS:
            self.stage = f"layout-{width}"
            context = None
            try:
                context, page = await self.context(browser, width, height)
                await self.check(f"{width}: closed view is lazy", lambda: self.lazy(page))
                await self.open(page)
                for tab in ("weather", "notifications", "checks", "sources"):
                    await self.tab(page, tab)
                    await self.check(f"{width}: {tab} no page/window overflow", lambda: self.overflow(page))
                    await self.screenshot(page, f"{width}-{tab}")
                await self.tab(page, "weather")
                for strip in ("hourlyForecast", "extendedForecast"):
                    await self.check(f"{width}: {strip} shared cards/arrows" + ("/native touch" if width < 640 else ""), lambda strip=strip: self.forecast(page, strip, width < 640))
                if width == 1440:
                    for name, action in [
                        ("Guest Safety exact instructions and duplicate dismissal", self.notification_safety),
                        ("Year-round warning and 24/12-hour preparation coverage", self.notification_regular),
                        ("Stale/missing/inapplicable/expired/canceled suppression", self.notification_suppression),
                        ("Shared intervals, cached comparison and cancellation/expiry", self.shared_checks),
                        ("Opaque shared-alert versions support unique material updates and deduplication", self.opaque_version_updates),
                        ("Map control behavior and source labels", self.map_controls),
                        ("Both radar visibility controls stop playback, freeze frames and stop requests", self.hidden_radar_stops),
                        ("Map close/tab lifecycle stops playback and requests", self.map_lifecycle),
                    ]:
                        await self.check(name, lambda action=action: action(page))
                else:
                    await self.check(f"{width}: readable Guest Safety dialog and close", lambda: self.safety_mobile(page, width))
                await self.check(f"{width}: no forbidden browser APIs", lambda: self.no_forbidden_apis(page))
                if width == 320:
                    await self.check("Aborted NOAA request shows unavailable and closes cleanly", lambda: self.live_failure(page))
            except Exception as exc:
                self.results.append({"test": f"{width}: browser setup/flow", "passed": False, "error": str(exc), "traceback": traceback.format_exc()})
                print("FAIL", width, str(exc), flush=True)
            finally:
                if context:
                    await context.close()
        await self.check("Cached WSSI forecast becomes stale after time advance and reopen", lambda: self.wssi_freshness(browser))
        controlled_stages = {"intentional-live-failure-fixture", "mocked-wssi-freshness-fixture"}
        require_default = [r for r in self.requests if r["stage"] not in controlled_stages]
        self.results.append({"test": "No external/default CMPRI/Supabase requests", "passed": not require_default, "evidence": require_default})
        forbidden = [r for r in self.requests if r["forbidden_application_api"]]
        self.results.append({"test": "No CMPRI or Supabase API calls in any phase", "passed": not forbidden, "evidence": forbidden})
        self.results.append({"test": "No JavaScript page errors", "passed": not self.errors, "evidence": self.errors})

    async def lazy(self, page):
        state = await page.evaluate("window.weatherPreview.getState()")
        require(not state["opened"] and not state["playing"], "Weather initialized active while closed")
        require(not state["mapReady"] and state["networkRequests"] == 0, "Closed preview initialized map rendering or external feed requests")
        require(not self.requests, "Closed default preview attempted external or application request")
        return state

    async def no_forbidden_apis(self, page):
        calls = await page.evaluate("window.__weatherReviewProbe")
        require(not calls, f"Forbidden browser APIs invoked: {calls}")
        state = await page.evaluate("window.weatherPreview.getState()")
        require(state["databaseCalls"] == 0 and state["pushes"] == 0, "Actual integration counters nonzero")
        return {"interceptedCalls": calls, "actualDatabaseCalls": state["databaseCalls"], "actualPushes": state["pushes"]}

    def write_report(self):
        passed = sum(r["passed"] for r in self.results)
        report = {"generatedAt": datetime.now(timezone.utc).isoformat(), "url": self.url,
                  "passed": passed, "failed": len(self.results) - passed,
                  "liveFeedVerification": "Not performed: external requests deliberately aborted or fulfilled with explicit WSSI test fixtures. Failure/freshness behavior only.",
                  "results": self.results, "blockedRequests": self.requests, "pageErrors": self.errors}
        (self.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"{passed} passed; {report['failed']} failed. Report: {self.output / 'report.json'}", flush=True)
        return report["failed"]


async def main(args, url):
    args.output.mkdir(parents=True, exist_ok=True)
    review = Review(args.output, url)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"),
            args=["--no-sandbox"],
        )
        try:
            await review.run(browser)
        finally:
            await browser.close()
    return review.write_report()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", help="Optional standalone preview URL; default serves public/ read-only")
    parser.add_argument("--output", type=Path, default=Path("/tmp/cmpri-weather-review"))
    options = parser.parse_args()
    with local_preview(options.url) as preview_url:
        raise SystemExit(1 if asyncio.run(main(options, preview_url)) else 0)
