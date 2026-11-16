"""Exercise real sign-in-to-desktop routing with delayed, synthetic authorization.

Run against the local app with CMPRI_UI_BASE=http://localhost:3116.
The development hostname must be allowed by Next's HMR origin check. All APIs
use local fixtures; no provider calls, production identities or writes are used.
"""
from cmpri_fixture import *

FRAME = 'iframe[title="Illinois versus Iowa football background"]'
NAVY = {'rgb(2, 6, 23)', 'rgb(11, 20, 35)', 'rgb(8, 19, 33)', 'rgb(9, 17, 30)'}


async def verify_first_paint():
    """CSS and native controls must have the team palette before app JavaScript."""
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 390, 'height': 844}, java_script_enabled=False, service_workers='block')
        page = await context.new_page()
        api_requests = []
        page.on('request', lambda request: api_requests.append(request.url) if '/api/' in request.url else None)
        try:
            await page.goto(BASE + '/', wait_until='domcontentloaded')
            await page.locator('.cmpri-sign-in-card').wait_for(state='visible')
            result = await page.evaluate('''() => {
              const root=document.documentElement,style=getComputedStyle(root);
              const token=name=>style.getPropertyValue(name).trim();
              const rgb=value=>{
                const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
                const context=canvas.getContext('2d');context.fillStyle=value;context.fillRect(0,0,1,1);
                return Array.from(context.getImageData(0,0,1,1).data).slice(0,3);
              };
              // These native-control probes use the production stylesheet while
              // application scripts remain disabled. They make unresolved CSS
              // defaults visible without mounting or running ModalTheme.
              const select=document.createElement('select');
              select.innerHTML='<option selected>Selected</option><option>Other</option>';
              const listbox=document.createElement('div');listbox.setAttribute('role','listbox');listbox.textContent='Menu';
              const modal=document.createElement('div');modal.dataset.cmpriModalTheme='true';
              const modalCheckbox=document.createElement('input');modalCheckbox.type='checkbox';modal.append(modalCheckbox);
              document.body.append(select,listbox,modal);
              const selected=select.options[0],checkbox=document.querySelector('input[type=checkbox]');
              const animationControl=document.querySelector('.cmpri-animation-control'),controlStyle=getComputedStyle(animationControl);
              const values={
                theme:root.dataset.cmpriSiteTheme,
                animationControl:{text:animationControl.textContent,width:animationControl.getBoundingClientRect().width,height:animationControl.getBoundingClientRect().height,radius:controlStyle.borderRadius},
                rootColorScheme:style.colorScheme,
                checkboxColorScheme:getComputedStyle(checkbox).colorScheme,
                modalCheckboxColorScheme:getComputedStyle(modalCheckbox).colorScheme,
                root:rgb(style.backgroundColor),body:rgb(getComputedStyle(document.body).backgroundColor),
                modalBase:token('--cmpri-modal-base'),surface:token('--cmpri-modal-surface'),
                action:token('--cmpri-action-rgb').replaceAll(' ',''),
                text:rgb(token('--cmpri-modal-text')),muted:rgb(token('--cmpri-modal-muted')),
                outline:token('--cmpri-outline'),gold:rgb(token('--cmpri-palette-gold')),
                checkbox:rgb(getComputedStyle(checkbox).accentColor),
                link:rgb(getComputedStyle(document.querySelector('.cmpri-sign-in-link')).color),
                select:rgb(getComputedStyle(select).backgroundColor),
                selected:rgb(getComputedStyle(selected).backgroundColor),
                selectedText:rgb(getComputedStyle(selected).color),
                menu:rgb(getComputedStyle(listbox).backgroundColor),
                framePainted:document.querySelector('iframe').dataset.painted
              };
              select.remove();listbox.remove();modal.remove();return values;
            }''')
            assert result['theme'] == 'illinois-iowa', result
            assert result['animationControl'] == {'text':'Ⅱ','width':44,'height':44,'radius':'50%'}, ('Production animation control appearance changed',result)
            assert result['rootColorScheme'] == result['checkboxColorScheme'] == 'normal', ('Production sign-in control appearance changed', result)
            assert result['modalCheckboxColorScheme'] == 'dark', ('Modal control scheme changed', result)
            assert result['root'] == result['body'] == [0, 0, 0], result
            assert result['modalBase'] == '#101010' and result['surface'] and 'var(' not in result['surface'], result
            assert result['action'] == '255,95,5' and result['outline'], result
            assert result['text'] == [255, 248, 230] and result['gold'] == [255, 205, 0], result
            assert result['checkbox'] == [255, 95, 5] and result['link'] == [255, 205, 0], result
            assert result['selected'] == [255, 205, 0] and result['selectedText'] == [0, 0, 0], result
            for color in [result['select'], result['menu'], result['muted']]:
                assert color[0] >= color[1] >= color[2], ('Native blue before hydration', result)
            assert result['framePainted'] == 'false' and not api_requests, (result, api_requests)
            output = OUT / 'football-signin-first-paint-no-js.png'
            await page.screenshot(path=str(output), full_page=True)
            print(json.dumps({'firstPaintWithoutJavaScript': True, 'paletteBeforeHydration': result,
                'apiRequests': api_requests, 'screenshot': str(output)}), flush=True)
        finally:
            await context.close()
            await browser.close()


