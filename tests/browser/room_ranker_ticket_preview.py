"""Room Ranker hover titles and dialog dismissal; uses local API fixtures only."""
from cmpri_fixture import *

LEAD = 'Urgent water leak'
EXTRA_TITLES = ['High priority HVAC repair', 'Medium priority lamp & shade', 'Low priority <paint> touch-up']
ISSUES = [{'id': 'ticket-' + str(i), 'issue': title, 'priority': 'Urgent'} for i, title in enumerate([LEAD, *EXTRA_TITLES])]
ISSUES[-1]['ranker_base_priority'] = 'Low'
ROOMS = [
    {'id': 'r1', 'number': '101', 'floor': '1', 'rank': 'C', 'issues': ISSUES},
    {'id': 'r2', 'number': '102', 'floor': '1', 'rank': 'A', 'issues': []},
    {'id': 'r3', 'number': '103', 'floor': '1', 'rank': 'A', 'issues': [ISSUES[0]]},
]


async def check(frame, page, label):
    await frame.get_by_role('button', name='1st Floor', exact=False).click()
    row = frame.locator('[data-room="101"]')
    await expect(row.get_by_role('link')).to_have_text(LEAD)
    await expect(row.get_by_role('link')).to_have_attribute('href', '/work-orders/ticket-0')
    escalation = row.get_by_role('button', name='Ticket Escalation', exact=True)
    await escalation.hover()
    tooltip = row.get_by_role('tooltip')
    await expect(tooltip).to_have_text('!Ticket Escalation!')
    assert await tooltip.locator('[aria-hidden="true"]').get_attribute('class') == await escalation.locator('[aria-hidden="true"]').get_attribute('class')
    mark = await escalation.locator('[aria-hidden="true"]').bounding_box()
    rank = await row.locator('span').nth(1).bounding_box()
    assert abs(mark['height'] - rank['height']) < 2, (mark, rank)
    link = await row.get_by_role('link').bounding_box()
    assert rank['x'] + rank['width'] <= mark['x'] < link['x']
    await escalation.focus()
    await escalation.press('Escape')
    await expect(tooltip).to_have_count(0)
    more = row.get_by_role('button', name='Show 3 additional issues for room 101')
    await expect(more).to_have_text('+3 more')
    # Native hover hints contain every additional title, without the visible lead.
    await more.hover()
    await expect(more).to_have_attribute('title', '\n'.join(EXTRA_TITLES))
    dialog = frame.get_by_role('dialog')
    await expect(dialog).to_be_hidden()
    for number in ['102', '103']:
        await expect(frame.locator('[data-room="' + number + '"] button')).to_have_count(0)

    await more.click()
    await expect(dialog).to_be_visible()
    await expect(dialog.get_by_role('link')).to_have_text(EXTRA_TITLES)
    for i, link in enumerate(await dialog.get_by_role('link').all(), 1):
        await expect(link).to_have_attribute('href', '/work-orders/ticket-' + str(i))
    await expect(dialog.get_by_text(LEAD, exact=True)).to_have_count(0)
    await dialog.locator('h2').click()
    await expect(dialog).to_be_visible()
    rect = await dialog.bounding_box()
    await page.mouse.click(rect['x'] + 3, rect['y'] + 3)
    await expect(dialog).to_be_visible()  # Dialog padding is inside, not backdrop.
    body = await frame.locator('body').bounding_box()
    await page.mouse.click(body['x'] + 2, body['y'] + 2)
    await expect(dialog).to_be_hidden()
    await expect(more).to_be_focused()

    await more.click()
    await dialog.get_by_role('button', name='Close', exact=True).click()
    await expect(dialog).to_be_hidden()
    await expect(more).to_be_focused()
    await more.focus()
    await more.press('Enter')
    await expect(dialog).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(dialog).to_be_hidden()
    await expect(more).to_be_focused()
    print(label + ' passed', flush=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for width in [390, 1440]:
            context = await browser.new_context(viewport={'width': width, 'height': 900}, is_mobile=width < 640, has_touch=width < 640)
            await install(context, 'chief_engineer')

            async def extras(route):
                if urlparse(route.request.url).path == '/api/ticket-room-ranker':
                    return await route.fulfill(json={'rooms': ROOMS})
                await route.fallback()

            await context.route('**/api/**', extras)
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(BASE + '/engineering/room-ranking')
            await check(page, page, 'standalone ' + str(width))
            await expect(page.locator('main > p')).to_have_count(0)
            await page.get_by_role('button', name='Room ranker key', exact=True).click()
            key = page.get_by_role('region', name='Room ranker key')
            await expect(key.get_by_text('C needs the most attention.', exact=False)).to_be_visible()
            await expect(key.get_by_text('Ticket Escalation:', exact=True)).to_be_visible()
            await expect(key.locator('[aria-hidden="true"]')).to_have_count(1)
            await key.get_by_role('button', name='Close room ranker key').click()
            await page.goto(BASE + '/engineering')
            await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
            await page.evaluate("window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:'/engineering/room-ranking',title:'Room Ranker'}}))")
            shell = page.locator('.cmpri-modal-shell').last
            frame = await (await shell.locator('iframe').element_handle()).content_frame()
            # Standalone floor choices persist when the embedded view opens.
            await expect(frame.get_by_role('button', name='1st Floor', exact=False)).to_have_attribute('aria-expanded', 'true')
            await frame.get_by_role('button', name='1st Floor', exact=False).click()
            await check(frame, page, 'embedded ' + str(width))
            await shell.get_by_role('button', name='Room ranker key', exact=True).click()
            await expect(shell.get_by_role('region', name='Room ranker key').get_by_text('Ticket Escalation:', exact=True)).to_be_visible()
            await page.screenshot(path=str(OUT / ('room-ranker-escalation-' + str(width) + '.png')))
            assert not errors, errors
            await context.close()
        await browser.close()


asyncio.run(main())
