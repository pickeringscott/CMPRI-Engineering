# Isolated create-modal regression: synthetic APIs only, no external network.
import asyncio, json, os, time, base64, subprocess
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect
BASE = os.environ.get('CMPRI_TEST_BASE_URL', 'http://127.0.0.1:3116').rstrip('/')
assert urlparse(BASE).hostname == '127.0.0.1'
OUT = Path(os.environ.get('CMPRI_TEST_OUTPUT', '/tmp/cmpri-repeat-create'))
OUT.mkdir(parents=True, exist_ok=True)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==')
ROLES = ['front_desk', 'housekeeping', 'front_desk_manager', 'assistant_manager', 'manager', 'technician', 'engineer', 'chief_engineer', 'system_admin']
POLICY = json.loads(subprocess.check_output(['node','--experimental-strip-types','--input-type=module','-e',r'''
import {readFileSync} from 'node:fs';import {profileAllows} from './src/lib/server/roles.ts';
const caps=[...readFileSync('./src/lib/server/roles.ts','utf8').matchAll(/\| "([a-z_]+)"/g)].map(m=>m[1]);caps.push('submit');
console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(role=>[role,[...new Set(caps.filter(c=>profileAllows({role},c)))]]))));
''', json.dumps(ROLES)], text=True))

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
  for role in ROLES:
   for width in [384,1360]:
    langs=['en','es'] if role in ROLES[:5] else ['en']
    for lang in langs:
     technical=role in ROLES[5:]
     ctx=await browser.new_context(viewport={'width':width,'height':915}, is_mobile=width<640, has_touch=width<640)
     session={'access_token':'fixture-token','refresh_token':'fixture-refresh','expires_at':int(time.time())+7200,'expires_in':7200,'token_type':'bearer','user':{'id':'fixture-user','email':'fixture@example.invalid'}}
     await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(session))+');localStorage.setItem("cmpri:work-order-language",'+json.dumps(lang)+');')
     state={'fail':True,'posts':[],'deleted':[],'uploads':0,'own':True}
     async def route(r):
      u=urlparse(r.request.url);q=parse_qs(u.query);method=r.request.method
      if u.hostname!='127.0.0.1':return await r.abort()
      if u.path=='/fixture-host':
       return await r.fulfill(content_type='text/html',body='<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><iframe style="border:0;width:100%;height:100vh" src="/work-orders?embedded=1&modalToken=fixture"></iframe><script>window.events=[];addEventListener("message",e=>{events.push(e.data);if(e.data.type==="cmpri-work-order-cancelled")document.querySelector("iframe").remove()})</script></body></html>')
      if not u.path.startswith('/api/'):return await r.continue_()
      body={};status=200
      if u.path=='/api/session':body={'user':{'id':'fixture-user','name':'Fixture User','email':'fixture@example.invalid','role':role},'landing':'/engineering','capabilities':POLICY[role]}
      elif u.path=='/api/profile':body={'preferences':{'appearance':'dark','language':lang}}
      elif u.path=='/api/rooms':body={'locations':[{'id':'location-219','name':'Room 219','location_type':'Guest Room'}]}
      elif u.path=='/api/assets':body={'assets':[]}
      elif u.path=='/api/work-orders/drafts':
       if method=='DELETE':
        draft_id=q.get('id',[''])[0];state['deleted'].append(draft_id);assert draft_id=='own';state['own']=False;body={'ok':True}
       else:body={'drafts':([{'id':'own','revision':1,'created_by':'fixture-user','room':'Room 219','location_id':'location-219','issue':'Saved draft lamp issue','notes':'Draft reporter notes','staff_first_name':'Fixture','category':'General','priority':'Medium','can_delete':True,'can_edit':True}] if state['own'] else [])+[{'id':'other','revision':1,'created_by':'other-user','issue':'Another users private draft','can_edit':True,'can_delete':True}]}
      elif u.path=='/api/work-orders':
       if method=='POST':
        state['posts'].append(r.request.post_data_json)
        await asyncio.sleep(.2)
        if state['fail']:status=503;body={'error':'Fixture save failed'}
        else:body={'ok':True,'work_orders':[{'id':'00000000-0000-4000-8000-000000000042','display_id':f"WO-FIXTURE-{len(state['posts'])}",'status':'Open'}]}
       else:body={'work_orders':[]}
      elif u.path.endswith('/attachments'):
       if method=='POST':state['uploads']+=1;body={'ok':True}
       else:body={'images':[]}
      await r.fulfill(status=status,content_type='application/json',body=json.dumps(body))
     await ctx.route('**/*',route)
     page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     await page.goto(BASE+'/fixture-host');frame=page.frame_locator('iframe')
     await frame.locator('textarea').first.wait_for(timeout=60000)
     async def fill(issue):
      first=frame.locator('input[name="staff-first-name"]')
      if await first.count():await first.fill('Fixture')
      room=frame.get_by_role('combobox').first;await room.fill('219');await frame.get_by_role('option').filter(has_text='Room 219').first.click()
      await frame.locator('textarea').first.fill(issue)
      await frame.locator('textarea').nth(1).fill('Guest reported a flickering lamp.')
     issue='Bedside lamp flickers'
     await fill(issue)
     await frame.locator('#work-order-photo-file').set_input_files({'name':'fixture.png','mimeType':'image/png','buffer':PNG})
     submit=frame.locator('button[type="submit"]')
     await submit.click();await frame.get_by_text('Fixture save failed',exact=True).wait_for()
     await expect(frame.locator('textarea').first).to_have_value(issue)
     assert state['uploads']==0
     state['fail']=False
     await submit.evaluate('b=>{b.form.requestSubmit();b.form.requestSubmit()}')
     if technical:
      await page.wait_for_function('events.some(e=>e.type==="cmpri-work-order-created")')
      assert len(state['posts'])==2
     else:
      await expect(frame.locator('textarea').first).to_have_value('')
      await frame.get_by_text('WO-FIXTURE-2',exact=False).wait_for()
      assert len(state['posts'])==2 and state['uploads']==1
      assert not await page.evaluate('events.some(e=>e.type==="cmpri-work-order-created")')
      await expect(submit).to_be_enabled()
      assert await page.evaluate('localStorage.getItem("cmpri:work-order-language")')==lang
      await fill('Desk lamp does not turn on');await submit.click()
      await expect(frame.locator('textarea').first).to_have_value('')
      await frame.get_by_text('WO-FIXTURE-3',exact=False).wait_for()
      assert len(state['posts'])==3 and state['uploads']==1 # submitted photos are not reused
      # Restore and submit only this user's draft; another user's draft is never deleted.
      await page.locator('iframe').evaluate('e=>e.src="/work-orders?embedded=1&modalToken=fixture&draftId=own"')
      await expect(frame.locator('textarea').first).to_have_value('Saved draft lamp issue')
      await submit.click();await expect(frame.locator('textarea').first).to_have_value('')
      assert state['posts'][-1]['source_draft_id']=='own'
      assert state['deleted']==['own']
      assert not await frame.get_by_text('Another users private draft',exact=False).count()
      assert await frame.locator("body").evaluate("e=>document.documentElement.scrollWidth<=innerWidth")
      await page.screenshot(path=str(OUT/f'{role}-{width}-{lang}.png'))
      # Empty successful form can close and reopen without stale inputs/photos/draft state.
      await frame.get_by_role('button',name='Cancelar' if lang=='es' else 'Cancel',exact=True).click()
      await expect(page.locator('iframe')).to_have_count(0)
      await page.goto(BASE+'/fixture-host');frame=page.frame_locator('iframe')
      await expect(frame.locator('textarea').first).to_have_value('')
      await fill('Unsaved issue');await frame.get_by_role('button',name='Cancelar' if lang=='es' else 'Cancel',exact=True).click()
      await frame.get_by_role('button',name='Seguir editando' if lang=='es' else 'Keep Editing').click()
      await expect(frame.locator('textarea').first).to_have_value('Unsaved issue')
     assert not errors,errors
     results.append({'role':role,'width':width,'language':lang,'technical_behavior_preserved':technical,'passed':True})
     await ctx.close()
  await browser.close()
 OUT.joinpath('results.json').write_text(json.dumps(results,indent=2));print(f'Passed {len(results)} create cases')
if __name__ == '__main__':
 asyncio.run(main())
