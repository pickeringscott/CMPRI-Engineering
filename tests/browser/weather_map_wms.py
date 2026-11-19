"""Verify activated WMS products in the native Weather window with local fixtures.

All application APIs and WebSockets are intercepted; external HTTP is blocked.
Metadata, map PNGs, and legend PNGs are explicit local fixtures in official
response shapes. This does not verify live NOAA/NCEP availability.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, frame_forbidden,
    install, install_weather_audit, require, wait_for, weather_frame,
)
from weather_map_basemaps import pixel, settled, style
from playwright.async_api import async_playwright


async def select_product(frame, value):
    details = frame.locator("#moreNoaaProducts")
    if not await details.evaluate("el => el.open"):
        await details.locator(":scope > summary").click()
    await frame.locator('#productTabs [data-layer="' + value + '"]').click()


async def wms_ready(frame, product):
    await wait_for(frame, """product => {
      const state=window.cmpriWeatherMap.getState(), wms=state.wms;
      return wms && wms.product===product && wms.time && wms.displayedTime===wms.time && wms.pending===0;
    }""", product)
    await wait_for(frame, "() => {const image=document.getElementById('mapWmsLegend'); return image && image.complete && image.naturalWidth > 0;}")
    await asyncio.sleep(.06)


async def run_viewport(browser, base, output, width, height):
    context = await browser.new_context(viewport={"width": width, "height": height},
        is_mobile=width < 640, has_touch=width < 640, service_workers="block", reduced_motion="reduce")
    await context.route_web_socket("**/*", block_websocket)
    fixture = OfficialFeedFixtures()
    context.on("requestfailed", fixture.request_failed)
    fixture.release()
    await install(context, "chief_engineer")
    await context.route("**/api/weather-preview**", fixture.route)
    errors, externals, mutations = [], [], []

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
    evidence = {"viewport": [width, height], "fixtureOnly": True, "products": []}
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.wait_for(state="visible", timeout=60000)
        mutation_start = len(mutations)
        await launcher.click()
        frame = await weather_frame(page)
        await install_weather_audit(frame)
        await settled(frame)
        await style(frame, "roads")
        for selected, product, name, advertised_style, color in [
            ("velocity", "velocity", "kilx_sr_bvel", "radar_velocity", [180, 65, 205]),
            ("ptype", "precipitation", "conus_pcpn_typ", "radar_precip_type", [85, 205, 225]),
        ]:
            before = await frame.evaluate("window.cmpriWeatherMap.getState()")
            legends_before = len([call for call in fixture.wms_requests if call["product"] == product and call["op"] == "legend"])
            fixture.wms_legend_delay = .8
            await select_product(frame, selected)
            await wait_for(frame, "name => {const w=window.cmpriWeatherMap.getState().wms;return w.layer===name && /Loading/.test(w.legendStatus);}", name)
            selected_state = await frame.evaluate("window.cmpriWeatherMap.getState()")
            require(selected_state["center"] == before["center"] and selected_state["zoom"] == before["zoom"],
                    "Selecting a WMS product moved the hotel viewport")
            await frame.locator("#radarCanvas").focus()
            for _ in range(6):
                await page.keyboard.press("ArrowRight")
            await wms_ready(frame, product)
            await settled(frame)
            require(len([call for call in fixture.wms_requests if call["product"] == product and call["op"] == "legend"]) - legends_before == 1,
                    "Rapid panning duplicated an in-flight official legend request")
            fixture.wms_legend_delay = 0
            state = await frame.evaluate("window.cmpriWeatherMap.getState()")
            wms = state["wms"]
            require(wms["layer"] == name and wms["style"] == advertised_style,
                    "Selected WMS map did not use its advertised layer and style")
            require(await frame.evaluate("values => Date.parse(values[0]) === Date.parse(values[1])",
                    [wms["time"], fixture.wms_metadata[product]["layers"][0]["time"]["values"].split(",")[-1]]),
                    "WMS map did not select the latest concrete advertised scan")
            for element in ["previousFrame", "playLoop", "nextFrame", "frameRange", "playbackSpeed", "loopLength"]:
                require(await frame.locator("#" + element).is_disabled(), "Reflectivity-only control remained enabled for WMS: " + element)
            stamp = await frame.evaluate("value => new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value))", wms["time"])
            require(stamp in await frame.locator("#scanTime").inner_text(), "WMS scan time was not rendered in Central")
            require("opengeo.ncep.noaa.gov" in wms["mapSource"] and "opengeo.ncep.noaa.gov" in wms["legendSource"],
                    "WMS map or legend provenance did not retain the official source")
            actual_pixel = await pixel(frame)
            alpha = (150 if product == "velocity" else 170) / 255 * state["opacity"]
            expected = [round([52, 101, 173][n] * (1 - alpha) + color[n] * alpha) for n in range(3)]
            require(max(abs(actual_pixel[n] - expected[n]) for n in range(3)) <= 4,
                    "WMS PNG was not composited over USGS geography: " + str(actual_pixel))
            map_calls = len([call for call in fixture.wms_requests if call["op"] == "map"])
            await frame.locator("#radarCanvas").focus()
            await page.keyboard.press("ArrowRight")
            await wait_for(frame, "before => window.cmpriWeatherMap.getState().center.lon !== before", state["center"]["lon"])
            await wait_for(frame, "() => window.cmpriWeatherMap.getState().wms.pending === 0")
            deadline = asyncio.get_running_loop().time() + 5
            while len([call for call in fixture.wms_requests if call["op"] == "map"]) <= map_calls:
                require(asyncio.get_running_loop().time() < deadline, "Panning did not request the WMS map at the new extent")
                await asyncio.sleep(.05)
            await wms_ready(frame, product)
            pan = await frame.evaluate("window.cmpriWeatherMap.getState()")
            await style(frame, "aerial")
            changed = await frame.evaluate("window.cmpriWeatherMap.getState()")
            require(changed["activeLayer"] == selected and changed["wms"]["time"] == wms["time"]
                    and changed["center"] == pan["center"], "Changing geographic style changed the selected WMS weather or hotel view")
            await style(frame, "roads")
            evidence["products"].append({"product": product, "layer": name, "style": advertised_style,
                "timeCentral": stamp, "mapPngDecoded": True, "legendPngDecoded": True,
                "preservedGeography": True, "panRequestsNewExtent": True,
                "legendRequestSharedDuringPan": True})
        await page.screenshot(path=str(output / f"weather-wms-{width}.png"), full_page=True)
        fixture.wms_modes["velocity"] = "stale"
        await select_product(frame, "velocity")
        await wms_ready(frame, "velocity")
        old_scan = await frame.evaluate("window.cmpriWeatherMap.getState().wms")
        old_scan_label = await frame.locator("#scanTime").inner_text()
        require(old_scan["displayedTime"] == old_scan["time"]
                and old_scan_label and any(zone in old_scan_label for zone in ["CST", "CDT"]),
                "Older published WMS data lost its actual Central scan time")
        require(not any(word in old_scan_label.lower() for word in ["loading", "buffer", "stale"]),
                "Playback replaced the actual observed scan time with a status label")
        fixture.wms_modes["precipitation"] = "unavailable"
        await select_product(frame, "ptype")
        await wait_for(frame, "() => {const w=window.cmpriWeatherMap.getState().wms;return w && /unavailable/i.test(w.status) && w.pending===0;}")
        await settled(frame)
        require(await frame.locator("#mapAttribution").is_visible()
                and "USGS" in await frame.locator("#mapAttribution").inner_text(),
                "A WMS failure removed the geographic background attribution")
        failed = await frame.evaluate("window.cmpriWeatherMap.getState().wms")
        require(not failed["displayedTime"], "An unavailable selected product retained another product's image time")
        unavailable_pixel = await pixel(frame)
        require(max(abs(unavailable_pixel[n] - [52, 101, 173][n]) for n in range(3)) <= 3,
                "An unavailable selected product retained a different product's weather pixels")
        fixture.wms_modes["velocity"] = "fresh"
        fixture.hold_wms = True
        fixture.wms_gate.clear()
        fixture.wms_pending.clear()
        await select_product(frame, "velocity")
        await asyncio.wait_for(fixture.wms_pending.wait(), timeout=5)
        await frame.evaluate("""() => {
          const close=window.nwsLiveView.close;
          window.nwsLiveView.close=(...args)=>{const result=close(...args);parent.__closedWms=window.cmpriWeatherMap.getState();return result;};
        }""")
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="detached")
        closed = await page.evaluate("window.__closedWms")
        require(closed["pendingRequests"] == 0 and closed["wms"]["pending"] == 0 and not closed["playing"],
                "Pending WMS requests or playback survived native close")
        fixture.release()
        calls = len(fixture.wms_requests)
        await asyncio.sleep(.2)
        require(len(fixture.wms_requests) == calls, "WMS fetched again after Weather closed")
        require(not errors and not externals and not await frame_forbidden(page), "Unexpected browser errors or external/permission activity")
        require(len(mutations) == mutation_start, "WMS controls caused application mutations")
        evidence.update({"passed": True, "olderObservedTimePreserved": old_scan_label, "unavailableLabeled": True,
            "nativeCloseAbortsWms": True, "noBackgroundRequests": True, "errors": errors})
        print(f"PASS actual dashboard WMS layers {width}×{height} (local fixtures)", flush=True)
        return evidence
    finally:
        fixture.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3116"))
    parser.add_argument("--output", default="/tmp/cmpri-weather-wms-review")
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
    (output / "weather-wms-report.json").write_text(json.dumps({"fixtureOnly": True,
        "liveFeedAvailabilityVerified": False, "results": results}, indent=2))
    require(all(row["passed"] for row in results), "WMS fixture acceptance failed; see " + str(output / "weather-wms-report.json"))


if __name__ == "__main__":
    asyncio.run(main())
