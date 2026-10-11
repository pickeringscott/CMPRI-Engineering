import asyncio
import json
import subprocess
import urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parents[2] / '.sandbox'

def rows_for(user_id, location_id):
    # UUIDs come only from the local seed file, never user-entered SQL.
    from uuid import UUID
    user_id, location_id = str(UUID(user_id)), str(UUID(location_id))
    query = "select coalesce(json_agg(t),'[]') from (select id,location_id,asset_id,issue,category,notes,status from work_orders where created_by='%s' and location_id='%s') t" % (user_id, location_id)
    result = subprocess.run(['docker', 'exec', 'supabase_db_cmpri-seven-role-isolated-qa', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', query], text=True, capture_output=True, check=True)
    return json.loads(result.stdout.strip())

async def main():
    results = []
    users = json.loads((OUT / 'synthetic-users.json').read_text())
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        for user in users:
            context = await browser.new_context(viewport={'width': 1280, 'height': 1000}, service_workers='block')
            external, errors = [], []
            async def guard(route):
                hostname = urllib.parse.urlparse(route.request.url).hostname
                if hostname not in ['127.0.0.1', 'localhost']:
                    external.append(hostname)
                    return await route.abort()
                await route.continue_()
            await context.route('**/*', guard)
            page = await context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                await page.goto('http://127.0.0.1:3112/', timeout=120000)
                await page.get_by_role('button', name='More…').click()
                await page.get_by_role('textbox', name='Email', exact=True).fill(user['email'])
                await page.get_by_role('textbox', name='Password', exact=True).fill(user['password'])
                await page.get_by_role('button', name='Sign in with Password', exact=True).click()
                await page.wait_for_url(lambda url: url.path in ['/engineering', '/technician', '/work-orders'], timeout=120000)
                for fixture in user['fixtures']:
                    result = {'role': user['label'], 'storedRole': user['role'], 'scenario': fixture['name'], 'passed': False}
                    try:
                        await page.goto('http://127.0.0.1:3112/work-orders', timeout=120000)
                        issue = page.get_by_placeholder('Example: 316 not cooling')
                        await issue.wait_for(timeout=60000)
                        await issue.fill(fixture['room'] + ' ' + fixture['issue'] + '\nGuest is leaving at 5 PM')
                        await page.get_by_placeholder('Optional: findings, diagnostic codes, readings, tests, or work already performed').fill('Remote was already replaced.')
                        if user['label'] in ['Assistant General Manager', 'Front Desk Manager', 'Front Desk']:
                            await page.get_by_placeholder('First name').fill('Casey', timeout=15000)
                        # Await real preview inference before submitting; no intercepted app responses.
                        await page.wait_for_timeout(800)
                        async with page.expect_response(lambda response: '/api/work-orders' in response.url and response.request.method == 'POST', timeout=60000) as pending:
                            await page.locator('button[type="submit"]').first.click()
                        response = await pending.value
                        result['status'] = response.status
                        result['response'] = await response.json()
                        assert response.status == 200, result['response']
                        rows = rows_for(user['id'], fixture['location_id'])
                        result['rows'] = rows
                        assert len(rows) == 1, rows
                        assert rows[0]['asset_id'] == fixture['asset_id'], rows
                        assert rows[0]['category'] == fixture['category'], rows
                        assert rows[0]['notes'] == 'Remote was already replaced.\nGuest is leaving at 5 PM', rows
                        assert not external, external
                        assert not errors, errors
                        result['passed'] = True
                    except Exception as error:
                        result['error'] = str(error)
                    result['blockedExternal'] = list(external)
                    result['browserErrors'] = list(errors)
                    await page.screenshot(path=str(OUT / f"{user['role'].replace(' ', '-')}-{fixture['name']}.png"), full_page=True)
                    results.append(result)
                    (OUT / 'e2e-results.json').write_text(json.dumps(results, indent=2))
                    print(json.dumps({key: result.get(key) for key in ['role', 'scenario', 'passed', 'status', 'error']}), flush=True)
            except Exception as error:
                results.append({'role': user['label'], 'phase': 'login', 'passed': False, 'error': str(error)})
                (OUT / 'e2e-results.json').write_text(json.dumps(results, indent=2))
            finally:
                await context.close()
        await browser.close()
    assert len(results) == 28 and all(result['passed'] for result in results), 'Incomplete or failed browser/DB checks; see e2e-results.json'

asyncio.run(main())
