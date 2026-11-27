"""Weather language acceptance through the actual Profile save and desktop host.

Run against a local production preview build:
  python tests/browser/weather_spanish.py --base http://127.0.0.1:PORT

All API responses, including Profile PATCH acknowledgments, are local fixtures.
No real account, provider, database, permission prompt, push, or audio is used.
"""

import argparse
import asyncio
import copy
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from cmpri_fixture import UID, install
from playwright.async_api import async_playwright, expect
from weather_dashboard_preview import (OfficialFeedFixtures, PREVIEW, PROBE, block_websocket,
                                      dashboard_weather_launcher, unexpected_application_mutation,
                                      wait_for, weather_frame)


class SpanishFeedFixtures(OfficialFeedFixtures):
    def nws(self):
        payload = super().nws()
        resources = payload['resources']
        resources['observation']['data']['properties']['textDescription'] = 'Clear'
        for kind in ['hourly', 'forecast']:
            for period in resources[kind]['data']['properties']['periods']:
                period['shortForecast'] = 'Mostly Cloudy'
                # Deliberately use catalog keys as raw source wording. The test
                # proves the original source paragraphs are explicitly excluded.
                period['detailedForecast'] = 'Wind unavailable'
        alert = resources['alerts']['data']['features'][0]['properties']
        alert.update(event='Winter Storm Watch', headline='Current Conditions',
                     description='Hourly forecast', instruction='Extended forecast')
        if getattr(self, 'clear_alerts', False):
            resources['alerts']['data']['features'] = []
        return payload


