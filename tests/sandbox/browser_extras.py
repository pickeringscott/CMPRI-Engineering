# Real browser interactions; no route response fixtures.
import json
import base64
import subprocess
from pathlib import Path
from playwright.async_api import expect
from collection import case,Blocked,HardStop
OUT = Path(__file__).resolve().parents[2] / '.sandbox'
RESULTS = []

def snapshot():
    query = "select json_build_object('orders',(select count(*) from work_orders),'objects',(select count(*) from storage.objects),'drafts',(select count(*) from cmpri_work_order_drafts))"
    r = subprocess.run(['docker','exec','supabase_db_cmpri-seven-role-isolated-qa','psql','-U','postgres','-d','postgres','-At','-c',query],capture_output=True,text=True,check=True)
    return json.loads(r.stdout.strip())

async def set_language(page,language):
    # Persist the synthetic user's preference before loading a new form; no message race.
    result=await page.evaluate("""async language=>{
      const s=JSON.parse(sessionStorage.getItem('cmpri:auth:v1')||localStorage.getItem('cmpri:auth:v1')||'null');
      if(!s?.access_token)return {ok:false,phase:'session'};
      const headers={Authorization:'Bearer '+s.access_token,'Content-Type':'application/json'};
      const prior=await fetch('/api/profile',{headers});
      if(!prior.ok)return {ok:false,phase:'read profile',status:prior.status};
      const body=await prior.json();
      const saved=await fetch('/api/profile',{method:'PATCH',headers,body:JSON.stringify({preferences:{...body.preferences,language}})});
      if(!saved.ok)return {ok:false,phase:'save profile',status:saved.status};
      const read=await fetch('/api/profile',{headers,cache:'no-store'});const actual=await read.json();
      return {ok:read.ok&&actual.preferences?.language===language,status:read.status,language:actual.preferences?.language};
    }""",language)
    assert result.get('ok'),f'Profile language was not confirmed: {result}'

async def check_form(page,user,guard):
    def record(result):RESULTS.append(result);save()
    async def draft_case(review=False):
        path=OUT/'draft-fixtures.json'
        drafts=json.loads(path.read_text()) if path.exists() else []
        own=next((d for d in drafts if d['created_by']==user['id']),None)
        other=next((d for d in drafts if d['created_by']!=user['id']),None)
        if not own or not other:raise Blocked('Own and other draft fixtures required')
        await page.goto('http://127.0.0.1:3112/work-orders?draftId='+other['id']+('&reviewDraft=1' if review else ''))
        if review:
            await expect(page.locator('textarea').first).to_have_value(other['issue'],timeout=30000)
            await expect(page.get_by_role('button',name='Approve & Submit Draft')).to_be_visible()
        else:
            await page.get_by_text(own['room']+' · '+own['issue'],exact=True).wait_for(timeout=30000)
            assert not await page.get_by_text(other['room']+' · '+other['issue'],exact=True).count()
            await expect(page.locator('textarea').first).to_have_value('')
    await case({'role':user['label'],'phase':'Create form own draft isolation'},draft_case,record,guard)
    if user['role']=='chief_engineer':
        await case({'role':user['label'],'phase':'Explicit reviewer draft browser access'},lambda:draft_case(True),record,guard)
    async def cancel_case(lang):
        await set_language(page,lang)
        await page.goto('http://127.0.0.1:3112/work-orders')
        cancel='Cancelar' if lang=='es' else 'Cancel'
        keep='Seguir editando' if lang=='es' else 'Keep Editing'
        confirm='Confirmar cancelación' if lang=='es' else 'Confirm Cancel'
        await expect(page.get_by_role('button',name=cancel,exact=True)).to_be_visible()
        issue=page.locator('textarea').first
        await issue.fill('Trabajo sin guardar — lámpara' if lang=='es' else 'Unsaved lamp issue')
        await page.locator('#work-order-photo-file').set_input_files({'name':'cancel-photo.png','mimeType':'image/png','buffer':base64.b64decode(json.loads((Path(__file__).parent/'photo-fixtures.json').read_text())['wrong'])})
        before=snapshot()
        await page.get_by_role('button',name=cancel,exact=True).click()
        dialog=page.get_by_role('dialog');await expect(dialog).to_be_visible()
        await dialog.get_by_role('button',name=keep,exact=True).click()
        await expect(page.locator('[aria-label="Selected photo previews"]')).to_be_visible();assert await issue.input_value()
        await page.get_by_role('button',name=cancel,exact=True).click()
        await page.get_by_role('dialog').get_by_role('button',name=confirm,exact=True).click()
        await expect(page.get_by_role('dialog')).to_have_count(0)
        await page.wait_for_timeout(300)
        await page.goto('http://127.0.0.1:3112/work-orders')
        await expect(page.locator('textarea').first).to_have_value('')
        await expect(page.locator('[aria-label="Selected photo previews"]')).to_have_count(0)
        assert snapshot()==before,'Cancel changed stored orders/photos/drafts'
        return {'keepEditingPreserved':True,'noPersistenceChanges':True}
    for lang in ['en','es']:
        await case({'role':user['label'],'phase':'Cancel with selected photo','language':lang},lambda:cancel_case(lang),record,guard)
    await case({'role':user['label'],'phase':'restore fixture English preference'},lambda:set_language(page,'en'),record,guard)

def save():
    from diagnostics import sanitize,local_secrets
    (OUT/'browser-extra-results.json').write_text(json.dumps(sanitize(RESULTS,local_secrets(OUT)),indent=2))
