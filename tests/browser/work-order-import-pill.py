"""Local-only real-page fixtures; no production credentials or writes."""
import asyncio, json, os, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

BASE = os.environ.get('CMPRI_TEST_BASE_URL', 'http://127.0.0.1:3116').rstrip('/')
assert urlparse(BASE).hostname == '127.0.0.1'
OUT = Path(os.environ.get('CMPRI_TEST_OUTPUT', '/tmp/cmpri-import-pill'))
OUT.mkdir(parents=True, exist_ok=True)

async def main():
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for width in [384, 1360]:
            for role in ['chief_engineer', 'front_desk']:
                ctx = await browser.new_context(viewport={'width': width, 'height': 915})
                session = {'access_token': 'fixture', 'refresh_token': 'fixture', 'expires_at': int(time.time())+7200, 'user': {'id': 'fixture-user', 'email': 'fixture@example.invalid'}}
                await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",' + json.dumps(json.dumps(session)) + ')')
                order = {'id': 'fixture-order', 'display_id': 'WO-FIXTURE', 'room': '219', 'issue': 'Original lamp issue', 'status': 'Open', 'priority': 'Medium', 'revision': 1, 'creator_name': 'Original requester', 'notes': 'Full original provenance', 'import_source': 'Spreadsheet', 'import_external_id': 'CMPRI-final-20260915-IMP-0006|CUR-006|AC-6131'}
                writes = []
                async def route(r):
                    u = urlparse(r.request.url)
                    if u.hostname != '127.0.0.1': return await r.abort()
                    if not u.path.startswith('/api/'): return await r.continue_()
                    if r.request.method not in ['GET', 'HEAD']: writes.append(u.path)
                    body = {}
                    if u.path == '/api/session': body = {'user': {'id': 'fixture-user', 'name': 'Fixture', 'role': role}, 'landing': '/engineering', 'capabilities': ['submit', 'view_dashboard', 'view_work_orders', 'add_work_order_notes'] + (['edit_tickets', 'review_tickets'] if role == 'chief_engineer' else [])}
                    elif u.path == '/api/profile': body = {'preferences': {'appearance': 'dark', 'language': 'en'}}
                    elif u.path == '/api/work-orders/fixture-order': body = {'workOrder': order, 'mentionTickets': []}
                    elif u.path == '/api/work-orders': body = {'work_orders': [order, {'id': 'paper', 'room': '220', 'issue': 'Paper issue', 'status': 'Open', 'import_source': 'Spreadsheet', 'import_external_id': 'paper-batch-001'}]}
                    elif u.path == '/api/rooms': body = {'locations': []}
                    elif u.path == '/api/assets': body = {'assets': []}
                    elif u.path == '/api/work-orders/drafts': body = {'drafts': []}
                    await r.fulfill(content_type='application/json', body=json.dumps(body))
                await ctx.route('**/*', route)
                page = await ctx.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                await page.goto(BASE + '/work-orders/fixture-order')
                pill = page.locator('[data-work-order-import-pill]')
                await expect(pill).to_have_count(1, timeout=60000)
                await expect(pill).to_be_visible()
                await expect(page.get_by_text('Original requester', exact=True)).to_be_visible()
                for _ in range(2):
                    await page.reload()
                    await expect(pill).to_have_count(1)
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                box = await pill.bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= width
                await page.screenshot(path=str(OUT / f'detail-{role}-{width}.png'))
                # Metadata changes must remove an old pill on the next load.
                saved_id = order.pop('import_external_id')
                await page.reload()
                await expect(page.get_by_text('Original requester', exact=True)).to_be_visible()
                await expect(pill).to_have_count(0)
                order['import_external_id'] = saved_id
                await page.goto(BASE + '/engineering')
                await page.locator('[data-dashboard-title]').wait_for()
                if role == 'chief_engineer' and width < 640:
                    await page.locator('[data-chief-mobile-menus]').get_by_role('button', name='Work Orders', exact=False).click()
                launch = page.get_by_role('menuitem' if role == 'chief_engineer' and width < 640 else 'button', name='Work Order List', exact=True)
                await launch.click()
                await page.locator('[data-work-order-list-heading]').wait_for()
                await expect(pill).to_have_count(1)
                await expect(pill).to_be_visible()
                await page.get_by_role('searchbox').fill('Paper issue')
                await expect(pill).to_have_count(0)
                await page.get_by_role('searchbox').fill('Original lamp')
                await expect(pill).to_have_count(1)
                await page.screenshot(path=str(OUT / f'list-{role}-{width}.png'))
                assert not writes, writes
                assert not errors, errors
                results.append({'role': role, 'width': width, 'passed': True, 'writes': writes})
                await ctx.close()
        await browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results))

asyncio.run(main())