async def verify(role, destination, width, height):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
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
                if '/backgrounds/illinois-iowa/index.' in request.url else None)
        try:
            await page.goto(BASE + '/', wait_until='domcontentloaded')
            await asyncio.wait_for(signin_requested.wait(), 60)
            background = page.locator(FRAME)
            await background.wait_for(state='visible', timeout=60000)
            # Paint readiness is independent of the complete randomized game.
            # The iframe fades in once its stadium/crowd layer is present.
            await expect(background).to_have_attribute('data-painted', 'true', timeout=60000)
            await page.wait_for_function('''selector => getComputedStyle(document.querySelector(selector)).opacity === '1' ''', arg=FRAME)
            child = await (await background.element_handle()).content_frame()
            await child.wait_for_function('window.cmpriTheme?.game')
            original_game = await child.evaluate('window.cmpriTheme.game.game')
            colors = await page.evaluate('''() => [document.documentElement,document.body,
              document.querySelector('.cmpri-football-artwork'),document.querySelector('main')]
              .map(element => getComputedStyle(element).backgroundColor)''')
            assert not NAVY.intersection(colors), ('Native navy before sign-in', colors)
            assert await child.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgb(0, 0, 0)'
            assert 'rgb(7, 14, 22)' not in await child.evaluate('getComputedStyle(document.querySelector(".stage-wrap")).backgroundImage')
            await background.evaluate('''frame => {
              window.__pendingBackground = frame;
              frame.contentWindow.__pendingCanvas = frame.contentDocument.getElementById('still');
              window.__transitionFrames = [];
              window.__sampleTransition = true;
              const sample = () => {
                const current=document.querySelector('iframe[title="Illinois versus Iowa football background"]');
                const wrapper=current?.closest('.cmpri-football-artwork');
                window.__transitionFrames.push({path:location.pathname,
                  same:current===window.__pendingBackground,
                  visible:!!wrapper && !wrapper.hidden && getComputedStyle(wrapper).display!=='none',
                  opacity:current && getComputedStyle(current).opacity,
                  mainColor:getComputedStyle(document.querySelector('main')).backgroundColor});
                if(window.__sampleTransition && window.__transitionFrames.length<1200)requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            }''')
            signin_released.set()
            await asyncio.wait_for(dashboard_requested.wait(), 60)
            await page.wait_for_url('**' + destination, timeout=60000)
            await page.locator('main[aria-busy="true"]').wait_for(state='visible')
            assert await background.count() == 1
            assert await background.is_visible()
            await expect(background).to_have_attribute('data-painted', 'true')
            assert await page.locator('.cmpri-desktop-topbar:visible').count() == 0, 'Desktop controls appeared before authorization'
            assert await page.locator('[data-dashboard-account]').count() == 0, 'Account details appeared before authorization'
            color = await page.locator('main[aria-busy="true"]').evaluate('(el) => getComputedStyle(el).backgroundColor')
            assert color not in NAVY, ('Navy dashboard flash', color)
            assert color == 'rgba(0, 0, 0, 0)', ('Loading layer obscures stadium', color)
            # Hold the pending dashboard long enough to catch a hidden frame,
            # an opacity reset, or an opaque route-loading surface.
            await page.wait_for_timeout(300)
            dashboard_released.set()
            await page.locator('.cmpri-desktop-topbar').wait_for(state='visible', timeout=60000)
            await page.wait_for_timeout(100)
            samples = await page.evaluate('window.__sampleTransition=false;window.__transitionFrames')
            assert samples and all(s['same'] and s['visible'] and s['opacity']=='1' and s['mainColor'] not in NAVY for s in samples), samples
            assert await page.evaluate('window.__pendingBackground === document.querySelector("iframe[title=\\"Illinois versus Iowa football background\\"]")'), 'The background restarted after authorization'
            assert await child.evaluate('window.__pendingCanvas===document.getElementById("still")'), 'The artwork document reloaded'
            assert await child.evaluate('window.cmpriTheme.game.game') == original_game
            assert len(artwork_requests) == 1, artwork_requests
            assert not errors, errors
            output = OUT / f'football-signin-transition-{role}-{width}.png'
            await page.screenshot(path=str(output), full_page=True)
            print(json.dumps({'role': role, 'destination': destination, 'width': width,
                'authorizedControlsHiddenUntilVerified': True, 'backgroundRetained': True,
                'sameGameAndCanvas': True, 'navyFlash': False, 'framesChecked': len(samples),
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
