# Local-only browser regression. API responses are synthetic; external traffic is blocked.
# Start a local server with synthetic NEXT_PUBLIC_SUPABASE_URL and
# NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then run python tests/browser/ticket-detail-layout.py.
# Width 384 covers the Galaxy S23 Ultra CSS viewport; 360/412 cover display scaling.
import asyncio, json, os, subprocess, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect

BASE = os.environ.get('CMPRI_TEST_BASE_URL', 'http://127.0.0.1:3116').rstrip('/')
assert urlparse(BASE).hostname == '127.0.0.1'
OUT = Path(os.environ.get('CMPRI_TEST_OUTPUT', '/tmp/cmpri-ticket-layout'))
OUT.mkdir(parents=True, exist_ok=True)
WIDTHS = [int(width) for width in os.environ.get('CMPRI_TEST_WIDTHS', '360,384,412,1360').split(',')]
ID = '00000000-0000-4000-8000-000000000042'
ISSUE = 'Bathroom light flickers intermittently and the fixture above the mirror needs inspection before the next guest arrives.'
# Derive capabilities from the actual policy instead of granting every fixture dashboard access.
POLICY = json.loads(subprocess.check_output(['node', '--experimental-strip-types', '--input-type=module', '-e', r'''
import {readFileSync} from 'node:fs';
import {profileAllows} from './src/lib/server/roles.ts';
const source=readFileSync('./src/lib/server/roles.ts','utf8');
const caps=[...source.matchAll(/\| "([a-z_]+)"/g)].map(m=>m[1]);
const roles=['engineer','chief_engineer','system_admin','manager','senior_management','assistant_manager','front_desk_manager','technician','housekeeping','front_desk'];
console.log(JSON.stringify(Object.fromEntries(roles.map(role=>[role,[...new Set(caps.filter(c=>profileAllows({role},c)))]]))));
'''], text=True))

