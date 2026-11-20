"""Current-observation priority and native weather-notice acceptance.

Run against a local VERCEL_ENV=preview build. Synthetic CMPRI accounts and every
API response are intercepted; external requests and WebSockets are blocked.
Weather values, ground pixels and alerts are explicit fixtures, never evidence
of current weather, actual NWS alerts, database persistence or push delivery.
"""
import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    API, PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, install,
    iso, require, wait_for, weather_frame,
)
from weather_map_basemaps import menu, settled
from playwright.async_api import async_playwright


class CurrentFixtures(OfficialFeedFixtures):
    def __init__(self):
        super().__init__()
        self.hold_observation = False
        self.hold_alerts = False
        self.observation_gate.set()
        self.alert_gate.set()
        self.hold_map = True
        self.wind_chill = -5
        self.gust = 28
        self.alert_features = []
        self.alert_failure = False
        self.observation_failure = False

    def alert(self, identity, event, *, action="Alert", expired=False):
        bulletin = API + "/alerts/urn:oid:TEST-FIXTURE-" + identity
        return {"type": "Feature", "id": bulletin, "geometry": None, "properties": {
            "id": bulletin, "status": "Actual", "messageType": action, "event": event,
            "headline": "TEST FIXTURE " + event + " applies to property",
            "areaDesc": "TEST FIXTURE Champaign County",
            "effective": iso(self.now - timedelta(minutes=5)),
            "expires": iso(self.now + timedelta(hours=-1 if expired else 2)),
            "description": "Explicit local fixture. No actual alert or push has been issued.",
            "instruction": "TEST FIXTURE official instructions."}}

    def nws(self):
        result = super().nws()
        observation = result["resources"]["observation"]
        observation["station"] = {"id": "KCMI", "name": "TEST FIXTURE Willard Airport",
                                  "distanceMeters": 11265}
        p = observation["data"]["properties"]
        p.update({"temperature": {"value": 10, "unitCode": "wmoUnit:degF"},
            "windChill": {"value": self.wind_chill, "unitCode": "wmoUnit:degF"},
            "heatIndex": {"value": None, "unitCode": "wmoUnit:degF"},
            "windSpeed": {"value": 18, "unitCode": "wmoUnit:mi_h-1"},
            "windGust": {"value": self.gust, "unitCode": "wmoUnit:mi_h-1"},
            "windDirection": {"value": 315, "unitCode": "wmoUnit:degree_(angle)"},
            "visibility": {"value": 9656.064, "unitCode": "wmoUnit:m"},
            "textDescription": "Mostly Cloudy"})
        if self.observation_failure:
            observation.update(status="unavailable", data=None, error="TEST FIXTURE current station unavailable")
        temperatures = [-15, 0, 15, 32, 50, 70, 90, 110, 10, 10, 42, 75]
        descriptions = ["Sunny", "Mostly Cloudy", "Rain", "Snow", "Thunderstorms", "Fog", "Windy", "Clear"]
        for kind in ["hourly", "forecast"]:
            for index, period in enumerate(result["resources"][kind]["data"]["properties"]["periods"]):
                period["temperature"] = temperatures[index % len(temperatures)]
                period["temperatureUnit"] = "F"
                period["shortForecast"] = descriptions[index % len(descriptions)]
        alerts = result["resources"]["alerts"]
        alerts["data"]["features"] = self.alert_features
        if self.alert_failure:
            alerts.update(status="unavailable", data=None, error="TEST FIXTURE alert source unavailable")
        return result


