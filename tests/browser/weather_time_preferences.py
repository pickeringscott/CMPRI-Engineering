"""Verify live account clock changes in the Weather iframe with local fixtures."""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

from playwright.async_api import async_playwright

from weather_current_notices import context_for
from weather_dashboard_preview import OfficialFeedFixtures, wait_for, weather_frame


class LocalAssets(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


async def verify(base):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True, executable_path=os.environ.get("CHROMIUM_EXECUTABLE")
        )
        feed = OfficialFeedFixtures()
        feed.now = datetime(2026, 11, 25, 21, 40, tzinfo=timezone.utc)
        feed.scan_times = [int((feed.now - timedelta(minutes=minutes)).timestamp() * 1000) for minutes in [10, 5]]
        feed.release()
        context, page, errors, external, mutations = await context_for(browser, 1100, 800, feed)

        async def show_fixture(route):
            await route.fulfill(
                content_type="text/html",
                body='<iframe width="1080" height="760" title="Weather" '
                     'src="/previews/cmpri-weather-preview.html?embedded=1&amp;timeFormat=12h"></iframe>',
            )

        async def show_flights(route):
            await route.fulfill(json=feed.willard())

        try:
            await page.route("**/weather-time-preference-fixture", show_fixture)
            await page.route("**/api/willard-flights", show_flights)
            await page.route("**/api/willard-tracker**", feed.route)
            await page.route("**/api/willard-airport-layout**", feed.route)
            await page.goto(base + "/weather-time-preference-fixture")
            frame = await weather_frame(page)
            await wait_for(frame, "nwsLiveView.getState().resources.observation === 'live'")
            await wait_for(frame, "Boolean(document.querySelector('.wg-time'))")
            await frame.locator("#willardAirport > summary").click()
            await wait_for(frame, "weatherPreview.getState().airport.boardStatus === 'live'")
            await frame.evaluate("""() => {
              window.fixtureDocument = document;
              notificationPreview.receive(notificationPreview.sample('tornado-watch'));
            }""")
            fields = [frame.locator(selector).first for selector in [
                "#liveObservationTime", ".wg-time", ".wv-dial-clock",
                ".wa-flight-time", "[data-willard-clock]", "#npEffective",
            ]]
            # Every selected component here emits a Clock label. A 12-hour
            # rendering includes a day period even where minutes are omitted.
            for field in fields:
                label = await field.text_content()
                assert label and ("AM" in label or "PM" in label), label
            raw_flight_time = await fields[3].get_attribute("datetime")
            graph_time = await fields[1].get_attribute("data-time")
            await page.evaluate("""() => document.querySelector('iframe').contentWindow.postMessage(
              {type:'cmpri-time-format-updated',timeFormat:'24h'}, location.origin)""")
            await wait_for(frame, "weatherPreview.getState().airport.timeFormat === '24-hour'")
            for field in fields:
                label = await field.text_content()
                assert label and "AM" not in label and "PM" not in label, label
            assert await fields[3].get_attribute("datetime") == raw_flight_time
            assert await fields[1].get_attribute("data-time") == graph_time
            assert await frame.evaluate("() => fixtureDocument === document")
            assert not errors and not external and not mutations, (errors, external, mutations)
            print("Weather clock preference updated six rendered surfaces without reloading or changing source times.")
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    public = Path(__file__).resolve().parents[2] / "public"
    with ThreadingHTTPServer(("127.0.0.1", 0), partial(LocalAssets, directory=public)) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # The fixture date is in November Central Standard Time. The
            # browser still uses its full IANA zone for every clock label.
            with patch("weather_dashboard_preview.ZoneInfo", return_value=timezone(timedelta(hours=-6))):
                asyncio.run(verify(f"http://127.0.0.1:{server.server_port}"))
        finally:
            server.shutdown()
            thread.join()