async def run_viewport(browser, base, output, width, height):
    state = {
        'preferences': {'language': 'en', 'appearance': 'dark', 'notification_mode': 'in_app',
                        'notifications': {'new_work_orders': False, 'status_changes': False, 'mentions': False}},
        'writes': [], 'external': [], 'errors': [], 'weatherDocuments': 0,
    }
    context = await browser.new_context(viewport={'width': width, 'height': height},
                                        is_mobile=width < 640, has_touch=width < 640,
                                        service_workers='block', timezone_id='America/Chicago',
                                        reduced_motion='reduce')
    feed = SpanishFeedFixtures()
    feed.release()
    await install(context, 'chief_engineer')
    for pattern in ['**/api/weather-preview**', '**/api/willard-flights**',
                    '**/api/willard-tracker**', '**/api/willard-airport-layout**']:
        await context.route(pattern, feed.route)
    await context.route_web_socket('**/*', block_websocket)
    await context.add_init_script(PROBE)

    async def protect(route):
        request, url = route.request, urlparse(route.request.url)
        if url.hostname not in ['localhost', '127.0.0.1']:
            state['external'].append(request.url)
            return await route.abort('blockedbyclient')
        if url.path == PREVIEW:
            state['weatherDocuments'] += 1
        if url.path == '/api/profile':
            if request.method == 'PATCH':
                body = request.post_data_json
                assert 'role' not in body
                state['writes'].append({'path': url.path, 'method': request.method, 'body': body})
                state['preferences'] = copy.deepcopy(body['preferences'])
            else:
                assert request.method == 'GET'
            return await route.fulfill(json={
                'profile': {'id': UID, 'full_name': 'Fixture Engineer', 'email': 'fixture@example.invalid',
                            'role': 'chief_engineer'},
                'preferences': copy.deepcopy(state['preferences']),
                'profile_settings_available': True, 'can_manage_users': True, 'chatgpt_connection': None,
            })
        if unexpected_application_mutation(url.path, request.method):
            raise AssertionError('Unexpected fixture write: ' + url.path)
        return await route.fallback()

    await context.route('**/*', protect)
    context.on('requestfailed', feed.request_failed)
    page = await context.new_page()
    page.on('pageerror', lambda error: state['errors'].append(str(error)))

    async def menu_geometry():
        return await page.evaluate('''() => {
          const header=document.querySelector('header.cmpri-dashboard-titlebar');
          const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
          const ticker=document.querySelector('[data-weather-alert-ticker]');
          const actions=[...header.querySelectorAll('fieldset.group:not(.collapsed) .action')].map(box).filter(r=>r.width&&r.height);
          const legends=[...header.querySelectorAll('fieldset.group > legend')].map(box);
          const h=box(header),t=ticker?box(ticker):null;
          const hit=t?document.elementFromPoint(t.left+t.width/2,t.top+t.height/2):null;
          return {header:h,ticker:t,actions,legends,centerHitIsTicker:Boolean(hit?.closest('[data-weather-alert-ticker]')),
            rowOffset:actions.length?Math.min(...actions.map(r=>r.top))-h.bottom:null};
        }''')

    async def open_profile():
        account = page.locator('fieldset').filter(has=page.get_by_role('button', name=re.compile(r'^(Account|Cuenta)$')))
        tab = account.get_by_role('button', name=re.compile(r'^(Account|Cuenta)$'))
        if await tab.get_attribute('aria-expanded') != 'true' or await account.get_attribute('data-active') != 'true':
            await tab.click()
        await page.get_by_role('button', name=re.compile(r'^(Manage Profile|Administrar perfil)$')).click()
        locator = page.locator('iframe[src^="/profile?"]')
        await locator.wait_for(state='visible')
        frame = await (await locator.element_handle()).content_frame()
        await frame.get_by_role('button', name=re.compile(r'^(Save Profile|Guardar perfil)$')).wait_for(timeout=60000)
        return frame

    async def save_language(profile, language):
        select = profile.locator('select').filter(has=profile.locator('option[value="es"]')).first
        await select.select_option(language)
        # A local, unsaved Profile preview must not change the Weather document.
        current = state['preferences']['language']
        assert await frame.evaluate('document.documentElement.lang') == current
        await profile.get_by_role('button', name=re.compile(r'^(Save Profile|Guardar perfil)$')).click()
        await wait_for(page, 'expected => document.documentElement.lang === expected', language)
        await wait_for(frame, 'expected => document.documentElement.lang === expected', language)
        if language == 'es':
            await wait_for(frame, 'window.cmpriUiLanguage?.diagnostics().loaded === true')
        await page.locator('[data-cmpri-desktop-window="/profile"] [data-cmpri-window-close]').click()

    try:
        await page.goto(base + '/engineering', wait_until='domcontentloaded')
        launcher = await dashboard_weather_launcher(page)
        initial_menu = await menu_geometry()
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "document.querySelector('#liveConditionText')?.textContent === 'Clear'")
        await wait_for(frame, 'window.cmpriWeatherMap.getState().readyFrameCount > 0')
        await frame.evaluate("window.__spanishWeatherIdentity = 'same-cached-document'")
        await frame.locator('#mapLayerCloudCover').click()
        await wait_for(frame, 'window.cmpriWeatherMap.getState().wmsLayers.cloudCover.imageLoaded')
        await frame.locator('#mapOpacity').evaluate("input => { input.value = '37'; input.dispatchEvent(new Event('input', {bubbles: true})); }")
        await frame.locator('#zoomIn').click()
        before = await frame.evaluate('''() => { const state = cmpriWeatherMap.getState(); return {
            opacity: state.opacity, layers: state.layers, zoom: state.zoom, scan: state.displayedScanTime
        }; }''')
        documents = state['weatherDocuments']
        forecast_calls = feed.forecast_calls

        profile = await open_profile()
        await save_language(profile, 'es')
        await expect(frame.locator('#currentConditionsSection h2')).to_have_text('Condiciones actuales')
        await expect(frame.locator('.forecast-panel h2').nth(0)).to_have_text('Pronóstico por hora')
        await expect(frame.locator('.forecast-panel h2').nth(1)).to_have_text('Pronóstico extendido')
        await expect(frame.locator('#liveConditionText')).to_have_text('Despejado')
        await expect(frame.locator('#liveFeelsLike')).to_contain_text('Sensación térmica')
        await expect(frame.locator('#liveObservationTime')).to_contain_text('Actualizado:')
        await expect(frame.locator('#mapLayerRadar')).to_have_text('Reflectividad')
        await expect(frame.locator('#mapLayerCloudCover')).to_have_text('Nubosidad prevista')
        await expect(frame.locator('#mapLayerCloudCover')).to_have_attribute('title', re.compile('Porcentaje Previsto Por NWS NDFD'))
        await expect(frame.locator('#mapLayerRoads')).to_contain_text('no disponibles')
        await expect(frame.locator('#mapLayerImpacts')).to_have_text('Impactos invernales previstos')
        await expect(frame.locator('#playbackSpeed').locator('..')).to_contain_text('Velocidad del radar')
        await expect(frame.locator('#loopLength').locator('..')).to_contain_text('Bucle de observaciones')
        await expect(frame.locator('#recenter')).to_have_attribute('aria-label', 'Centrar en el hotel')
        await expect(frame.locator('#recenter')).to_have_attribute('title', 'Centrar En El Hotel')
        await expect(frame.locator('#liveAlertsHost h3')).to_have_text('Vigilancia de tormenta invernal')
        await expect(frame.locator('#liveAlertsHost')).to_contain_text('Vence:')
        await expect(frame.locator('#liveAlertsHost')).not_to_contain_text('Expires:')
        await expect(frame.locator('#liveAlertsHost [translate="no"]').nth(0)).to_have_text('Current Conditions')
        assert 'Wind unavailable' in await frame.locator('#extendedForecast [translate="no"]').first.text_content()

        ticker = page.locator('[data-weather-alert-ticker]')
        await expect(ticker).to_have_attribute('data-level', 'watch')
        await expect(ticker).to_contain_text('Vigilancia de tormenta invernal')
        await expect(ticker).to_contain_text('vence')
        active_menu = await menu_geometry()
        assert abs(active_menu['ticker']['top'] - active_menu['header']['bottom']) <= 1, active_menu
        assert abs(active_menu['ticker']['width'] - active_menu['header']['width']) <= 1, active_menu
        assert all(row['top'] >= active_menu['ticker']['bottom'] - 1 for row in active_menu['actions']), active_menu
        assert all(row['bottom'] <= active_menu['ticker']['top'] + 1 for row in active_menu['legends']), active_menu
        assert active_menu['centerHitIsTicker'], 'An anchored menu control masks the active weather ticker'
        await ticker.click()
        safety = page.locator('[data-weather-guest-safety-dialog]')
        await expect(safety).to_be_visible()
        await expect(safety.locator('h1')).to_have_text('Seguridad de los huéspedes')
        await expect(safety.locator('[data-weather-official-summary]')).to_have_text('Current Conditions')
        await expect(safety.locator('[data-weather-hotel-instruction]')).to_have_text('Revise las entradas y aceras y prepare el producto para derretir hielo.')
        await safety.locator('details summary').click()
        await expect(safety.locator('details p').nth(0)).to_have_text('Hourly forecast')
        await expect(safety.locator('details p').nth(1)).to_have_text('Extended forecast')
        await safety.locator('[data-weather-guest-safety-close]').click()
        await page.screenshot(path=str(output / f'weather-spanish-{width}.png'), full_page=True)

        after = await frame.evaluate('''() => { const state = cmpriWeatherMap.getState(); return {
            opacity: state.opacity, layers: state.layers, zoom: state.zoom, scan: state.displayedScanTime
        }; }''')
        assert after == before, 'Language save reset map selections, opacity, zoom or displayed scan'
        assert state['weatherDocuments'] == documents, 'Language save reloaded the Weather iframe'
        assert feed.forecast_calls == forecast_calls, 'Language save refetched cached forecast data'

        profile = await open_profile()
        await save_language(profile, 'en')
        await expect(frame.locator('#currentConditionsSection h2')).to_have_text('Current Conditions')
        await expect(frame.locator('.forecast-panel h2').nth(0)).to_have_text('Hourly forecast')
        await expect(frame.locator('.forecast-panel h2').nth(1)).to_have_text('Extended forecast')
        await expect(frame.locator('#liveConditionText')).to_have_text('Clear')
        await expect(frame.locator('#mapLayerCloudCover')).to_have_text('Forecast cloud cover')
        await expect(frame.locator('#recenter')).to_have_attribute('title', 'Recenter On Hotel')
        assert await frame.evaluate('window.__spanishWeatherIdentity') == 'same-cached-document'
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        await native.locator('[data-cmpri-window-close]').click()
        await expect(native).to_be_hidden()
        await (await dashboard_weather_launcher(page)).click()
        reopened = await weather_frame(page)
        assert await reopened.evaluate('window.__spanishWeatherIdentity') == 'same-cached-document'
        assert await reopened.evaluate('cmpriWeatherMap.getState().opacity') == before['opacity']
        assert state['weatherDocuments'] == documents
        assert feed.forecast_calls == forecast_calls
        assert [row['body']['preferences']['language'] for row in state['writes']] == ['es', 'en']
        # An authoritative fixture clear must remove only the temporary spacing,
        # without persisting a different tab layout or moving the title line.
        feed.clear_alerts = True
        await reopened.evaluate('() => { void nwsLiveView.refresh(); }')
        await wait_for(page, "document.querySelector('[data-weather-alert-ticker]') === null")
        restored_menu = await menu_geometry()
        assert abs(restored_menu['rowOffset'] - initial_menu['rowOffset']) <= 1, [initial_menu, restored_menu]
        assert not state['errors'], state['errors']
        assert not state['external'], state['external']
        for child in page.frames:
            assert not await child.evaluate('window.__weatherReviewForbidden || []')
        return {'viewport': [width, height], 'passed': True, 'fixtureOnly': True,
                'profileSaveLanguages': ['es', 'en'], 'weatherLabelsAndHazardsLocalized': True,
                'rawOfficialBulletinPreserved': True, 'mapControlsAndCachedDocumentPreserved': True,
                'tickerAndMenusRemainClickable': True, 'activeTickerGeometry': active_menu,
                'originalMenuOffsetRestoredAfterAlertClear': True,
                'externalRequests': 0, 'realDatabaseOrNotificationCalls': 0}
    except Exception:
        await page.screenshot(path=str(output / f'weather-spanish-failure-{width}.png'), full_page=True)
        raise
    finally:
        feed.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=os.environ.get('CMPRI_UI_BASE', 'http://127.0.0.1:3116'))
    parser.add_argument('--output', default='/tmp/cmpri-weather-spanish-review')
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
                    result = await run_viewport(browser, args.base.rstrip('/'), output, width, height)
                except Exception as error:
                    result = {'viewport': [width, height], 'passed': False, 'error': str(error), 'fixtureOnly': True}
                results.append(result)
                print(json.dumps(result), flush=True)
        finally:
            await browser.close()
    (output / 'weather-spanish-report.json').write_text(json.dumps({'results': results}, indent=2))
    assert all(result['passed'] for result in results), 'Weather Spanish browser checks failed; see ' + str(output)


if __name__ == '__main__':
    asyncio.run(main())
