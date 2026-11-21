"""Technician Weather/Willard cache acceptance for the combined dashboard.

All accounts and API responses are intercepted local fixtures. No real provider,
database, notification permission, push registration or audio is used.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from playwright.async_api import async_playwright, expect
from cmpri_fixture import install
from weather_dashboard_preview import (OfficialFeedFixtures, PREVIEW, PROBE, block_websocket,
                                      dashboard_weather_launcher, unexpected_application_mutation,
                                      wait_for, weather_frame)


class TechnicianFeedFixtures(OfficialFeedFixtures):
    warning = False

    def nws(self):
        payload = super().nws()
        alert = payload['resources']['alerts']['data']['features'][0]['properties']
        alert['event'] = 'Tornado Warning' if self.warning else 'Winter Storm Watch'
        alert['headline'] = 'TEST FIXTURE ' + alert['event'] + ' applies to property'
        return payload


async def run_case(browser, base, output, width, height):
    context = await browser.new_context(viewport={'width': width, 'height': height},
                                        is_mobile=width < 640, has_touch=width < 640,
                                        reduced_motion='reduce', service_workers='block')
    feed = TechnicianFeedFixtures()
    feed.release()
    errors, external, mutations = [], [], []
    documents = []
    await install(context, 'technician')
    await context.route_web_socket('**/*', block_websocket)
    await context.add_init_script(PROBE)
    for pattern in ['**/api/weather-preview**', '**/api/willard-flights**',
                    '**/api/willard-tracker**', '**/api/willard-airport-layout**']:
        await context.route(pattern, feed.route)

    async def protect(route):
        request, url = route.request, urlparse(route.request.url)
        if url.hostname not in ['localhost', '127.0.0.1']:
            external.append(request.url)
            return await route.abort('blockedbyclient')
        if url.path == PREVIEW:
            documents.append(request.url)
        if unexpected_application_mutation(url.path, request.method):
            mutations.append({'path': url.path, 'method': request.method})
        return await route.fallback()

    await context.route('**/*', protect)
    context.on('requestfailed', feed.request_failed)
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        await page.goto(base + '/technician', wait_until='domcontentloaded')
        launcher = await dashboard_weather_launcher(page)
        assert feed.forecast_calls == 0 and feed.willard_calls == 0 and feed.tracker_calls == 0
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "document.querySelector('#liveTemperature .wv-temperature-value')?.textContent === '64°'")
        await wait_for(frame, 'cmpriWeatherMap.getState().readyFrameCount > 0')
        assert 'clock=12' in frame.url
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        await expect(native).to_be_visible()
        assert await page.locator('[data-cmpri-technician-windows]').count() == 1
        await frame.evaluate("window.__technicianWeatherCache = 'retained-page-instance'")
        ticker = page.locator('[data-weather-alert-ticker]')
        await expect(ticker).to_have_attribute('data-level', 'watch')
        geometry = await page.evaluate('''() => {
          const ticker=document.querySelector('[data-weather-alert-ticker]'),t=ticker.getBoundingClientRect();
          const header=document.querySelector('header.cmpri-dashboard-titlebar'),h=header.getBoundingClientRect();
          const actions=[...header.querySelectorAll('fieldset.group:not(.collapsed) .action')].map(e=>e.getBoundingClientRect());
          const hit=document.elementFromPoint(t.left+t.width/2,t.top+t.height/2);
          return {flush:Math.abs(t.top-h.bottom)<=1,width:Math.abs(t.width-h.width)<=1,
            rowsClear:actions.every(r=>r.top>=t.bottom-1),clickable:Boolean(hit?.closest('[data-weather-alert-ticker]'))};
        }''')
        assert all(geometry.values()), geometry
        await ticker.click()
        safety = page.locator('[data-weather-guest-safety-dialog]')
        await expect(safety).to_be_visible()
        await expect(safety.locator('h2')).to_have_text('Winter Storm Watch')
        await safety.locator('[data-weather-guest-safety-close]').click()
        # Feed a changed official-response fixture through the real foreground
        # NWS request path; do not use the notification simulation shortcut.
        feed.warning = True
        await frame.evaluate('() => { void nwsLiveView.refresh(); }')
        await expect(safety).to_be_visible()
        await expect(safety).to_have_attribute('data-fullscreen', 'true')
        await expect(safety.locator('h2')).to_have_text('Tornado Warning')
        await expect(ticker).to_have_attribute('data-level', 'warning')
        await expect(safety.locator('[data-weather-hotel-instruction]')).to_contain_text('first-floor interior hallways')
        await safety.locator('[data-weather-guest-safety-close]').click()
        await frame.locator('#mapOpacity').evaluate("input => { input.value = '42'; input.dispatchEvent(new Event('input', {bubbles: true})); }")
        await frame.locator('#mapLayerCloudCover').click()
        await wait_for(frame, 'cmpriWeatherMap.getState().wmsLayers.cloudCover.imageLoaded')
        await frame.locator('#zoomIn').click()
        await frame.locator('#playLoop').click()
        await wait_for(frame, 'cmpriWeatherMap.getState().playing')
        airport = frame.locator('#willardAirport')
        assert feed.willard_calls == 0 and feed.tracker_calls == 0
        await airport.locator(':scope > summary').click()
        await wait_for(frame, "weatherPreview.getState().airport.trackerStatus === 'live' && weatherPreview.getState().airport.boardStatus === 'live'")
        await expect(airport.locator('[data-willard-board]')).to_have_attribute('data-time-format', '12h')
        await expect(airport.locator('[data-willard-arrivals] tbody')).to_contain_text('AA1234')
        await expect(airport.locator('[data-willard-departures] tbody')).to_contain_text('AA4321')
        assert await airport.locator('iframe').count() == 0
        await wait_for(frame, 'cmpriWeatherMap.getState().pendingRequests === 0 && nwsLiveView.getState().pendingRequests === 0')
        before = await frame.evaluate('''() => ({map: {
          zoom:cmpriWeatherMap.getState().zoom, opacity:cmpriWeatherMap.getState().opacity,
          layers:cmpriWeatherMap.getState().layers}, nws:nwsLiveView.getState().requests})''')
        counts = [feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls,
                  feed.astronomy_calls, feed.willard_calls]
        await native.locator('[data-cmpri-window-close]').click()
        await expect(native).to_be_hidden()
        await expect(ticker).to_be_visible()
        await expect(ticker).to_have_attribute('data-level', 'warning')
        await wait_for(frame, '''() => {const map=cmpriWeatherMap.getState(), airport=weatherPreview.getState().airport;
          return !map.opened && !map.active && !map.playing && !map.refresh.scheduled && map.pendingRequests===0 &&
            !nwsLiveView.getState().opened && nwsLiveView.getState().pendingRequests===0 &&
            !airport.trackerActive && !airport.clockRunning;}''')
        assert await page.locator('iframe[src*="' + PREVIEW + '"]').count() == 1
        await asyncio.sleep(.25)
        assert counts == [feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls,
                          feed.astronomy_calls, feed.willard_calls]
        await (await dashboard_weather_launcher(page)).click()
        reopened = await weather_frame(page)
        assert await reopened.evaluate('window.__technicianWeatherCache') == 'retained-page-instance'
        await wait_for(reopened, 'cmpriWeatherMap.getState().active && weatherPreview.getState().airport.trackerActive')
        after = await reopened.evaluate('''() => ({map: {
          zoom:cmpriWeatherMap.getState().zoom, opacity:cmpriWeatherMap.getState().opacity,
          layers:cmpriWeatherMap.getState().layers}, nws:nwsLiveView.getState().requests})''')
        assert after == before, 'Technician reopen reset map state or refetched NWS data'
        assert counts == [feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls,
                          feed.astronomy_calls, feed.willard_calls], 'Fresh cached weather or flight board was refetched'
        assert len(documents) == 1, 'Technician cached reopen created another Weather document'
        assert await native.count() == 1
        assert not await reopened.evaluate('cmpriWeatherMap.getState().playing'), 'Reopen resumed a dismissed playback timer'
        await expect(safety).to_be_hidden()
        assert await reopened.evaluate('nwsLiveView.getState().databaseCalls === 0 && !nwsLiveView.getState().scheduler && nwsLiveView.getState().pushes === 0')
        await page.screenshot(path=str(output / f'technician-weather-{width}.png'), full_page=True)
        assert not errors, errors
        assert not external, external
        assert not mutations, mutations
        for child in page.frames:
            assert not await child.evaluate('window.__weatherReviewForbidden || []')
        return {'viewport': [width, height], 'role': 'technician', 'passed': True, 'fixtureOnly': True,
                'actualSafetyLogsLauncher': True, 'nativeWeatherAndAirportBoard': True, 'roleClock12Hour': True,
                'officialWatchToWarningTickerAndSafetyTransition': True, 'activeTickerGeometry': geometry,
                'cachedReopenPreservesIframeMapAndForecast': True, 'closedTimersAndRequestsStop': True,
                'flightAccordionDefersReadsAndReusesFreshRows': True, 'realDatabaseOrNotificationCalls': 0}
    except Exception:
        await page.screenshot(path=str(output / f'technician-weather-failure-{width}.png'), full_page=True)
        raise
    finally:
        feed.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    parser.add_argument('--output', default='/tmp/cmpri-combined-technician-weather')
    args = parser.parse_args()
    assert urlparse(args.base).hostname in ['localhost', '127.0.0.1']
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True,
            executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), args=['--no-sandbox'])
        try:
            for width, height in [(1440, 1000), (390, 844)]:
                try:
                    result = await run_case(browser, args.base.rstrip('/'), output, width, height)
                except Exception as error:
                    result = {'viewport': [width, height], 'role': 'technician', 'passed': False,
                              'fixtureOnly': True, 'error': str(error)}
                results.append(result)
                print(json.dumps(result), flush=True)
        finally:
            await browser.close()
    (output / 'report.json').write_text(json.dumps({'results': results, 'fixtureOnly': True}, indent=2))
    assert all(result['passed'] for result in results), 'Technician Weather acceptance failed; see ' + str(output)


if __name__ == '__main__':
    asyncio.run(main())
