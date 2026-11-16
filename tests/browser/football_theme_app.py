"""Local shared football-theme regression with synthetic authenticated API data.

Run the app on localhost using CI public placeholders, then run:
  CMPRI_UI_BASE=http://localhost:3120 python tests/browser/football_theme_app.py
Next development hydration uses its HMR debug channel, so localhost must match
its permitted dev origin. Production checks can use either loopback hostname.
"""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse

os.environ.setdefault('CMPRI_UI_BASE', 'http://localhost:3120')
os.environ.setdefault('CMPRI_UI_OUTPUT', 'work/football-theme-app')
from cmpri_fixture import BASE, install
from playwright.async_api import async_playwright, expect

OUT = Path(os.environ['CMPRI_UI_OUTPUT'])
OUT.mkdir(parents=True, exist_ok=True)
FRAME = 'iframe[title="Illinois versus Iowa football background"]'
CONTROL = '.cmpri-football-animation-control'
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

async def verify_case(browser, authenticated, width, height, reduced_motion=False):
    errors, failures, external = [], [], []
    context = await browser.new_context(
        viewport={'width': width, 'height': height},
        is_mobile=width < 640, has_touch=width < 640,
        reduced_motion='reduce' if reduced_motion else 'no-preference',
    )
    if authenticated:
        await install(context, 'chief_engineer')
    else:
        async def route(request):
            if urlparse(request.request.url).hostname not in ('localhost', '127.0.0.1'):
                external.append(request.request.url)
                return await request.abort()
            return await request.continue_()
        await context.route('**/*', route)
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
        control_box = await control.bounding_box()
        assert control_box['y'] + control_box['height'] < geometry['scorebug']['top'], (control_box, geometry)
    else:
        assert geometry['fieldTransform'] == 'none', geometry
    assert geometry['scorebug']['left'] >= -1 and geometry['scorebug']['right'] <= width + 1
    screenshot = OUT / f'{"engineering" if authenticated else "sign-in"}-{width}{"-reduced" if reduced_motion else ""}.png'
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
    await page.evaluate('history.pushState(null, "", "/profile")')
    await expect(control).to_be_hidden()
    await page.wait_for_timeout(100)
    suspended_time = await child.evaluate('window.cmpriTheme.action.time')
    await page.wait_for_timeout(450)
    assert await child.evaluate('window.cmpriTheme.action.time') == suspended_time
    assert await page.locator(FRAME).count() == 1
    await page.evaluate('(path) => history.pushState(null, "", path)', path)
    await expect(control).to_be_visible()
    assert await child.evaluate('window.__footballIdentity') == 'persistent-frame'
    await child.wait_for_function('(time) => window.cmpriTheme.action.time !== time', arg=suspended_time, timeout=5000)
    assert not errors, errors
    assert not failures, failures
    result = {'route': path, 'width': width, 'height': height, 'reducedMotion': reduced_motion,
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
        results.append(await verify_case(browser, False, 390, 844, reduced_motion=True))
        await browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
