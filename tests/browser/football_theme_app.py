"""Local shared football-theme regression with synthetic authenticated API data.

Run the app on localhost using CI public placeholders, then run:
  CMPRI_UI_BASE=http://localhost:3120 python tests/browser/football_theme_app.py
Next development hydration uses its HMR debug channel, so localhost must match
its permitted dev origin. Production checks can use either loopback hostname.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

os.environ.setdefault('CMPRI_UI_BASE', 'http://localhost:3120')
os.environ.setdefault('CMPRI_UI_OUTPUT', 'work/football-theme-app')
from cmpri_fixture import BASE, install
from playwright.async_api import Error, async_playwright, expect

OUT = Path(os.environ['CMPRI_UI_OUTPUT'])
OUT.mkdir(parents=True, exist_ok=True)
FRAME = 'iframe[title="Illinois versus Iowa football background"]'
CONTROL = '.cmpri-football-animation-control'
BETTING_API = '/api/football-betting-line'
FIXTURE_LINE = 'IOWA -7.5'
GEOMETRY = """() => {
 const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
 const score=document.querySelector('#cmpriScorebug');
 return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
   field:box('.field-surface'),stage:box('.stage'),scorebug:box('#cmpriScorebug'),
   fieldTransform:getComputedStyle(document.querySelector('.field-surface')).transform,
   scoreTransform:getComputedStyle(score).transform,scoreBottom:getComputedStyle(score).bottom,
   classes:document.body.className,version:window.cmpriTheme.version,
   fans:window.cmpriTheme.fans,capacity:window.cmpriTheme.capacity,
   illinois:window.cmpriTheme.illinoisFans,iowa:window.cmpriTheme.iowaFans,
   sidelines:window.cmpriTheme.sidelinePeople};
}"""

async def verify_score_anchor(page, child, role, width, height):
    """Measure the W-L strip without relocating the simulated scoreboard."""
    measurements = []

    async def measure(state):
        for _ in range(40):
            header = await page.locator('.cmpri-desktop-topbar:visible').first.bounding_box()
            score = await child.locator('#cmpriScorebug').bounding_box()
            stage = await child.locator('.stage').bounding_box()
            tally = await child.locator('.sim-tally').bounding_box()
            assert header and score and stage and tally, (state, header, score, stage, tally)
            gaps = {
                'scoreStageGap': stage['y'] + stage['height'] - score['y'] - score['height'],
                'tallyGap': tally['y'] - header['y'] - header['height'],
                'tallyRightMargin': header['x'] + header['width'] - tally['x'] - tally['width'],
            }
            if all(abs(gaps[key] - target) <= 1 for key, target in (
                ('scoreStageGap', 10), ('tallyGap', 4), ('tallyRightMargin', 8),
            )):
                break
            await page.wait_for_timeout(50)
        assert abs(gaps['scoreStageGap'] - 10) <= 1, (state, stage, score, gaps)
        assert abs(gaps['tallyGap'] - 4) <= 1, (state, header, tally, gaps)
        assert abs(gaps['tallyRightMargin'] - 8) <= 1, (state, header, tally, gaps)
        assert score['x'] >= 0 and tally['x'] >= 0, (state, score, tally)
        row = await child.locator('.sim-betting-line').bounding_box()
        record = await child.locator('.sim-tally-record').bounding_box()
        assert row and record, (state, row, record)
        assert row['y'] >= record['y'] + record['height'] - 1, (state, record, row)
        assert row['x'] >= tally['x'] - 1 and row['x'] + row['width'] <= tally['x'] + tally['width'] + 1, (state, tally, row)
        assert row['y'] + row['height'] <= tally['y'] + tally['height'] + 1, (state, tally, row)
        screenshot = OUT / f'engineering-{role}-{width}-{state}.png'
        await page.screenshot(path=str(screenshot), full_page=True)
        measurement = {'state': state, 'role': role, 'viewport': page.viewport_size,
                       'header': header, 'scorebug': score, 'stage': stage, 'tally': tally, 'bettingRow': row,
                       **gaps, 'screenshot': str(screenshot)}
        measurements.append(measurement)
        return measurement

    initial = await measure('expanded')
    groups = page.locator('.cmpri-desktop-topbar fieldset.group:visible')
    if await groups.count():
        toggle = groups.first.locator('legend')
        await toggle.click()
        collapsed = await measure('group-collapsed')
        assert collapsed['header']['height'] < initial['header']['height'], (initial, collapsed)
        await toggle.click()
        await measure('group-expanded')
    else:
        # The separate menu PR uses anchored tabs instead of fieldset legends.
        # Exercise its actual overlay without assuming it changes header height.
        toggle = page.locator('nav.cmpri-dashboard-menu-rail').get_by_role('button', name='Daily Work', exact=True)
        await toggle.click()
        await measure('tab-opened')
        await toggle.click()
        await measure('tab-closed')
    await page.set_viewport_size({'width': width - 160, 'height': height})
    await measure('resized')
    await page.set_viewport_size({'width': width, 'height': height})
    await measure('restored')
    return measurements


async def verify_case(browser, authenticated, width, height, reduced_motion=False, role='chief_engineer'):
    errors, failures, external = [], [], []
    betting_requests, betting_hold = [], {'next': False}
    betting_pending, betting_release = asyncio.Event(), asyncio.Event()
    context = await browser.new_context(
        viewport={'width': width, 'height': height},
        is_mobile=width < 640, has_touch=width < 640,
        reduced_motion='reduce' if reduced_motion else 'no-preference',
    )
    if authenticated:
        await install(context, role)
    else:
        async def route(request):
            if urlparse(request.request.url).hostname not in ('localhost', '127.0.0.1'):
                external.append(request.request.url)
                return await request.abort()
            return await request.continue_()
        await context.route('**/*', route)
    # This is synthetic provider data. It verifies rendering/lifecycle without
    # querying ESPN, Supabase or any external sportsbook.
    async def betting_fixture(route):
        request = route.request
        assert request.method == 'GET', request.method
        assert urlparse(request.url).hostname in ('localhost', '127.0.0.1'), request.url
        held = betting_hold['next']
        betting_hold['next'] = False
        betting_requests.append({'method': request.method, 'held': held})
        if held:
            betting_pending.set()
            await asyncio.wait_for(betting_release.wait(), timeout=10)
        payload = {'status': 'available', 'line': FIXTURE_LINE, 'provider': 'Fixture Sportsbook',
                   'retrievedAt': datetime.now(timezone.utc).isoformat(), 'sourceUpdatedAt': None,
                   'event': {'id': 'fixture-iowa-illinois', 'date': '2026-11-21T17:00:00Z',
                             'state': 'pre', 'away': 'Iowa', 'home': 'Illinois'},
                   'sourceUrl': 'https://www.espn.com/college-football/game/_/gameId/401858527', 'error': None}
        try:
            await route.fulfill(content_type='application/json', body=json.dumps(payload))
        except Error:
            if not held:
                raise
            # The held response is deliberately canceled by hiding its host.
    await context.route('**/api/football-betting-line*', betting_fixture)
    await context.add_init_script('''(() => {
      const fetch=window.fetch, now=Date.now.bind(Date);
      window.__bettingClockOffset=0;
      window.__bettingFetchAudit={started:0,aborted:0};
      Date.now=()=>now()+window.__bettingClockOffset;
      window.fetch=function(input,init){
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        if(url.pathname==='/api/football-betting-line'){
          window.__bettingFetchAudit.started++;
          init?.signal?.addEventListener('abort',()=>window.__bettingFetchAudit.aborted++,{once:true});
        }
        return fetch.call(this,input,init);
      };
    })();''')
    async def deny_external_socket(socket):
        await socket.close()
    await context.route_web_socket('wss://**', deny_external_socket)
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('response', lambda response: failures.append({'status': response.status, 'url': response.url})
            if response.status >= 400 and urlparse(response.url).hostname in ('localhost', '127.0.0.1') else None)
    path = '/engineering' if authenticated else '/'
    await page.goto(BASE + path, wait_until='domcontentloaded')
    control = page.locator(CONTROL)
    await expect(control).to_be_enabled(timeout=60000)
    await expect(control).to_be_visible()
    if authenticated:
        await page.locator('.cmpri-desktop-root').wait_for()
    else:
        await expect(page.get_by_role('button', name='Continue with Google', exact=True)).to_be_enabled()
    assert await page.locator(FRAME).count() == 1
    assert await page.locator('iframe').count() == 1
    element = await page.locator(FRAME).element_handle()
    child = await element.content_frame()
    await child.wait_for_function('window.cmpriTheme?.action && window.cmpriTheme?.game')
    geometry = await child.evaluate(GEOMETRY)
    assert geometry['version'] == '9.0', geometry
    assert (geometry['fans'], geometry['capacity'], geometry['illinois'], geometry['iowa'], geometry['sidelines']) == (60670, 60670, 33369, 27301, 410)
    assert 'cmpri-embedded' in geometry['classes'] and 'ambient' in geometry['classes']
    assert geometry['scrollWidth'] <= width + 1, geometry
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    if width < 768:
        assert geometry['field']['height'] > geometry['field']['width'], geometry
        assert geometry['fieldTransform'].startswith('matrix(0, 1, -1, 0,'), geometry
        assert abs(height - geometry['scorebug']['bottom'] - 6) <= 1, geometry
        assert geometry['scoreBottom'] == '6px', geometry
        assert geometry['scoreTransform'].startswith('matrix(1, 0, 0, 1,'), geometry
        assert abs((geometry['scorebug']['left'] + geometry['scorebug']['right']) / 2 - width / 2) <= 1, geometry
        control_box = await control.bounding_box()
        assert control_box['y'] + control_box['height'] < geometry['scorebug']['top'], (control_box, geometry)
    else:
        assert geometry['fieldTransform'] == 'none', geometry
        assert abs(geometry['stage']['bottom'] - geometry['scorebug']['bottom'] - 10) <= 1, geometry
    assert geometry['scorebug']['left'] >= -1 and geometry['scorebug']['right'] <= width + 1
    betting_row = child.locator('.sim-betting-line')
    betting_line = child.locator('#liveBettingLine')
    wants_betting = authenticated and width >= 768
    if wants_betting:
        await expect(betting_row).to_have_attribute('data-state', 'available')
        await expect(betting_line).to_have_text(FIXTURE_LINE)
        assert 'Fixture Sportsbook' in await betting_row.get_attribute('title')
        assert len(betting_requests) == 1, betting_requests
    else:
        await expect(betting_row).to_be_hidden()
        assert not betting_requests, betting_requests
    anchors = await verify_score_anchor(page, child, role, width, height) if authenticated and width >= 768 else []
    screenshot = OUT / f'{"engineering-" + role if authenticated else "sign-in"}-{width}{"-reduced" if reduced_motion else ""}.png'
    await page.screenshot(path=str(screenshot), full_page=True)

    # Use the actual parent control and prove it changes the child's game clock.
    if reduced_motion:
        await expect(control).to_have_attribute('aria-pressed', 'true')
    else:
        await expect(control).to_have_attribute('aria-pressed', 'false')
        await control.click()
        await expect(control).to_have_attribute('aria-pressed', 'true')
    await page.wait_for_timeout(100)
    paused_time = await child.evaluate('window.cmpriTheme.action.time')
    await page.wait_for_timeout(450)
    assert await child.evaluate('window.cmpriTheme.action.time') == paused_time
    await control.click()
    await expect(control).to_have_attribute('aria-pressed', 'false')
    await child.wait_for_function('(time) => window.cmpriTheme.action.time !== time', arg=paused_time, timeout=5000)

    # Native history transitions are supported by the Next router. They exercise
    # usePathname visibility without remounting the persistent artwork iframe.
    # Dashboard actions use modal buttons; no client Link leaves this surface.
    await child.evaluate('window.__footballIdentity="persistent-frame"')
    abort_checked = wants_betting and role == 'chief_engineer'
    if abort_checked:
        betting_hold['next'] = True
        # Advance only this iframe's wall clock past the foreground interval.
        # The real resize event exercises the normal active-host refresh path.
        await child.evaluate("() => {window.__bettingClockOffset=61000;dispatchEvent(new Event('resize'));}")
        await asyncio.wait_for(betting_pending.wait(), timeout=5)
    await page.evaluate('history.pushState(null, "", "/profile")')
    await expect(control).to_be_hidden()
    if abort_checked:
        await child.wait_for_function('window.__bettingFetchAudit.aborted >= 1', timeout=5000)
    hidden_requests = len(betting_requests)
    await child.evaluate("() => {window.__bettingClockOffset=121000;dispatchEvent(new Event('resize'));}")
    await page.wait_for_timeout(100)
    suspended_time = await child.evaluate('window.cmpriTheme.action.time')
    await page.wait_for_timeout(450)
    assert await child.evaluate('window.cmpriTheme.action.time') == suspended_time
    assert len(betting_requests) == hidden_requests, betting_requests
    assert await page.locator(FRAME).count() == 1
    await child.evaluate('window.__bettingClockOffset=0')
    betting_release.set()
    await page.evaluate('(path) => history.pushState(null, "", path)', path)
    await expect(control).to_be_visible()
    assert await child.evaluate('window.__footballIdentity') == 'persistent-frame'
    await child.wait_for_function('(time) => window.cmpriTheme.action.time !== time', arg=suspended_time, timeout=5000)
    if wants_betting:
        await expect(betting_row).to_have_attribute('data-state', 'available')
        await expect(betting_line).to_have_text(FIXTURE_LINE)
    else:
        assert not betting_requests, betting_requests
    assert not errors, errors
    assert not failures, failures
    result = {'route': path, 'role': role if authenticated else None,
              'width': width, 'height': height, 'reducedMotion': reduced_motion,
              'scoreAnchorStates': anchors,
              'betting': {'fixtureOnly': True, 'liveFeedAvailabilityVerified': False,
                          'fixtureLine': FIXTURE_LINE, 'requests': betting_requests,
                          'noRequestsWithoutDesktopAnchor': not wants_betting and not betting_requests,
                          'hiddenHostStopsRequests': True, 'inFlightAbortChecked': abort_checked,
                          'fetchAudit': await child.evaluate('window.__bettingFetchAudit')},
              'passed': True, 'geometry': geometry, 'pageErrors': errors,
              'localHttpErrors': failures, 'blockedExternalRequests': external, 'screenshot': str(screenshot)}
    print(json.dumps(result), flush=True)
    await context.close()
    return result

async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        results = []
        for authenticated in (False, True):
            for width, height in ((1440, 1000), (390, 844), (320, 700)):
                results.append(await verify_case(browser, authenticated, width, height))
        for width, height in ((1440, 1000), (390, 844)):
            results.append(await verify_case(browser, True, width, height, role='system_admin'))
        results.append(await verify_case(browser, False, 390, 844, reduced_motion=True))
        await browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
