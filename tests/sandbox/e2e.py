import asyncio
import urllib.request
from collection import matrix,HardStop,response_listener,assert_saved_row
import base64
from playwright.async_api import expect
import browser_extras
from browser_support import diagnose_context,login,save_browser_diagnostics
import json
import subprocess
import urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright
from diagnostics import emit_result, is_login_landing, sanitize

OUT = Path(__file__).resolve().parents[2] / '.sandbox'

def rows_for(user_id, location_id):
    # UUIDs come only from the local seed file, never user-entered SQL.
    from uuid import UUID
    user_id, location_id = str(UUID(user_id)), str(UUID(location_id))
    query = "select coalesce(json_agg(t),'[]') from (select id,location_id,asset_id,issue,category,notes,status from work_orders where created_by='%s' and location_id='%s') t" % (user_id, location_id)
    result = subprocess.run(['docker', 'exec', 'supabase_db_cmpri-seven-role-isolated-qa', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', query], text=True, capture_output=True, check=True)
    return json.loads(result.stdout.strip())

async def main():
    results=[];hard_stop=False
    users=json.loads((OUT/'synthetic-users.json').read_text())
    secrets=[value for user in users for value in [user['password'],user['email']]]
    photos=json.loads((Path(__file__).parent/'photo-fixtures.json').read_text())
    evidence_by_role=[]
    def record(result):
        results.append(sanitize(result,secrets))
        (OUT/'e2e-results.json').write_text(json.dumps(results,indent=2))
        emit_result(results[-1],secrets)
    async def guard():
        if any(e['blockedExternal'] for e in evidence_by_role):raise HardStop('External request blocked; isolation boundary failed')
        try:
            keys=json.loads((OUT/'local-keys.json').read_text())
            assert keys['API_URL']=='http://127.0.0.1:54321','Local stack only'
            request=urllib.request.Request(keys['API_URL']+'/auth/v1/settings',headers={'apikey':keys['ANON_KEY']})
            with urllib.request.urlopen(request,timeout=10) as response:
                assert response.status==200 and json.load(response)['external']['email'] is True
            subprocess.run(['docker','exec','supabase_db_cmpri-seven-role-isolated-qa','psql','-U','postgres','-d','postgres','-At','-c','select 1'],check=True,capture_output=True,timeout=10)
        except Exception as error:raise HardStop('Shared local Auth/database health failed: '+type(error).__name__) from error
    async with async_playwright() as playwright:
        browser=await playwright.chromium.launch(headless=True)
        async def open_role(user):
            context=await browser.new_context(viewport={'width':1280,'height':1000},service_workers='block')
            page,evidence=await diagnose_context(context,OUT,user['label']);evidence_by_role.append(evidence)
            try:
                await login(page,user,evidence)
                identity=await page.evaluate('''async()=>{const s=JSON.parse(sessionStorage.getItem('cmpri:auth:v1')||localStorage.getItem('cmpri:auth:v1'));const r=await fetch('/api/session',{headers:{Authorization:'Bearer '+s.access_token}});const b=await r.json();return {status:r.status,id:b.user?.id,role:b.user?.role}}''')
                assert identity=={'status':200,'id':user['id'],'role':user['role']},'Authenticated role/session mismatch'
                return context,page,evidence
            except Exception:
                try:await save_browser_diagnostics(page,evidence,OUT)
                finally:await context.close()
                raise
        async def extras(resource,user):
            await browser_extras.check_form(resource[1],user,guard)
        async def scenario(resource,user,fixture):
            context,page,evidence=resource
            evidence['phase']='submission '+fixture['name']
            result={};external=evidence['blockedExternal'];errors=evidence['pageErrors']
            upload_photo=fixture['name']=='lamp' and user['role'] in ['housekeeping','front_desk']
            attachment_responses=[]
            def capture(response):
                if '/attachments' in response.url and response.request.method=='POST':attachment_responses.append(response)
            try:
                with response_listener(page,capture,upload_photo):
                    await browser_extras.set_language(page,'en')
                    await page.goto('http://127.0.0.1:3112/work-orders', timeout=120000)
                    issue = page.get_by_placeholder('Example: 316 not cooling')
                    await issue.wait_for(timeout=60000)
                    await issue.fill(fixture['room'] + ' ' + fixture['issue'] + '\nGuest is leaving at 5 PM')
                    await page.get_by_placeholder('Optional: findings, diagnostic codes, readings, tests, or work already performed').fill('Ya se reemplazó el control remoto.' if fixture['name']=='manufacturer' else 'Remote was already replaced.')
                    if user['label'] in ['Assistant General Manager', 'Front Desk Manager', 'Front Desk']:
                        await page.get_by_placeholder('First name').fill('Casey', timeout=15000)
                    if upload_photo:
                        await page.locator('#work-order-photo-file').set_input_files([{'name':name+'.png','mimeType':'image/png','buffer':base64.b64decode(photos[name])} for name in ['wrong','right']])
                        remove=page.get_by_role('button',name='Remove selected photo: wrong.png',exact=True)
                        color=await remove.evaluate('e=>getComputedStyle(e).color')
                        assert color == 'rgb(239, 68, 68)' or 'oklch(' in color,color
                        await remove.click()
                        await expect(page.get_by_role('button',name='Remove selected photo: wrong.png',exact=True)).to_have_count(0)
                        await expect(page.get_by_role('button',name='Remove selected photo: right.png',exact=True)).to_be_visible()
                    # Await real preview inference before submitting; no intercepted app responses.
                    await page.wait_for_timeout(800)
                    async with page.expect_response(lambda response: '/api/work-orders' in response.url and response.request.method == 'POST', timeout=60000) as pending:
                        await page.locator('button[type="submit"]').first.click()
                    response = await pending.value
                    result['httpStatus'] = response.status
                    result['response'] = await response.json()
                    assert response.status == 200, result['response']
                    rows = rows_for(user['id'], fixture['location_id'])
                    result['rows'] = rows
                    assert_saved_row(rows,fixture,('Ya se reemplazó el control remoto.' if fixture['name']=='manufacturer' else 'Remote was already replaced.')+'\nGuest is leaving at 5 PM')
                    if upload_photo:
                        for _ in range(200):
                            if attachment_responses: break
                            await page.wait_for_timeout(100)
                        assert len(attachment_responses)==1, 'Exactly the retained photo must upload'
                        assert attachment_responses[0].status==200, await attachment_responses[0].text()
                        result['retainedPhotoUploadStatus']=200
                        result['removedPhotoNoRequest']=True
                        assert rows[0]['status']=='Pending Verification',rows
                    assert not external, external
                    assert not errors, errors
            except Exception as error:
                error.evidence=result
                raise
            finally:
                try:await page.screenshot(path=str(OUT/f"{user['role']}-{fixture['name']}.png"),full_page=True)
                except Exception as error:record({'role':user['label'],'phase':'screenshot '+fixture['name'],'status':'FAIL','passed':False,'errorType':type(error).__name__,'error':str(error)})
            return result
        async def close_role(resource,user):
            context,page,evidence=resource
            try:await save_browser_diagnostics(page,evidence,OUT)
            finally:await context.close()
        try:await matrix(users,open_role,extras,scenario,close_role,record,guard)
        except HardStop as error:
            hard_stop=True
            record({'phase':'global hard stop','status':'FAIL','passed':False,'error':str(error)})
            existing={(r.get('role'),r.get('scenario')) for r in results if r.get('scenario')}
            for user in users:
                for fixture in user['fixtures']:
                    if (user['label'],fixture['name']) not in existing:
                        record({'role':user['label'],'storedRole':user['role'],'scenario':fixture['name'],'status':'BLOCKED','passed':False,'error':'Global shared prerequisite/isolation failure'})
        finally:await browser.close()
    if hard_stop:raise SystemExit(2)
    scenarios=[r for r in results if r.get('scenario')]
    assert len(scenarios)==28 and all(r['passed'] for r in results) and all(r['passed'] for r in browser_extras.RESULTS),'Incomplete or failed checks; see e2e-results.json'

if __name__=='__main__':asyncio.run(main())
