"""Actual-dashboard map acceptance using explicit local NWS/USGS fixtures.

Run against a local preview build:
  python tests/browser/weather_map_basemaps.py --base http://127.0.0.1:3116

This uses synthetic CMPRI accounts and intercepts every application API request.
Solid-color ground tiles and radar rasters are test fixtures, not weather or
geographic evidence. Passing does not establish live USGS/NOAA availability.
"""

import argparse
import asyncio
import json
import math
import os
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, frame_forbidden, install, install_weather_audit,
    require, wait_for, weather_frame,
)
from playwright.async_api import async_playwright


async def settled(frame, timeout=15000):
    await wait_for(frame, """() => {
      const ground = window.cmpriWeatherMap.getState().ground;
      return ground && ground.pending === 0 && ground.visibleTotal > 0 &&
        ground.visibleLoaded + ground.visibleFailed >= ground.visibleTotal;
    }""", timeout=timeout)
    await asyncio.sleep(.05)


async def menu(frame, element, opened):
    details = frame.locator("#" + element)
    if await details.evaluate("el => el.open") != opened:
        await details.locator(":scope > summary").click()


async def style(frame, value):
    await menu(frame, "mapBackgroundMenu", True)
    await frame.locator("#mapBackgroundStyle").select_option(value)
    await menu(frame, "mapBackgroundMenu", False)
    await wait_for(frame, "value => window.cmpriWeatherMap.getState().backgroundStyle === value", value)
    await settled(frame)


async def radar(frame, enabled):
    await menu(frame, "mapLayersMenu", True)
    await frame.locator("#mapLayerRadar").set_checked(enabled)
    await menu(frame, "mapLayersMenu", False)
    await wait_for(frame, "enabled => window.cmpriWeatherMap.getState().layers.radar === enabled", enabled)


async def pixel(frame):
    return await frame.locator("#radarCanvas").evaluate("""canvas => {
      const x = Math.round(canvas.width * .11), y = Math.round(canvas.height * .18);
      return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
    }""")


def world_at(state, width, height, anchor):
    radius = 6378137
    center = state["center"]
    x = radius * center["lon"] * math.pi / 180
    y = radius * math.log(math.tan(math.pi / 4 + center["lat"] * math.pi / 360))
    resolution = 620 / state["zoom"]
    return (x + (anchor[0] - width / 2) * resolution,
            y - (anchor[1] - height / 2) * resolution)


async def anchored_zoom(page, frame, gesture, mobile=False):
    canvas = frame.locator("#radarCanvas")
    await canvas.scroll_into_view_if_needed()
    box = await canvas.bounding_box()
    anchor = (box["width"] * .62, box["height"] * .67)
    x, y = box["x"] + anchor[0], box["y"] + anchor[1]
    before = await frame.evaluate("window.cmpriWeatherMap.getState()")
    if gesture == "wheel":
        await page.mouse.move(x, y)
        await page.mouse.wheel(0, -240)
    elif gesture == "double-click":
        await page.mouse.dblclick(x, y, delay=70)
    elif gesture == "pinch":
        require(mobile, "Trusted pinch requires a mobile touch context")
        session = await page.context.new_cdp_session(page)
        try:
            def fingers(distance):
                return [{"x": x - distance, "y": y, "id": 1},
                        {"x": x + distance, "y": y, "id": 2}]
            await session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": fingers(25)})
            for step in range(1, 9):
                await session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": fingers(25 + step * 4)})
                await asyncio.sleep(.015)
            await session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            await session.detach()
    await wait_for(frame, "before => window.cmpriWeatherMap.getState().zoom > before * 1.1", before["zoom"])
    after = await frame.evaluate("window.cmpriWeatherMap.getState()")
    old_point = world_at(before, box["width"], box["height"], anchor)
    new_point = world_at(after, box["width"], box["height"], anchor)
    error = math.hypot(new_point[0] - old_point[0], new_point[1] - old_point[1])
    require(error <= 620 / after["zoom"] * 4, f"{gesture} moved its geographic anchor by {error:.1f}m")
    return {"gesture": gesture, "beforeZoom": before["zoom"], "afterZoom": after["zoom"], "anchorErrorMeters": error}


