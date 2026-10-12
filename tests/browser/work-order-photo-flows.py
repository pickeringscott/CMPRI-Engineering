# Requires Python Playwright and local Chromium. Start the isolated Next dev server first.
# Run: CMPRI_TEST_BASE_URL=http://127.0.0.1:3116 python tests/browser/work-order-photo-flows.py
# Every API is intercepted; external requests are blocked. No live credentials or data.
import asyncio,json,time,base64,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
BASE=os.environ.get('CMPRI_TEST_BASE_URL','http://127.0.0.1:3116').rstrip('/')
assert urlparse(BASE).hostname=='127.0.0.1', 'Use an isolated local Next server only'
OUT=Path(os.environ.get('CMPRI_TEST_OUTPUT','/tmp/cmpri-photo-browser'))
OUT.mkdir(parents=True,exist_ok=True)
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==')
ID='00000000-0000-4000-8000-000000000042'
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for role in ['housekeeping','front_desk']:
   for lang in ['en','es']:
    ctx=await browser.new_context(viewport={'width':412,'height':915},is_mobile=True,has_touch=True)
    sess={'access_token':'fixture-token','refresh_token':'fixture-refresh','expires_at':int(time.time())+7200,'expires_in':7200,'token_type':'bearer','user':{'id':'fixture-user','email':'fixture@example.invalid'}}
    await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(sess))+');localStorage.setItem("cmpri:work-order-language",'+json.dumps(lang)+');')
    state={'orders':[],'saved':[], 'fail':False,'engineering':False,'draft':None,'deletes':0,'deleteFail':False}
    async def route(r):
     u=urlparse(r.request.url);method=r.request.method;status=200;body={}
     if u.hostname!='127.0.0.1':return await r.abort()
     if u.path=='/fixture.png':return await r.fulfill(content_type='image/png',body=PNG)
     if not u.path.startswith('/api/'):return await r.continue_()
     if u.path=='/api/session':body={'user':{'id':'fixture-user','name':'Fixture','email':'fixture@example.invalid','role':'engineer' if state['engineering'] else role,'secondary_roles':[]},'landing':'/engineering' if state['engineering'] else '/work-orders','hotelId':'fixture-hotel','capabilities':['submit','view_work_orders','add_work_order_notes']+(['view_dashboard','edit_tickets','review_tickets'] if state['engineering'] else [])}
     elif u.path=='/api/profile':body={'profile':{'full_name':'Fixture','role':role},'preferences':{'appearance':'dark','language':'en' if state['engineering'] else lang}}
     elif u.path=='/api/rooms':body={'locations':[{'id':'location-219','name':'Room 219','location_type':'Guest Room'}]}
     elif u.path=='/api/assets':body={'assets':[]}
     elif u.path=='/api/work-orders/drafts':
      if method=='DELETE':
       state['deletes']+=1
       if state['deleteFail']:status=503;body={'error':'Fixture draft deletion unavailable'}
       else:state['draft']=None;body={'ok':True}
      elif method=='POST':
       state['draft']={**r.request.post_data_json,'id':'draft-fixture','revision':1,'created_by':'fixture-user','updated_at':'2026-10-12T12:00:00Z'};body={'draft':state['draft']}
      else:body={'drafts':[state['draft']] if state['draft'] else []}
     elif u.path=='/api/work-orders':
      if method=='POST':
       payload=r.request.post_data_json;state['orders'].append(payload);body={'ok':True,'work_orders':[{'id':ID,'display_id':'workorder_fixture','status':'Pending Verification'}]}
      else:body={'work_orders':[]}
     elif u.path.endswith('/attachments'):
      if method=='POST':
       if state['fail']:status=503;body={'error':'Fixture storage unavailable'}
       else:
        assert PNG in r.request.post_data_buffer
        state['saved'].append({'id':'persisted.png','name':'persisted.png','url':BASE+'/fixture.png'});body={'ok':True}
      else:body={'images':state['saved']}
     elif u.path==f'/api/work-orders/{ID}':
      row=state['orders'][-1]['orders'][0];body={'workOrder':{**row,'id':ID,'display_id':'workorder_fixture','room':'Room 219','status':'Pending Verification','created_by':'fixture-user','created_at':'2026-10-12T12:00:00Z'},'mentionTickets':[]}
     elif u.path=='/api/maintenance-reference':body={'assets':[],'technicians':[]}
     elif u.path.endswith('/activity'):body={'activity':[]}
     await r.fulfill(status=status,content_type='application/json',body=json.dumps(body))
    await ctx.route('**/*',route);page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/work-orders')
    cancel='Cancelar' if lang=='es' else 'Cancel';confirm='Confirmar cancelación' if lang=='es' else 'Confirm Cancel';keep='Seguir editando' if lang=='es' else 'Keep Editing'
    await page.get_by_role('button',name=cancel,exact=True).wait_for(timeout=60000)
    files=[{'name':f'fixture-{i}.png','mimeType':'image/png','buffer':PNG} for i in range(2)]
    await page.locator('#work-order-photo-file').set_input_files(files)
    remove=page.get_by_role('button',name=('Quitar foto seleccionada' if lang=='es' else 'Remove selected photo'))
    await expect(remove).to_have_count(2)
    button=await remove.first.bounding_box();preview=await remove.first.locator('..').bounding_box();assert button['x']<=preview['x'] and button['y']<=preview['y']
    await remove.first.click();await expect(remove).to_have_count(1);assert not state['orders'] and not state['saved']
    await page.get_by_role('button',name=cancel,exact=True).click();await page.get_by_role('button',name=keep,exact=True).click();await expect(remove).to_have_count(1)
    await page.get_by_role('button',name=cancel,exact=True).click();await page.get_by_role('button',name=confirm,exact=True).click();await expect(remove).to_have_count(0);assert not state['orders']
    async def fill():
     if role=='front_desk':await page.locator('input[name="staff-first-name"]').fill('María')
     room=page.get_by_role('combobox').first;await room.fill('219');await page.get_by_role('option').filter(has_text='Room 219').first.click()
     await page.locator('textarea').first.fill('La manija de la ducha está rota' if lang=='es' else 'Shower handle broken')
     await page.locator('textarea').nth(1).fill('Habitación vacía. No se cambió ninguna pieza.' if lang=='es' else 'Empty room. No parts replaced.')
    state['draft']={'id':'draft-fixture','revision':1,'created_by':'fixture-user','location_id':'location-219','issue':'Saved draft issue','notes':'Saved draft notes','staff_first_name':'María','category':'General','priority':'Medium','updated_at':'2026-10-12T12:00:00Z'}
    await page.goto(BASE+'/work-orders?draftId=draft-fixture')
    await expect(page.locator('textarea').first).to_have_value('Saved draft issue')
    await page.locator('#work-order-photo-file').set_input_files(files[:1])
    state['deleteFail']=True
    await page.get_by_role('button',name=cancel,exact=True).click();await page.get_by_role('button',name=confirm,exact=True).click()
    await page.get_by_text('Fixture draft deletion unavailable',exact=True).wait_for();await expect(remove).to_have_count(1);assert state['draft'] is not None
    state['deleteFail']=False
    await page.get_by_role('button',name=confirm,exact=True).click();await expect(remove).to_have_count(0);assert state['draft'] is None and not state['orders'];state['deletes']=0
    await fill();await page.locator('#work-order-photo-file').set_input_files(files[:1]);state['fail']=True
    await page.locator('button[type="submit"]').click();await page.get_by_text('Fixture storage unavailable',exact=False).wait_for()
    assert len(state['orders'])==1 and len(state['saved'])==0
    await expect(page.get_by_role('button',name=cancel,exact=True)).to_be_enabled()
    await page.get_by_role('button',name=cancel,exact=True).click()
    await page.get_by_text('La orden ya existe.' if lang=='es' else 'The work order already exists.',exact=False).wait_for()
    await page.get_by_role('button',name=keep,exact=True).click();assert len(state['orders'])==1
    await page.get_by_role('button',name=cancel,exact=True).click();await page.get_by_role('button',name=confirm,exact=True).click()
    await expect(page.locator('textarea').first).to_have_value('');assert len(state['orders'])==1 and state['deletes']==0
    state['fail']=False;await fill();await page.locator('#work-order-photo-file').set_input_files(files[:1]);await page.locator('button[type="submit"]').click()
    await page.wait_for_timeout(1200);assert len(state['orders'])==2 and len(state['saved'])==1
    row=state['orders'][-1]['orders'][0];assert row['location_id']=='location-219';assert row['notes']==('Habitación vacía. No se cambió ninguna pieza.' if lang=='es' else 'Empty room. No parts replaced.')
    state['engineering']=True
    await page.goto(f'{BASE}/work-orders/{ID}')
    await page.get_by_role('heading',name='Photos (1)',exact=True).wait_for(timeout=60000)
    note=await page.get_by_role('heading',name='Technician Notes',exact=True).bounding_box();photos=await page.get_by_role('heading',name='Photos (1)',exact=True).bounding_box();assert photos['y']>note['y']
    await expect(page.get_by_role('button',name='Open work-order photo',exact=True)).to_be_visible()
    await expect(page.get_by_text(row['issue'],exact=True).first).to_be_visible()
    await expect(page.get_by_text(row['notes'],exact=True).first).to_be_visible()
    await page.screenshot(path=str(OUT/f'expanded-{role}-{lang}-saved.png'),full_page=True)
    assert not errors,errors
    results.append({'role':role,'language':lang,'passed':True,'submitted_issue':row['issue'],'notes':row['notes'],'translation':'Spanish retained unchanged; no translator exists' if lang=='es' else 'English original','scope':'browser with local API fixtures; real handler persistence covered separately'})
    await ctx.close()
  await browser.close()
 OUT.joinpath('expanded-browser-results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False));print(json.dumps(results,ensure_ascii=False))
asyncio.run(main())
