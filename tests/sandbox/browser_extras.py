# Real browser interactions; no route response fixtures.
import json
import base64
import subprocess
from pathlib import Path
from playwright.async_api import expect
OUT = Path(__file__).resolve().parents[2] / '.sandbox'
RESULTS = []

def snapshot():
    query = "select json_build_object('orders',(select count(*) from work_orders),'objects',(select count(*) from storage.objects),'drafts',(select count(*) from cmpri_work_order_drafts))"
    r = subprocess.run(['docker','exec','supabase_db_cmpri-seven-role-isolated-qa','psql','-U','postgres','-d','postgres','-At','-c',query],capture_output=True,text=True,check=True)
    return json.loads(r.stdout.strip())

async def check_form(page,user):
    drafts=json.loads((OUT/'draft-fixtures.json').read_text())
    own=next(d for d in drafts if d['created_by']==user['id'])
    other=next(d for d in drafts if d['created_by']!=user['id'])
    await page.goto('http://127.0.0.1:3112/work-orders?draftId='+other['id'])
    await page.get_by_text(own['room']+' · '+own['issue'],exact=True).wait_for(timeout=30000)
    assert not await page.get_by_text(other['room']+' · '+other['issue'],exact=True).count()
    await expect(page.locator('textarea').first).to_have_value('')
    RESULTS.append({'role':user['label'],'phase':'Create form own draft isolation','passed':True})
    if user['role']=='chief_engineer':
        await page.goto('http://127.0.0.1:3112/work-orders?draftId='+other['id']+'&reviewDraft=1')
        await expect(page.locator('textarea').first).to_have_value(other['issue'],timeout=30000)
        await expect(page.get_by_role('button',name='Approve & Submit Draft')).to_be_visible()
        RESULTS.append({'role':user['label'],'phase':'Explicit reviewer draft browser access','passed':True})
    for lang in ['en','es']:
        await page.goto('http://127.0.0.1:3112/work-orders')
        await page.get_by_placeholder('Example: 316 not cooling').wait_for(timeout=30000)
        # Exercise the application's existing profile-language update event.
        await page.evaluate('(language)=>window.postMessage({type:"cmpri-profile-preferences-updated",preferences:{language}},location.origin)',lang)
        issue=page.locator('textarea').first
        await issue.fill('Trabajo sin guardar — lámpara' if lang=='es' else 'Unsaved lamp issue')
        await page.locator('#work-order-photo-file').set_input_files({'name':'cancel-photo.png','mimeType':'image/png','buffer':base64.b64decode(json.loads((Path(__file__).parent/'photo-fixtures.json').read_text())['wrong'])})
        cancel='Cancelar' if lang=='es' else 'Cancel'
        keep='Seguir editando' if lang=='es' else 'Keep Editing'
        confirm='Confirmar cancelación' if lang=='es' else 'Confirm Cancel'
        before=snapshot()
        await page.get_by_role('button',name=cancel,exact=True).click()
        dialog=page.get_by_role('dialog')
        await expect(dialog).to_be_visible()
        await dialog.get_by_role('button',name=keep,exact=True).click()
        await expect(page.locator('[aria-label="Selected photo previews"]')).to_be_visible()
        assert await issue.input_value()
        await page.get_by_role('button',name=cancel,exact=True).click()
        await page.get_by_role('dialog').get_by_role('button',name=confirm,exact=True).click()
        await expect(page.get_by_role('dialog')).to_have_count(0)
        await page.wait_for_timeout(300)
        await page.goto('http://127.0.0.1:3112/work-orders')
        await page.get_by_placeholder('Example: 316 not cooling').wait_for()
        await expect(page.locator('textarea').first).to_have_value('')
        await expect(page.locator('[aria-label="Selected photo previews"]')).to_have_count(0)
        assert snapshot()==before,'Cancel changed stored orders/photos/drafts'
        RESULTS.append({'role':user['label'],'phase':'Cancel with selected photo','language':lang,'keepEditingPreserved':True,'noPersistenceChanges':True,'passed':True})

def save():
    (OUT/'browser-extra-results.json').write_text(json.dumps(RESULTS,indent=2))