async def context_for(browser, width, height, feed):
    context = await browser.new_context(viewport={"width": width, "height": height},
        is_mobile=width < 640, has_touch=width < 640, service_workers="block", reduced_motion="reduce")
    await context.route_web_socket("**/*", block_websocket)
    errors, external, mutations = [], [], []
    await install(context, "chief_engineer")
    await context.route("**/api/weather-preview**", feed.route)
    context.on("requestfailed", feed.request_failed)
    async def protect(route):
        parsed = urlparse(route.request.url)
        if parsed.hostname not in ["127.0.0.1", "localhost"]:
            external.append(route.request.url)
            await route.abort("blockedbyclient")
            return
        if parsed.path.startswith("/api/") and route.request.method not in ["GET", "HEAD"]:
            mutations.append({"path": parsed.path, "method": route.request.method})
        await route.fallback()
    await context.route("**/*", protect)
    await context.add_init_script(PROBE)
    page = await context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    return context, page, errors, external, mutations


async def refresh(frame):
    await wait_for(frame, "!window.nwsLiveView.getState().loading")
    await frame.evaluate("() => { nwsLiveView.close(); void nwsLiveView.open(); }")
    await wait_for(frame, "!window.nwsLiveView.getState().loading")


async def observation_and_visuals(browser, base, output, width, height):
    feed = CurrentFixtures()
    context, page, errors, external, mutations = await context_for(browser, width, height, feed)
    evidence = {"viewport": [width, height], "fixtureOnly": True}
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.wait_for(state="visible", timeout=60000)
        require(feed.observation_calls == 0 and feed.forecast_calls == 0, "NWS requested before Weather opened")
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "document.getElementById('liveTemperature').textContent.includes('10°F')")
        require(feed.observation_calls == 1, "KCMI current observation was requested more than once on open")
        require(feed.hold_forecast and not feed.forecast_gate.is_set(), "Forecast gate unexpectedly released")
        require(await frame.locator("#hourlyForecast .forecast-card").count() == 0,
                "Forecast fixtures leaked into the fast observation response")
        require((await frame.evaluate("cmpriWeatherMap.getState().status.radar")) != "Observed image loaded",
                "Radar unexpectedly completed while deliberately held")
        require("KCMI" in await frame.locator("#liveConditionSource").inner_text(), "Current conditions lack explicit KCMI provenance")
        require("-5°F" in await frame.locator("#liveFeelsLike").inner_text(), "Observed negative wind chill missing")
        require("28 mph" in await frame.locator("#liveGusts").inner_text(), "Observed gust was omitted")
        require("18 mph" in await frame.locator("#liveWind").inner_text() and "NW" in await frame.locator("#liveWind").inner_text(),
                "Actual station wind units or FROM direction missing")
        observed = feed.now - timedelta(minutes=6)
        expected_clock = observed.astimezone(ZoneInfo("America/Chicago")).strftime("%H:%M")
        as_of = await frame.locator("#liveObservationTime").inner_text()
        require("As of" in as_of and expected_clock in as_of and not re.search(r"\b(?:AM|PM)\b", as_of),
                "As of does not use the actual observation timestamp in 24-hour Central time: " + as_of)
        heading = await frame.locator(".conditions-priority h2").bounding_box()
        clock = await frame.locator("#liveObservationTime").bounding_box()
        require(heading and clock and heading["y"] + heading["height"] - 1 <= clock["y"] <= heading["y"] + heading["height"] + 45,
                "As of is not immediately below the Current conditions heading")
        require(await frame.locator(".conditions-priority svg.wv-condition[role='img']").count() == 1,
                "Current condition has no accessible local weather symbol")
        require(await frame.locator("#liveTemperature .wv-temperature-dial").count() == 1,
                "Current observed temperature has no 24-hour dial while the forecast loads")
        require(await frame.locator("#liveTemperature .wv-dial-segment").count() == 0,
                "Current dial invented hourly colors before the held forecast arrived")
        require("forecast loading" in (await frame.locator("#liveTemperature .wv-dial-coverage").inner_text()).lower(),
                "The pending Current Conditions dial does not explain missing forecast hours")
        require(await frame.locator("#officialAlertsSection").is_hidden(), "Empty official-alert response left an empty alert section")
        await page.screenshot(path=str(output / f"current-before-forecasts-{width}.png"), full_page=True)
        evidence["observationBeforeHeldForecastAndRadar"] = {"station": "KCMI", "temperature": "10°F", "windChill": "-5°F", "gust": "28 mph", "asOf": as_of}
        feed.release()
        await wait_for(frame, "document.querySelectorAll('#hourlyForecast .forecast-card').length === 12")
        await wait_for(frame, "!nwsLiveView.getState().loading")
        records = await frame.evaluate("""() => Array.from(document.querySelectorAll('#hourlyForecast .wv-temperature')).map(el => ({
          value:el.dataset.airTemperature,min:el.dataset.scaleMin,max:el.dataset.scaleMax,color:el.dataset.temperatureColor,
          label:el.querySelector('.wv-temperature-value')?.textContent,
          gradient:getComputedStyle(el.querySelector('.wv-temperature-track')).backgroundImage,
          font:parseFloat(getComputedStyle(el.querySelector('.wv-temperature-value')).fontSize),
          markers:el.querySelectorAll('.wv-temperature-marker').length
        }))""")
        require(len(records) == 12, "Hourly forecast lost its existing temperature-card layout")
        require(all(row["min"] == "-15" and row["max"] == "110" for row in records), "Temperature scale changes between surfaces")
        known = [row for row in records if row["value"] != "unknown"]
        require(all("°F" in row["label"] and row["markers"] == 1 and row["font"] >= 16 for row in known),
                "Temperature numbers are missing, too small, or conveyed only by color")
        require(len({row["gradient"] for row in records}) == 1, "Temperature gradient differs between views")
        matching = [row for row in known if row["value"] == "10"]
        require(len(matching) >= 2 and len({row["color"] for row in matching}) == 1,
                "The same Fahrenheit temperature has different colors")
        stops = await frame.evaluate("cmpriWeatherVisuals.stops.map(stop => [stop.fahrenheit,stop.color])")
        expected_reference = {0: "#00e7e5", 15: "#7784fa", 25: "#c336ef", 32: "#e000ee",
            40: "#1700f5", 45: "#0065fb", 63: "#9bff54", 80: "#ffcc00", 85: "#ff8900", 106: "#e92b95"}
        require(all(dict(stops).get(value) == color for value, color in expected_reference.items()),
                "Temperature colors do not follow the fixed screenshot-reference palette")
        icons = await frame.locator("#hourlyForecast svg.wv-condition").evaluate_all("els=>els.map(el=>el.dataset.condition)")
        require(set(["sun", "cloud", "rain", "snow", "thunder", "fog", "wind"]).issubset(icons),
                "Actual forecast descriptions did not produce varied condition symbols")
        daily = frame.locator("#extendedForecast .daily-forecast-card")
        daily_count = await daily.count()
        require(daily_count >= 1 and await daily.locator(".wv-temperature-dial").count() == daily_count,
                "Every daily forecast must have its own 24-hour temperature dial")
        hourly_periods = feed.nws()["resources"]["hourly"]["data"]["properties"]["periods"]
        samples = {iso_value["startTime"]: iso_value for iso_value in hourly_periods}
        dials = await frame.locator(".wv-temperature-dial").evaluate_all("""elements => elements.map(element=>({
          day:element.dataset.day,coverage:element.dataset.coverage,hours:Number(element.dataset.coverageHours),
          expectedHours:Number(element.dataset.expectedHours),text:element.textContent,
          clockLabels:Array.from(element.querySelectorAll('.wv-dial-clock')).map(item=>item.textContent),
          segments:Array.from(element.querySelectorAll('.wv-dial-segment')).map(item=>({
            start:item.dataset.startTime,time:item.dataset.clockTime,value:Number(item.dataset.airTemperature),
            color:item.getAttribute('stroke'),actualColor:getComputedStyle(item).stroke})),
          extrema:Array.from(element.querySelectorAll('.wv-dial-extreme time')).map(item=>({
            kind:item.closest('.wv-dial-extreme').dataset.extreme,start:item.dateTime,label:item.textContent})),
          markers:element.querySelectorAll('.wv-dial-marker').length
        }))""")
        require(all(row["clockLabels"] == ["00", "06", "12", "18", "24"] for row in dials),
                "A dial does not retain its 24-hour chronological clock positions")
        require(any(row["coverage"] == "partial" for row in dials)
                and any(row["coverage"] == "unavailable" for row in dials),
                "Limited hourly guidance was stretched into complete daily timelines")
        for dial in dials:
            if dial["coverage"] == "unavailable":
                require(not dial["segments"] and not dial["markers"] and not dial["extrema"],
                        "An unavailable day invented temperature colors or high/low times")
                continue
            require(dial["hours"] < dial["expectedHours"] and "Partial" in dial["text"],
                    "A partly supplied day is missing its partial-coverage label")
            day_samples = [period for period in hourly_periods
                if datetime.fromisoformat(period["startTime"].replace("Z", "+00:00"))
                    .astimezone(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d") == dial["day"]]
            for extreme in dial["extrema"]:
                stamp = datetime.fromisoformat(extreme["start"].replace("Z", "+00:00"))
                normalized = stamp.isoformat(timespec="seconds").replace("+00:00", "Z")
                require(normalized in samples, "A dial high/low marker uses an invented forecast time")
                expected = max(day_samples, key=lambda period: period["temperature"]) if extreme["kind"] == "H" else min(day_samples, key=lambda period: period["temperature"])
                require(normalized == expected["startTime"], "A dial high/low marker does not match actual supplied hourly extrema")
                expected_clock = stamp.astimezone(ZoneInfo("America/Chicago")).strftime("%H:%M")
                require(expected_clock in extreme["label"] and not re.search(r"\b(?:AM|PM)\b", extreme["label"]),
                        "Dial high/low time is not actual 24-hour Central time")
            for segment in dial["segments"]:
                segment_time = datetime.fromisoformat(segment["start"].replace("Z", "+00:00"))
                supplied = [period for period in hourly_periods
                    if datetime.fromisoformat(period["startTime"].replace("Z", "+00:00")) <= segment_time
                    < datetime.fromisoformat(period["endTime"].replace("Z", "+00:00"))]
                require(supplied and segment["value"] == supplied[0]["temperature"],
                        "A dial segment invented temperatures in an unsupported forecast hour")
                require(re.match(r"^\d{2}:\d{2} (?:CST|CDT)$", segment["time"]), "Dial segment lacks a 24-hour Central time")
                color = await frame.evaluate("value=>cmpriWeatherVisuals.colorAt(value)", segment["value"])
                require(segment["color"] == color, "Dial and hourly temperature colors disagree")
                rgb = "rgb(" + ", ".join(str(int(color[offset:offset + 2], 16)) for offset in [1, 3, 5]) + ")"
                require(segment["actualColor"] == rgb, "The CMPRI theme overrode a hard-coded weather temperature color")
        theme_independent = await frame.evaluate("""() => {
          const signature=()=>Array.from(document.querySelectorAll('.wv-dial-segment')).map(el=>getComputedStyle(el).stroke).join('|');
          const before=signature(),root=document.documentElement;
          root.style.setProperty('--gold','#f0f'); root.style.setProperty('--brand','#fff'); root.style.setProperty('--muted','#000');
          const same=signature()===before;
          ['--gold','--brand','--muted'].forEach(name=>root.style.removeProperty(name)); return same;
        }""")
        require(theme_independent, "Theme palette variables change fixed weather temperatures")
        evidence["sharedTemperatureVisuals"] = {"hourlyCards": len(records), "dailyDials": daily_count,
            "referenceStops": stops, "numericValuesPreserved": True, "symbols": sorted(set(icons)),
            "hardCodedColorsIndependentOfTheme": theme_independent,
            "actualHourlyExtremaAndCentralTimes": True, "coverage": [{key: row[key] for key in ["day", "coverage", "hours", "expectedHours"]} for row in dials]}
        await frame.locator("#extendedForecast").scroll_into_view_if_needed()
        await page.screenshot(path=str(output / f"daily-temperature-dials-{width}.png"), full_page=True)
        await frame.locator("#hourlyForecast").scroll_into_view_if_needed()
        await page.screenshot(path=str(output / f"hourly-reference-palette-{width}.png"), full_page=True)
        await frame.evaluate("document.getElementById('windowBody').scrollTo(0,0)")
        feed.wind_chill = 0
        feed.gust = None
        await refresh(frame)
        require("0°F" in await frame.locator("#liveFeelsLike").inner_text(), "A valid zero-degree wind chill became unavailable")
        require(not re.search(r"\b0\s*mph\b", await frame.locator("#liveGusts").inner_text()), "Missing observed gust became zero")
        evidence["nullableObservationFields"] = {"zeroWindChillPreserved": True, "missingGustNotZero": True}
        feed.observation_failure = True
        await refresh(frame)
        require(await frame.locator("#liveTemperature .wv-temperature-value").get_attribute("data-air-temperature") == "unknown",
                "An unavailable station report retained an observed temperature")
        require(await frame.locator(".conditions-priority svg.wv-condition:not([data-condition='unknown'])").count() == 0,
                "An unavailable station report retained an observed weather-condition picture")
        require(not re.search(r"\b0\s*mph\b", await frame.locator("#liveWind").inner_text()),
                "Unavailable station wind became zero")
        feed.observation_failure = False
        evidence["missingObservationDoesNotUseForecastOrPicture"] = True
        feed.alert_failure = True
        await refresh(frame)
        require(await frame.locator("#officialAlertsSection").is_hidden(), "Failed alert request created an empty alert section")
        unavailable = await frame.locator("#liveAlertAvailability").inner_text()
        require(any(word in unavailable.lower() for word in ["unknown", "unavailable", "failed"]), "Failed alerts lack visible unknown status")
        require(not re.search(r"^\s*(?:all[ -]clear|no active)\b", unavailable, re.I),
                "Failure was presented as an affirmative all-clear")
        evidence["emptyOrFailedAlerts"] = {"emptySectionHidden": True, "failureUnknown": unavailable}
        feed.alert_failure = False
        cap_cancel = feed.alert("CAP-CANCEL", "Tornado Warning", action="Cancel")
        cap_cancel["properties"]["references"] = (
            "w-nws.webmaster@noaa.gov,urn:oid:TEST-FIXTURE-CAP-OLD," + iso(feed.now - timedelta(minutes=5)))
        feed.alert_features = [cap_cancel, feed.alert("CAP-OLD", "Tornado Warning"),
                               feed.alert("EXPIRED", "Winter Storm Watch", expired=True)]
        await refresh(frame)
        require(await frame.locator("#officialAlertsSection").is_hidden(), "Canceled or expired alerts remain active in the official section")
        evidence["capStringCancelBeforeOldFeature"] = True
        await frame.evaluate("document.getElementById('windowBody').scrollTo(0,0)")
        await page.screenshot(path=str(output / f"current-visuals-{width}.png"), full_page=True)
        evidence.update(passed=True, errors=errors, externalRequests=external, applicationMutations=mutations)
        require(not errors and not external and not mutations, "Unexpected script error, external request or mutation")
        require(await frame.evaluate("window.__weatherReviewForbidden.length === 0"), "GPS / push / permission API invoked")
        return evidence
    finally:
        feed.release()
        await context.close()


async def native_notices(browser, base, output, width, height):
    feed = CurrentFixtures()
    feed.release()
    context, page, errors, external, mutations = await context_for(browser, width, height, feed)
    evidence = {"viewport": [width, height], "fixtureOnly": True}
    native_selector = '[data-cmpri-desktop-window="' + PREVIEW + '"]'
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "!nwsLiveView.getState().loading")
        native = page.locator(native_selector)
        dialog = page.locator("[data-weather-guest-safety-dialog]")
        require(await dialog.is_hidden(), "An empty feed opened Guest Safety")
        feed.alert_features = [feed.alert("TORNADO", "Tornado Warning"),
            feed.alert("WATCH", "Severe Thunderstorm Watch"),
            feed.alert("WINTER", "Winter Weather Advisory"), feed.alert("HEAT", "Heat Advisory")]
        await refresh(frame)
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "true", "Official warning is not a full-screen native dialog")
        box = await dialog.bounding_box()
        require(box["width"] >= width * .95 and box["height"] >= height * .95, "Warning dialog does not cover the parent viewport")
        for quick_access in await dialog.get_by_role("button", name="Work orders", exact=True).all():
            require(not await quick_access.is_visible(), "An unrelated Work orders shortcut overlays Guest Safety")
        instruction = await dialog.locator("[data-weather-hotel-instruction]").inner_text()
        require("immediately" in instruction and "first-floor interior hallways" in instruction,
                "Tornado warning lost the immediate interior-hallway hotel action")
        require("TEST FIXTURE" in await dialog.locator("[data-weather-official-summary]").inner_text(),
                "Official summary was replaced by generic hotel instructions")
        require("SIMULATED GUEST SAFETY" not in await dialog.inner_text(), "An actual-shaped official alert was mislabeled as a simulated scenario")
        snapshot = await frame.evaluate("notificationPreview.snapshot()")
        official_history = [row for row in snapshot["inbox"] if not row["simulated"]]
        require(len(official_history) == 4, "Not all official watches, warnings and advisories entered in-app history")
        require(all(row["hotelInstruction"] and row["summary"] for row in official_history),
                "An official in-app message lacks its summary or hotel action")
        require(len(snapshot["alerts"]) == 4, "An applicable polygonless official alert was dropped")
        await page.screenshot(path=str(output / f"native-warning-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await dialog.wait_for(state="hidden")
        ticker = native.locator("[data-weather-alert-ticker]")
        await ticker.wait_for(state="visible")
        require(await ticker.get_attribute("data-level") == "warning", "Ticker did not use the most urgent active level")
        advisory = next(row for row in official_history if row["event"] == "Winter Weather Advisory")
        await frame.evaluate("key => notificationPreview.openDetails(key)", advisory["key"])
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "false",
                "An advisory used the full-screen warning presentation")
        await page.screenshot(path=str(output / f"native-advisory-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await frame.evaluate("document.getElementById('windowBody').scrollTo(0,0)")
        await page.screenshot(path=str(output / f"native-ticker-{width}.png"), full_page=True)

        async def ticker_geometry():
            result = await native.evaluate("""element => {
              const title=element.querySelector('.cmpri-desktop-titlebar'),ticker=element.querySelector('[data-weather-alert-ticker]');
              const a=title.getBoundingClientRect(),b=ticker.getBoundingClientRect(),n=element.getBoundingClientRect();
              return {direct:title.nextElementSibling===ticker,gap:b.top-a.bottom,left:b.left-n.left,right:n.right-b.right,width:b.width};
            }""")
            require(result["direct"] and abs(result["gap"]) <= 1.5, "Ticker is not flush immediately under the native titlebar")
            require(result["left"] <= 2 and result["right"] <= 2, "Ticker no longer spans its native window")
            return result

        first_ticker = await ticker_geometry()
        await page.emulate_media(reduced_motion="no-preference")
        await asyncio.sleep(.08)
        track = ticker.locator(":scope > span")
        x_before = (await track.bounding_box())["x"]
        await asyncio.sleep(.3)
        x_after = (await track.bounding_box())["x"]
        await page.emulate_media(reduced_motion="reduce")
        require(x_after > x_before + 1, "The actual alert ticker does not move left to right")
        evidence["tickerLeftToRight"] = {"beforeX": x_before, "afterX": x_after}
        if width >= 640:
            edge = native.locator(".cmpri-desktop-resize-se")
            point = await edge.bounding_box()
            before = await native.bounding_box()
            await page.mouse.move(point["x"] + point["width"] / 2, point["y"] + point["height"] / 2)
            await page.mouse.down()
            await page.mouse.move(point["x"] - 110, point["y"] - 70, steps=8)
            await page.mouse.up()
            after = await native.bounding_box()
            require(after["width"] < before["width"] - 50, "Native window resize did not occur")
            await ticker_geometry()
        await ticker.click()
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "true", "Ticker did not reopen current warning details")
        await dialog.locator("[data-weather-guest-safety-close]").click()
        count_before = len((await frame.evaluate("notificationPreview.snapshot()"))["inbox"])
        await refresh(frame)
        require(await dialog.is_hidden(), "Unchanged official response reopened dismissed warning details")
        require(len((await frame.evaluate("notificationPreview.snapshot()"))["inbox"]) == count_before,
                "Unchanged official response duplicated in-app messages")
        feed.alert_failure = True
        await refresh(frame)
        require(await ticker.is_visible(), "An unavailable alert response cleared the last known active warning")
        require(await dialog.is_hidden(), "An unavailable response reopened warning details")
        feed.alert_failure = False
        await refresh(frame)
        require(await dialog.is_hidden(), "Restoring unchanged official data reopened a dismissed warning")
        evidence["officialInAppAndTicker"] = {"messages": count_before, "unknownDoesNotClear": True,
            "noDuplicateOrReopen": True, "flushGeometry": first_ticker}
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="detached")
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "!nwsLiveView.getState().loading")
        native = page.locator(native_selector)
        dialog = page.locator("[data-weather-guest-safety-dialog]")
        ticker = native.locator("[data-weather-alert-ticker]")
        await ticker.wait_for(state="visible")
        require(await dialog.is_hidden(), "Closing/reopening Weather forgot warning dismissal")
        await ticker_geometry()
        evidence["dismissalSurvivesNativeReopen"] = True
        canceled = feed.alert("CANCEL-TORNADO", "Tornado Warning", action="Cancel")
        canceled["properties"]["references"] = (
            "w-nws.webmaster@noaa.gov,urn:oid:TEST-FIXTURE-TORNADO," + iso(feed.now - timedelta(minutes=5)))
        feed.alert_features = [canceled, feed.alert("TORNADO", "Tornado Warning"),
                               feed.alert("WATCH", "Severe Thunderstorm Watch")]
        await refresh(frame)
        await wait_for(page, "document.querySelector('[data-weather-alert-ticker]')?.dataset.level === 'watch'")
        require(await ticker.get_attribute("data-level") == "watch", "Canceling warning did not leave a watch ticker")
        await ticker.click()
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "false", "A watch used full-screen warning presentation")
        if width >= 640:
            require((await dialog.bounding_box())["width"] < width * .8, "Watch details are not a standard compact native dialog")
        await page.screenshot(path=str(output / f"native-watch-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        ending_watch = feed.alert("WATCH", "Severe Thunderstorm Watch")
        ending_watch["properties"]["ends"] = iso(feed.now - timedelta(minutes=1))
        feed.alert_features = [ending_watch]
        await refresh(frame)
        require(await native.locator("[data-weather-alert-ticker]").count() == 0,
                "Official early end time did not remove a watch before bulletin expiration")
        ended = [row for row in (await frame.evaluate("notificationPreview.snapshot()"))["inbox"]
                 if row["status"] == "ended"]
        require(ended and any(row["expires"] > int(feed.now.timestamp() * 1000) for row in ended),
                "Early end cleanup overwrote the official future expiration time")
        feed.alert_features = [feed.alert("WATCH", "Severe Thunderstorm Watch", expired=True)]
        await refresh(frame)
        require(await native.locator("[data-weather-alert-ticker]").count() == 0, "Expired watch remained in the ticker")
        require(await dialog.is_hidden(), "Expired official alert left details open")
        require(len((await frame.evaluate("notificationPreview.snapshot()"))["alerts"]) == 0, "Canceled/expired alerts remained active")
        evidence["cancelAndExpire"] = {"warningToWatch": True, "watchUsesStandardDialog": True,
            "earlyEndsPreservesOfficialExpires": True, "expiredRemoved": True}
        await frame.locator("#tab-notifications").click()
        require(await frame.locator("#npDelivery").count() == 0, "Phone/email delivery control returned to the in-app-only preview")
        await frame.locator("#npWinterPrep").check()
        await frame.locator("#npScenario").select_option("freeze-risk")
        await frame.locator("#npReceive").click()
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "true", "Agreed forecast-freeze example is not full-screen")
        freeze = (await dialog.locator("[data-weather-hotel-instruction]").inner_text()).lower()
        require("boiler room" in freeze and "ice melt" in freeze and "available staff" in freeze and "treat sidewalks" in freeze,
                "Freeze preparation lost the agreed supplies/staff hotel instruction")
        require("SIMULATED" in await dialog.inner_text(), "Forecast-freeze example is not clearly simulated")
        await page.screenshot(path=str(output / f"native-freeze-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await frame.locator("#npRepeat").click()
        require(await dialog.is_hidden(), "Unchanged freeze example reopened dismissed details")
        await frame.locator("#npCancel").click()
        require(len((await frame.evaluate("notificationPreview.snapshot()"))["alerts"]) == 0, "Canceled freeze sample remained active")
        await frame.locator("#npScenario").select_option("tornado-warning")
        await frame.locator("#npReceive").click()
        await dialog.wait_for(state="visible")
        await frame.evaluate("notificationPreview.advanceSimulation(61)")
        await dialog.wait_for(state="hidden")
        require(await native.locator("[data-weather-alert-ticker]").count() == 0, "Expired warning sample retained its ticker")
        evidence["freezeAndSampleExpiry"] = {"fullScreenClearlySimulated": True, "correctSuppliesAndStaff": True,
                                             "repeatDismissed": True, "cancelAndExpiryClose": True}
        await frame.locator("#npReset").click()
        await frame.locator("#tab-weather").click()
        feed.alert_features = [feed.alert("MULTI-TORNADO", "Tornado Warning"),
                               feed.alert("MULTI-SEVERE", "Severe Thunderstorm Warning")]
        await refresh(frame)
        await dialog.wait_for(state="visible")
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await refresh(frame)
        require(await dialog.is_hidden(), "A second unchanged warning in the batch reopened dismissed details")
        evidence["multipleWarningBatchDedup"] = True
        require(not errors and not external and not mutations, "Unexpected native script error, external request or mutation")
        require(await page.evaluate("window.__weatherReviewForbidden.length===0")
                and await frame.evaluate("window.__weatherReviewForbidden.length===0"), "Native notices invoked GPS / push permissions")
        evidence.update(passed=True, errors=errors, externalRequests=external, applicationMutations=mutations)
        return evidence
    finally:
        feed.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--output", default="/tmp/cmpri-weather-current-notices")
    parser.add_argument("--suite", choices=["current", "notices", "all"], default="all")
    args = parser.parse_args()
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"),
                                          headless=True, args=["--no-sandbox"])
        suites = [("current", observation_and_visuals), ("notices", native_notices)]
        for width, height in [(1440, 1000), (390, 844)]:
            for name, action in suites:
                if args.suite not in ["all", name]:
                    continue
                try:
                    result = await action(browser, args.base, output, width, height)
                    print(f"PASS {name} {width}×{height}", flush=True)
                except Exception as error:
                    result = {"viewport": [width, height], "passed": False, "error": str(error)}
                    print(f"FAIL {name} {width}×{height}: {error}", flush=True)
                result["suite"] = name
                results.append(result)
        await browser.close()
    (output / "report.json").write_text(json.dumps(results, indent=2))
    if any(not result.get("passed") for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
