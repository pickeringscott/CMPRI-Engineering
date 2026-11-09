"""Exercise the real sign-in-to-desktop transition using only synthetic local data.

Run against the local app with CMPRI_UI_BASE=http://127.0.0.1:3116.
No provider calls, production identities, or production writes are used.
"""
from cmpri_fixture import *


async def verify(role, destination, width, height):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
        await install(context, role)
        signin_released = asyncio.Event()
        dashboard_released = asyncio.Event()
        signin_requested = asyncio.Event()
        dashboard_requested = asyncio.Event()
        calls = 0

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
        try:
            await page.goto(BASE + '/', wait_until='domcontentloaded')
            await asyncio.wait_for(signin_requested.wait(), 60)
            background = page.locator('iframe[title^="Thanksgiving"]')
            await background.wait_for(state='visible', timeout=60000)
            await page.wait_for_function("document.querySelector('iframe[title^=Thanksgiving]')?.contentDocument?.getElementById('scene')")
            signin_released.set()
            await asyncio.wait_for(dashboard_requested.wait(), 60)
            await page.wait_for_url('**' + destination, timeout=60000)
            await page.locator('main[aria-busy="true"]').wait_for(state='visible')
            assert await background.count() == 1
            assert await background.is_visible()
            await page.wait_for_function("document.querySelector('iframe[title^=Thanksgiving]')?.contentDocument?.getElementById('scene')")
            await background.evaluate('(frame) => { window.__pendingBackground = frame; }')
            assert await page.locator('.cmpri-desktop-topbar:visible').count() == 0, 'Authenticated desktop controls appeared before authorization'
            assert await page.locator('[data-dashboard-account]').count() == 0, 'Account details appeared before authorization'
            color = await page.locator('main[aria-busy="true"]').evaluate('(el) => getComputedStyle(el).backgroundColor')
            assert color != 'rgb(2, 6, 23)', f'Navy dashboard flash: {color}'
            dashboard_released.set()
            await page.locator('.cmpri-desktop-topbar').wait_for(state='visible', timeout=60000)
            assert await page.evaluate('window.__pendingBackground === document.querySelector("iframe[title^=Thanksgiving]")'), 'The background restarted after authorization'
            print(json.dumps({'role': role, 'width': width, 'authorizedControlsHiddenUntilVerified': True, 'backgroundRetained': True, 'navyFlash': False}))
        finally:
            signin_released.set()
            dashboard_released.set()
            await context.close()
            await browser.close()


async def main():
    for role, destination in [('chief_engineer', '/engineering'), ('front_desk', '/front-desk')]:
        for width, height in [(1440, 900), (390, 844)]:
            await verify(role, destination, width, height)


asyncio.run(main())
