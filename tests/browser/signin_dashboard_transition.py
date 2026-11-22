"""Check the Thanksgiving sign-in-to-desktop transition with local fixtures.

Run against the local app with CMPRI_UI_BASE=http://localhost:3116.
The development hostname must be allowed by Next's HMR origin check.
"""
from cmpri_fixture import *

FRAME = 'iframe[title^="Thanksgiving"]'
ARTWORK = json.loads((Path(__file__).resolve().parents[2] / 'src/lib/ui/thanksgiving-assets.json').read_text())['entry']
TRANSPARENT = 'rgba(0, 0, 0, 0)'


async def verify_first_paint():
    """The artwork and approved sign-in colors appear before app JavaScript runs."""
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 390, 'height': 844}, java_script_enabled=False, service_workers='block')
        page = await context.new_page()
        api_requests = []
        page.on('request', lambda request: api_requests.append(request.url) if '/api/' in request.url else None)
        try:
            await page.goto(BASE + '/', wait_until='domcontentloaded')
            await page.locator('.cmpri-sign-in-card').wait_for(state='visible')
            result = await page.evaluate('''selector => {
              const style = target => getComputedStyle(document.querySelector(target));
              const control = document.querySelector('.cmpri-animation-control');
              const controlStyle = getComputedStyle(control);
              return {
                theme: document.querySelector('main').dataset.cmpriSeasonalTheme,
                animationControl: {text: control.textContent, width: controlStyle.width,
                  height: controlStyle.height, radius: controlStyle.borderRadius},
                artwork: document.querySelector(selector).getAttribute('src'),
                backdrop: style('.cmpri-persistent-artwork').backgroundColor,
                cardBackground: style('.cmpri-sign-in-card').backgroundColor,
                cardColor: style('.cmpri-sign-in-card').color,
                cardBorder: style('.cmpri-sign-in-card').borderColor,
                checkbox: style('input[type=checkbox]').accentColor,
                link: style('.cmpri-sign-in-link').color,
                main: style('main').backgroundColor
              };
            }''', FRAME)
            assert result == {
                'theme': 'thanksgiving',
                'animationControl': {'text': 'Ⅱ', 'width': '44px', 'height': '44px', 'radius': '50%'},
                'artwork': ARTWORK,
                'backdrop': 'rgb(39, 27, 20)',
                'cardBackground': 'rgba(48, 33, 23, 0.96)',
                'cardColor': 'rgb(255, 240, 214)',
                'cardBorder': 'rgb(154, 112, 70)',
                'checkbox': 'rgb(223, 172, 81)',
                'link': 'rgb(255, 219, 145)',
                'main': TRANSPARENT,
            }, result
            assert not api_requests, api_requests
            output = OUT / 'thanksgiving-signin-first-paint-no-js.png'
            await page.screenshot(path=str(output), full_page=True)
            print(json.dumps({'firstPaintWithoutJavaScript': True, 'paletteBeforeHydration': result,
                'apiRequests': api_requests, 'screenshot': str(output)}), flush=True)
        finally:
            await context.close()
            await browser.close()