async def main():
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        cases = [(role, width, 'present', False) for role in POLICY for width in WIDTHS]
        cases += [('system_admin', width, state, True) for width in WIDTHS if width in [384, 1360] for state in ['present', 'missing', 'error']]
        for role, width, checkout, scott in cases:
            ctx = await browser.new_context(viewport={'width': width, 'height': 915}, is_mobile=width < 640, has_touch=width < 640)
            email = 'maint.cmpri@hawkeyehotels.com' if scott else 'fixture@example.invalid'
            session = {'access_token': 'fixture-token', 'refresh_token': 'fixture-refresh', 'expires_at': int(time.time()) + 7200, 'expires_in': 7200, 'token_type': 'bearer', 'user': {'id': 'fixture-user', 'email': email}}
            await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",' + json.dumps(json.dumps(session)) + ');')
            requests, errors, writes = [], [], []
            async def route(r):
                u = urlparse(r.request.url)
                if u.hostname != '127.0.0.1': return await r.abort()
                if not u.path.startswith('/api/'): return await r.continue_()
                requests.append(u.path)
                if r.request.method not in ['GET', 'HEAD']: writes.append(u.path)
                body, status = {}, 200
                if u.path == '/api/session': body = {'user': {'id': 'fixture-user', 'name': 'Fixture Technician', 'email': email, 'role': role}, 'landing': '/engineering', 'capabilities': POLICY[role]}
                elif u.path == '/api/profile': body = {'preferences': {'appearance': 'dark', 'language': 'en'}}
                elif u.path == f'/api/work-orders/{ID}': body = {'workOrder': {'id': ID, 'display_id': 'workorder_fixture', 'room': 'Room 219', 'issue': ISSUE, 'status': 'Open', 'priority': 'High', 'technician_name': 'Fixture Technician', 'created_by': 'fixture-user', 'notes': 'CMPRI2|2026-10-12T12:00:00Z|Alex|Front Desk Manager|note|Front desk report\nCMPRI2|2026-10-12T12:01:00Z|Jordan|Chief Engineer|note|Engineering findings\nImported note without author role', 'created_at': '2026-10-12T12:00:00Z'}, 'mentionTickets': []}
                elif u.path.endswith('/attachments'): body = {'images': []}
                elif u.path == '/api/maintenance-reference': body = {'assets': [], 'technicians': []}
                elif u.path == '/api/room-ranker': body = {'rooms': [{'room': '219', 'rank': 'B', 'notes': 'Fixture ranker note'}]}
                elif u.path == '/api/room-operations':
                    body = {'rows': [{'room': '219', 'room_status': 'Occupied', 'checkout_date': '2026-10-13' if checkout == 'present' else '', 'checkout_time': '11:00 AM' if checkout == 'present' else ''}]}
                    if checkout == 'error': body, status = {'error': 'Fixture checkout unavailable'}, 503
                await r.fulfill(status=status, content_type='application/json', body=json.dumps(body))
            await ctx.route('**/*', route)
            page = await ctx.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(f'{BASE}/work-orders/{ID}' + ('?embedded=1' if width != 412 else ''))
            await page.get_by_role('heading', name='Reported Issue', exact=True).wait_for(timeout=60000)
            await expect(page.get_by_role('heading', name='Notes & Ticket History', exact=True)).to_have_count(1)
            await expect(page.get_by_text('Front Desk Manager Notes', exact=True)).to_have_count(1 if role != 'front_desk_manager' else 2)
            await expect(page.get_by_text('Chief Engineer Notes', exact=True)).to_have_count(1 if role != 'chief_engineer' else 2)
            await expect(page.get_by_text('Notes', exact=True)).to_have_count(1)
            if width == 384 and role == 'front_desk':
                await page.evaluate('document.documentElement.lang="es"')
                await expect(page.get_by_role('heading', name='Notas e historial de la orden', exact=True)).to_have_count(1)
                await expect(page.get_by_text('Notas de Gerente de Recepción', exact=True)).to_have_count(1)
                await expect(page.get_by_text('Notas de Jefe de Ingeniería', exact=True)).to_have_count(1)
                await expect(page.get_by_text('Notas', exact=True)).to_have_count(1)
                await expect(page.get_by_role('heading', name='Notas de Recepción', exact=True)).to_have_count(1)
                await page.evaluate('document.documentElement.lang="en"')
            dashboard = 'view_dashboard' in POLICY[role]
            ranker = dashboard and (scott or role in ['manager', 'technician'])
            pm = page.get_by_text('PM checks and quarterly room forms', exact=True)
            if dashboard: await pm.wait_for()
            await expect(pm).to_have_count(1 if dashboard else 0)
            await expect(page.get_by_text('Room Ranker', exact=True)).to_have_count(1 if ranker else 0)
            if dashboard:
                await expect(page.get_by_role('link', name='Open Preventive Maintenance')).to_have_attribute('href', '/engineering/preventive-maintenance')
                bottom = pm.locator('xpath=../..')
                for label in ['Reported Issue', 'Suggested Troubleshooting', 'Labor & Parts']:
                    content = page.get_by_role('heading', name=label, exact=True)
                    assert await content.evaluate('(e, b)=>!!(e.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)', await bottom.element_handle())
                    a, b = await content.bounding_box(), await bottom.bounding_box()
                    assert b['y'] > a['y'] + a['height'], (role, width, label)
            if ranker:
                await expect(page.get_by_role('link', name='Ranker', exact=True)).to_have_attribute('href', '/engineering/room-ranker')
                await expect(page.get_by_text('• Fixture ranker note', exact=True)).to_have_count(1)
            header_issue = page.locator('p[title]').filter(has_text=ISSUE)
            row = page.get_by_role('heading', name='Room 219', exact=True).locator('xpath=../..')
            await expect(row.locator('span', has_text='High')).to_have_count(1)
            await expect(row.locator('span', has_text='Open')).to_have_count(1)
            checkout_pill = row.locator('span').filter(has_text='11:00 AM')
            await expect(checkout_pill).to_have_count(1 if dashboard and checkout == 'present' else 0)
            if checkout == 'error':
                alert = page.get_by_role('alert').filter(has_text='Fixture checkout unavailable')
                await expect(alert).to_be_visible()
                assert (await alert.bounding_box())['y'] < (await page.get_by_role('heading', name='Reported Issue', exact=True).bounding_box())['y']
            assert await row.evaluate('e=>getComputedStyle(e).flexWrap') == 'wrap'
            assert await header_issue.evaluate('e=>e.scrollHeight<=e.clientHeight+1 && getComputedStyle(e).whiteSpace!=="nowrap"')
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), (role, width)
            await page.get_by_text('Suggested Troubleshooting', exact=True).click()
            if dashboard:
                assert (await pm.bounding_box())['y'] > (await page.get_by_text('Select equipment to check', exact=False).bounding_box())['y']
            assert not errors, errors
            assert not writes, writes
            if width in [384, 1360]:
                await page.screenshot(path=str(OUT / f'{role}-{width}-{checkout}{"-scott" if scott else ""}.png'), full_page=True)
            results.append({'role': role, 'width': width, 'checkout': checkout, 'scott_identity': scott, 'ranker_visible': ranker, 'pm_visible': dashboard, 'passed': True})
            await ctx.close()
        await browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))
    print(f'Passed {len(results)} role/viewport/checkout cases; screenshots and results: {OUT}')

if __name__ == '__main__':
 asyncio.run(main())