async def run_viewport(browser, base, output, width, height):
    context = await browser.new_context(viewport={"width": width, "height": height},
        is_mobile=width < 640, has_touch=width < 640, service_workers="block", reduced_motion="reduce")
    await context.route_web_socket("**/*", block_websocket)
    fixture = OfficialFeedFixtures()
    context.on("requestfailed", fixture.request_failed)
    fixture.scan_times = [int((fixture.now - timedelta(minutes=minutes)).timestamp() * 1000)
                          for minutes in range(120, 0, -5)]
    fixture.release()
    errors, externals, mutations = [], [], []
    await install(context, "chief_engineer")
    await context.route("**/api/weather-preview**", fixture.route)

    async def protect(route):
        parsed = urlparse(route.request.url)
        if parsed.hostname not in ["127.0.0.1", "localhost"]:
            externals.append(route.request.url)
            await route.abort("blockedbyclient")
            return
        if parsed.path.startswith("/api/") and route.request.method not in ["GET", "HEAD"]:
            mutations.append({"path": parsed.path, "method": route.request.method})
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
        require(not fixture.basemap_requests and not fixture.map_urls and fixture.forecast_calls == 0,
                "Ground or weather data loaded before Weather opened")
        mutation_start = len(mutations)
        await launcher.click()
        frame = await weather_frame(page)
        await install_weather_audit(frame)
        await wait_for(frame, "window.cmpriWeatherMap.getState().ground?.visibleLoaded > 0")
        await settled(frame)
        await wait_for(frame, "window.cmpriWeatherMap.getState().status.radar === 'Observed image loaded'")
        initial = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(initial["zoom"] == 4 and initial["grid"] is False, "Default map extent or optional grid is incorrect")
        require(initial["ground"]["visibleLoaded"] > 0, "No actual ground fixture tile decoded")
        require(await frame.locator("#mapBackgroundMenu").count() == 1 and await frame.locator("#mapLayersMenu").count() == 1,
                "Separate Map and Layers controls are missing")
        await radar(frame, False)
        before_styles = await frame.evaluate("window.cmpriWeatherMap.getState()")
        weather_requests_before_styles = len(fixture.map_urls)
        colors = {}
        for value, expected in [("roads", [52, 101, 173]), ("aerial", [173, 80, 42]),
                                ("terrain", [112, 140, 64]), ("gray", None)]:
            await style(frame, value)
            color = await pixel(frame)
            if expected:
                require(max(abs(color[n] - expected[n]) for n in range(3)) <= 3,
                        f"{value} did not draw source tiles beneath the map: {color}")
            else:
                require(max(color[:3]) - min(color[:3]) <= 3, "Gray style did not transform the actual Topo tile")
            current = await frame.evaluate("window.cmpriWeatherMap.getState()")
            require(current["center"] == before_styles["center"] and current["zoom"] == before_styles["zoom"],
                    "Changing background moved the hotel viewport")
            require(current["scanTimes"] == before_styles["scanTimes"], "Changing background changed weather scans")
            require("USGS" in await frame.locator("#mapAttribution").inner_text(), "Ground attribution is missing")
            if value == "aerial":
                source_text = (await frame.locator("#mapGroundStatus").inner_text()) + " " + (await frame.locator("#mapAttribution").inner_text())
                require(any(word in source_text.lower() for word in ["historical", "not live", "not current", "acquisition"]),
                        "Aerial photography lacks a historical / not-live-weather label")
            colors[value] = color
        evidence["groundPixelsByStyle"] = colors
        require(len(fixture.map_urls) == weather_requests_before_styles,
                "Changing a geographic background restarted NOAA weather requests")
        # Verify the radar raster is composited over source geography, rather
        # than replacing it with a stand-alone weather image or fake grid.
        await style(frame, "roads")
        base_pixel = await pixel(frame)
        await radar(frame, True)
        await wait_for(frame, "window.cmpriWeatherMap.getState().status.radar === 'Observed image loaded'")
        await asyncio.sleep(.08)
        overlay_pixel = await pixel(frame)
        alpha = 180 / 255 * (await frame.evaluate("window.cmpriWeatherMap.getState().opacity"))
        expected = [round(base_pixel[n] * (1 - alpha) + [30, 170, 75][n] * alpha) for n in range(3)]
        require(max(abs(overlay_pixel[n] - expected[n]) for n in range(3)) <= 4,
                f"Radar/background composition mismatch: base={base_pixel}, overlay={overlay_pixel}, expected={expected}")
        evidence["radarCompositedOverGround"] = {"ground": base_pixel, "radarOverGround": overlay_pixel}
        # All loop windows must contain only exact catalog times; shorter
        # windows must not fabricate missing scans to fill a requested duration.
        loop_counts = {}
        for minutes in ["120", "60", "90"]:
            await frame.locator("#loopLength").select_option(minutes)
            state = await frame.evaluate("window.cmpriWeatherMap.getState()")
            require(state["loopMinutes"] == int(minutes), "Loop-window selection did not update")
            require(state["scanTimes"] and set(state["scanTimes"]).issubset(fixture.scan_times), "Loop invented scan times")
            require(state["scanTimes"][-1] == fixture.scan_times[-1], "Loop dropped the latest actual scan")
            require(state["scanTimes"][-1] - state["scanTimes"][0] <= int(minutes) * 60000, "Loop exceeds selected history")
            loop_counts[minutes] = state["frameCount"]
        require(loop_counts["120"] > loop_counts["60"], "Loop-window control did not filter actual history")
        for value in ["slow", "normal", "fast"]:
            await frame.locator("#playbackSpeed").select_option(value)
            require((await frame.evaluate("window.cmpriWeatherMap.getState()"))["playbackSpeed"] == value, "Playback speed selection did not update")
        displayed = await frame.evaluate("window.cmpriWeatherMap.getState().displayedScanTime")
        await frame.locator("#playLoop").click()
        await wait_for(frame, "before => { const s=window.cmpriWeatherMap.getState(); return s.playing && s.displayedScanTime !== before; }", displayed, timeout=7000)
        playing = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(playing["displayedScanTime"] in fixture.scan_times, "Playback displayed an invented scan time")
        await frame.locator("#playLoop").click()
        evidence["actualScanWindows"] = loop_counts
        evidence["loadedScanPlayback"] = True
        # Slow official-raster fixtures expose request bursts during rapid
        # scrubbing. Only two image loads and the latest desired scan may wait.
        await wait_for(frame, "window.cmpriWeatherMap.getState().rasterLoads === 0")
        fixture.radar_export_delay = .12
        exports_before_scrub = len(fixture.exports)
        scrub = await frame.evaluate("""() => {
          const range=document.getElementById('frameRange'), before=window.cmpriWeatherMap.getState();
          const target=Math.floor(before.frameCount/2);
          let peakLoads=0, peakQueue=0;
          const select=index => { range.value=String(index); range.dispatchEvent(new Event('input'));
            const state=window.cmpriWeatherMap.getState();
            peakLoads=Math.max(peakLoads,state.rasterLoads); peakQueue=Math.max(peakQueue,state.rasterQueue); };
          for(let n=0;n<80;n++) select(n%before.frameCount);
          select(target);
          return {target, peakLoads, peakQueue, previousScan:before.displayedScanTime,
            heldScan:window.cmpriWeatherMap.getState().displayedScanTime};
        }""")
        require(scrub["peakLoads"] <= 2 and scrub["peakQueue"] <= 1, "Rapid seek created an unbounded raster request queue")
        require(scrub["previousScan"] == scrub["heldScan"], "Seeking relabeled a previous image as an unloaded scan")
        await wait_for(frame, "target => {const s=window.cmpriWeatherMap.getState(); return s.displayedFrame===target && s.rasterLoads===0 && s.rasterQueue===0;}", scrub["target"])
        require(len(fixture.exports) - exports_before_scrub <= 6, "Rapid seek requested an export for every slider tick")
        require((await frame.evaluate("window.cmpriWeatherMap.getState()"))["imageCacheSize"] <= 36, "Radar image cache exceeded its bound")
        fixture.radar_export_delay = 0
        evidence["rapidScrub"] = {**scrub, "lastRequestedScanDisplayed": True,
            "exports": len(fixture.exports) - exports_before_scrub}
        evidence["gestures"] = [await anchored_zoom(page, frame, "pinch", True)] if width < 640 else [
            await anchored_zoom(page, frame, "wheel"), await anchored_zoom(page, frame, "double-click")]
        # Batch local zoom actions into one frame, avoiding a test-created
        # request storm, then verify native tile limits and explicit overzoom.
        await frame.locator("#recenter").click()
        await frame.evaluate("() => { for (let n=0;n<30;n++) document.getElementById('zoomIn').click(); }")
        await wait_for(frame, "window.cmpriWeatherMap.getState().zoom === 1024")
        await settled(frame)
        high = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(abs(high["center"]["lat"] - 40.138080) < 1e-8
                and abs(high["center"]["lon"] + 88.251416) < 1e-8,
                "Hotel-scale zoom lost the fixed property center")
        require(high["ground"]["tileZoom"] <= 16, "Ground map requested unsupported native detail")
        require(all(tile["z"] <= 16 for tile in fixture.basemap_requests), "Ground tile requests exceeded z16")
        evidence["hotelScaleOverzoom"] = {"zoom": high["zoom"], "nativeTileZoom": high["ground"]["tileZoom"],
                                         "requestedZoom": high["ground"]["requestedZoom"]}
        await page.screenshot(path=str(output / f"weather-ground-hotel-{width}.png"), full_page=True)
        # A not-yet-cached dataset at the new hotel-scale extent fails clearly,
        # and repeated redraws of identical failed keys must not retry/burst.
        fixture.basemap_fail_datasets.add("relief")
        await style(frame, "terrain")
        failed = await frame.evaluate("window.cmpriWeatherMap.getState().ground")
        require(failed["visibleFailed"] > 0 and any(word in (failed["status"] + failed["error"]).lower() for word in ["unavailable", "failed"]),
                "Failed ground tiles were not labeled unavailable")
        before_retry = len(fixture.basemap_requests)
        await frame.evaluate("() => { for (let n=0;n<8;n++) { const opacity=document.getElementById('mapOpacity'); opacity.value=String(40+n); opacity.dispatchEvent(new Event('input')); } }")
        await asyncio.sleep(.5)
        require(len(fixture.basemap_requests) == before_retry, "Failed tiles retried on each redraw")
        require(fixture.basemap_max_inflight <= 4, "Ground map exceeded four concurrent source requests")
        require(failed["cacheSize"] <= 150, "Ground LRU cache exceeded its bound")
        evidence["failureAndCache"] = {"visibleFailed": failed["visibleFailed"], "retryBurst": False,
            "maximumConcurrentRequests": fixture.basemap_max_inflight, "cacheSize": failed["cacheSize"]}
        # Keep new imagery tile requests pending while closing the native host.
        fixture.hold_basemap = True
        fixture.basemap_gate.clear()
        fixture.basemap_pending.clear()
        fixture.hold_map = True
        fixture.map_gate.clear()
        await frame.evaluate("""() => {
          const range=document.getElementById('frameRange');
          for(const index of [0,1,2]) {range.value=String(index);range.dispatchEvent(new Event('input'));}
        }""")
        await wait_for(frame, "() => {const s=window.cmpriWeatherMap.getState();return s.rasterLoads===2 && s.rasterQueue===1;}")
        await menu(frame, "mapBackgroundMenu", True)
        await frame.locator("#mapBackgroundStyle").select_option("aerial")
        await menu(frame, "mapBackgroundMenu", False)
        await asyncio.wait_for(fixture.basemap_pending.wait(), timeout=5)
        await frame.evaluate("""() => {
          const close = window.nwsLiveView.close;
          window.nwsLiveView.close = (...args) => { const result=close(...args);
            parent.__groundClosedState=window.cmpriWeatherMap.getState(); return result; };
        }""")
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="detached")
        closed = await page.evaluate("window.__groundClosedState")
        require(closed and closed["ground"]["pending"] == 0 and not closed["ground"]["opened"],
                "Ground tile requests survived native close")
        require(closed["rasterLoads"] == 0 and closed["rasterQueue"] == 0 and closed["pendingRequests"] == 0,
                "NOAA raster requests or queued scans survived native close")
        fixture.release()
        count_closed = len(fixture.basemap_requests)
        await asyncio.sleep(.25)
        require(len(fixture.basemap_requests) == count_closed, "Ground requested tiles after Weather closed")
        require(not errors and not externals and not await frame_forbidden(page), "Unexpected browser errors or external/permission activity")
        require(len(mutations) == mutation_start, "Map interaction caused an application mutation")
        evidence.update({"passed": True, "closeAbortsGroundRequests": True, "noBackgroundRequests": True,
                         "groundRequests": count_closed, "noRealDatabaseOrPush": True, "errors": errors})
        print(f"PASS actual dashboard ground map/gestures {width}×{height} (local fixtures)", flush=True)
        return evidence
    finally:
        fixture.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3116"))
    parser.add_argument("--output", default="/tmp/cmpri-weather-ground-review")
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
    (output / "weather-ground-report.json").write_text(json.dumps({"fixtureOnly": True,
        "liveFeedAvailabilityVerified": False, "results": results}, indent=2))
    require(all(row["passed"] for row in results), "Ground-map fixture acceptance failed; see " + str(output / "weather-ground-report.json"))


if __name__ == "__main__":
    asyncio.run(main())
