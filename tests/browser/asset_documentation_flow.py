import json,asyncio
from cmpri_fixture import *

async def main():
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  c=await b.new_context(viewport={'width':1365,'height':900});await install(c,'chief_engineer')
  asset={'id':'00000000-0000-4000-8000-000000000005','name':'Washer #1','asset_type':'Washer','location_id':'loc-1','manufacturer':'UniMac','model_number':'UWN','serial_number':'150','active':True,'updated_at':'2026-01-01T00:00:00Z'}
  identity={'asset_id':asset['id'],'manufacturer':'UniMac','model_number':'UWN','model_family':'','serial_number':'150'}
  doc={'object_id':'00000000-0000-4000-8000-000000000010','title':'Washer service manual','storage_path':'Asset Docs/washer.pdf','size':12,'catalog_status':'complete'}
  state={'version':asset['updated_at'],'saved':False,'verified':False,'patch':None,'sent':None}
  async def api(route):
   u=urlparse(route.request.url);q=parse_qs(u.query);req=route.request
   if u.path=='/api/assets':
    if req.method=='PATCH':
     body=req.post_data_json;state['patch']=body
     if body.get('expected_updated_at')!=state['version']:return await route.fulfill(status=409,json={'error':'stale asset version'})
     state['verified']=True;return await route.fulfill(json={'ok':True})
    return await route.fulfill(json={'assets':[{**asset,'updated_at':state['version'],'documentation_verified':state['verified']}],'can_manage':True})
   if u.path=='/api/rooms':return await route.fulfill(json={'locations':[{'id':'loc-1','name':'Laundry','area':'Back of House','active':True}]})
   if u.path=='/api/assets/documentation':
    if req.method=='GET' and q.get('mode')==['consolidation']:return await route.fulfill(json={'ready':True})
    if req.method=='GET' and q.get('mode')==['stored']:return await route.fulfill(json={'files':[doc],'links':[],'updated_at':state['version'],'asset_identity':identity})
    if req.method=='GET':return await route.fulfill(json={'documents':[{'name':doc['title'],'id':doc['object_id'],'storage_path':doc['storage_path'],'url':'https://example.test/manual.pdf'}] if state['saved'] else [],'verified':state['verified']})
    body=req.post_data or ''
    if 'name="import_action"\r\n\r\nupload_prepare' in body:return await route.fulfill(json={'signed_url':BASE+'/test-upload','already_uploaded':False})
    if 'name="import_action"\r\n\r\nupload_complete' in body:return await route.fulfill(json={'file':doc,'sha256':'a'*64,'url':'https://example.test/manual.pdf','saved_fields':None,'suggestions':None,'readable_text':True,'asset_identity':identity,'updated_at':state['version']})
    if 'name="import_action"\r\n\r\nreview' in body:return await route.fulfill(json={'file':doc,'sha256':'a'*64,'url':'https://example.test/manual.pdf','saved_fields':None,'suggestions':None,'readable_text':True,'asset_identity':identity,'updated_at':state['version']})
    if 'name="import_action"\r\n\r\nsave' in body:
     state['sent']=body;state['saved']=True;state['version']='2026-01-02T00:00:00Z';return await route.fulfill(json={'updated_at':state['version']})
    return await route.fulfill(status=400,json={'error':'Unexpected action'})
   if u.path=='/api/assets/photo':return await route.fulfill(status=404)
   if u.path=='/api/work-orders' and q.get('mode')==['asset']:return await route.fulfill(json={'work_orders':[]})
   return await route.fallback()
  await c.route('**/api/**',api)
  await c.route('**/test-upload',lambda route: route.fulfill(status=200,json={}))
  page=await c.new_page();await page.goto(BASE+'/engineering');await page.get_by_role('button',name='Assets',exact=True).wait_for(timeout=60000);await page.get_by_role('button',name='Assets',exact=True).click();shell=page.locator('[data-cmpri-desktop-window="/management/equipment"]');await shell.wait_for();frame=await (await shell.locator('iframe').element_handle()).content_frame();await frame.get_by_text('1 result',exact=True).wait_for(timeout=20000)
  await frame.get_by_label('Search equipment').fill('Washer');await frame.get_by_role('button',name='Washer #1 · UWN').click();await frame.get_by_role('button',name='Documentation',exact=True).click();await frame.get_by_role('button',name='Add Documentation').click();dialog=frame.get_by_role('dialog',name='');await dialog.get_by_label('Upload a PDF (up to 100 MB)').set_input_files(str(Path(__file__).resolve().parents[2] / 'public/guides/dormakaba.pdf'));await dialog.get_by_role('button',name='Upload and review').click();await dialog.get_by_text('Use this manual for this asset’s work-order troubleshooting').click();await dialog.get_by_role('button',name='Attach manual').click();await expect(dialog.get_by_text('Manual attached for this asset’s troubleshooting.')).to_be_visible();await dialog.get_by_role('button',name='Close',exact=True).click();await frame.get_by_role('button',name='Confirm with Documentation & Lock Fields').click();assert state['patch'] and state['patch']['expected_updated_at']=='2026-01-02T00:00:00Z',state;assert 'confirmed_model' in state['sent'];print('PASS: uploaded PDF reviewed, attached for troubleshooting, and asset verified with the new version',flush=True)
  await c.close();await b.close()
asyncio.run(main())