async def verify(role, destination, width, height):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': width, 'height': height},
                                            is_mobile=width < 640, has_touch=width < 640,
                                            service_workers='block')
        await install(context, role)
        signin_released, dashboard_released = asyncio.Event(), asyncio.Event()
        signin_requested, dashboard_requested = asyncio.Event(), asyncio.Event()
        calls, errors, artwork_requests = 0, [], []

        async def session(route):
            nonlocal calls
            calls += 1
            if calls == 1:
                signin_requested.set()
                await signin_released.wait()
            else:
                dashboard_requested.set()
                await dashboard_released.wait()
            await route.fulfill(content_type='application/json', body=json.dumps({
                'user': {'id': UID, 'name': 'Alex Morgan', 'role': role, 'email': 'fixture@example.invalid'},
                'hotelId': HOTEL, 'landing': destination, 'capabilities': CAPS[role],
            }))

        await context.route('**/api/session', session)
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: artwork_requests.append(request.url)
                if urlparse(request.url).path == ARTWORK else None)
        try:
            await page.goto(BASE + '/', wait_until='domcontentloaded')
            await asyncio.wait_for(signin_requested.wait(), 60)
            background = page.locator(FRAME)
            await background.wait_for(state='visible', timeout=60000)
            await expect(background).to_have_attribute('src', ARTWORK)
            child = await (await background.element_handle()).content_frame()
            await expect(child.locator('#scene')).to_have_attribute('data-layout', 'mobile' if width < 640 else 'desktop')
            await child.wait_for_function('Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)')
            await page.get_by_role('button', name='Pause animation').click()
            await expect(child.locator('#toggle')).to_have_attribute('aria-pressed', 'true')
            await page.get_by_role('button', name='Resume animation').click()
            await expect(child.locator('#toggle')).to_have_attribute('aria-pressed', 'false')
            await background.evaluate('''(frame, selector) => {
              window.__pendingBackground = frame;
              window.__pendingScene = frame.contentDocument.getElementById('scene');
              window.__transitionFrames = [];
              window.__sampleTransition = true;
              const sample = () => {
                const current = document.querySelector(selector);
                const wrapper = current?.closest('.cmpri-persistent-artwork');
                window.__transitionFrames.push({path: location.pathname,
                  same: current === window.__pendingBackground,
                  visible: !!wrapper && !wrapper.hidden && getComputedStyle(wrapper).display !== 'none',
                  mainColor: getComputedStyle(document.querySelector('main')).backgroundColor});
                if (window.__sampleTransition && window.__transitionFrames.length < 1200) requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            }''', FRAME)
            signin_released.set()
            await asyncio.wait_for(dashboard_requested.wait(), 60)
            await page.wait_for_url('**' + destination, timeout=60000)
            loading = page.locator('main[aria-busy="true"]')
            await loading.wait_for(state='visible')
            await expect(background).to_have_count(1)
            await expect(background).to_be_visible()
            assert await page.locator('.cmpri-desktop-topbar:visible').count() == 0, 'Desktop controls appeared before authorization'
            assert await page.locator('[data-dashboard-account]').count() == 0, 'Account details appeared before authorization'
            color = await loading.evaluate('(el) => getComputedStyle(el).backgroundColor')
            assert color == TRANSPARENT, ('Loading layer obscures Thanksgiving artwork', color)
            # Hold the pending dashboard long enough to catch a hidden frame or opaque loading surface.
            await page.wait_for_timeout(300)
            dashboard_released.set()
            await page.locator('.cmpri-desktop-topbar').wait_for(state='visible', timeout=60000)
            await page.wait_for_timeout(100)
            samples = await page.evaluate('window.__sampleTransition = false; window.__transitionFrames')
            assert samples and all(s['same'] and s['visible'] and s['mainColor'] == TRANSPARENT for s in samples), samples
            same_scene = await background.evaluate('frame => frame.contentDocument.getElementById("scene") === window.__pendingScene')
            assert same_scene, 'The artwork document reloaded'
            assert len(artwork_requests) == 1, artwork_requests
            assert not errors, errors
            output = OUT / f'thanksgiving-signin-transition-{role}-{width}.png'
            await page.screenshot(path=str(output), full_page=True)
            print(json.dumps({'role': role, 'destination': destination, 'width': width,
                'authorizedControlsHiddenUntilVerified': True, 'backgroundRetained': True,
                'sameArtworkScene': True, 'framesChecked': len(samples),
                'artworkRequests': len(artwork_requests), 'errors': errors, 'screenshot': str(output)}), flush=True)
        finally:
            signin_released.set()
            dashboard_released.set()
            await context.close()
            await browser.close()


async def main():
    await verify_first_paint()
    if os.environ.get('CMPRI_SIGNIN_FIRST_PAINT_ONLY') == '1':
        return
    for role, destination in [('chief_engineer', '/engineering'), ('front_desk', '/front-desk')]:
        for width, height in [(1440, 900), (390, 844)]:
            await verify(role, destination, width, height)


asyncio.run(main())
