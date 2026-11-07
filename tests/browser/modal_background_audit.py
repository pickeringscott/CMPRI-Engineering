"""Audit every painted modal element, including text, edges, SVGs, and pseudo-elements."""
from cmpri_fixture import *

ROUTES=[('/work-orders','Create Work Order'),('/work-orders/'+WID,'Work Order Detail'),('/engineering/room-operations','Daily Room Ops'),('/engineering/room-ranking','Room Ranker'),('/engineering/preventive-maintenance','Preventive Maintenance'),('/engineering/pool-log','Pool Log'),('/pool','Pool'),('/staff-notes','Staff Notes'),('/profile','Manage Profile'),('/engineering/hours-tracker','Hours Tracker'),('/management/rooms','Manage Locations'),('/management/users','Manage Users'),('/management/equipment','Assets'),('/engineering/parts','Inventory'),('/engineering/purchasing','PO'),('/engineering/gss','GSS Reports'),('/engineering/enseo-assignments','Enseo Assignments'),('/engineering/employment','Candidate questionnaires'),('/feedback','Feedback')]
SCAN=Path(__file__).with_name('modal_element_scan.js').read_text()

async def install_extras(ctx):
 locations=[{'id':'loc-1','name':'Room 204','room_number':'204','area':'Guest Rooms','location_type':'Guest Room','active':True},{'id':'lobby','name':'Lobby','room_number':None,'area':'Public Spaces','location_type':'Public Area','active':True}]
 async def extras(route):
  path=urlparse(route.request.url).path
  data=None
  if path=='/api/rooms':data={'locations':locations,'work_orders':orders,'pm_plans':[],'pm_completions':[],'can_edit':True,'can_manage_corporate_pm':True}
  elif path=='/api/preventive-maintenance':data={'entries':[],'workbook':{'daily':{},'weekly':{},'monthly':{},'rooms':[],'fetchedAt':'2026-11-06T12:00:00Z'},'review_queue':[],'locations':locations,'can_edit':True,'can_review':True,'spreadsheet_sync_enabled':False,'actor_id':UID,'actor_name':'Alex Morgan','access_roles':['Chief Engineer']}
  elif path=='/api/pool-log':
   facility={'id':'pool','pool_name':'Indoor Pool','facility_name':'CMPRI','sanitizer':'Bromine'}
   data={'facility':facility,'facilities':[facility],'log':None,'retests':[],'can_edit':True,'can_edit_saved':True}
  elif path=='/api/hours-tracker':data={'saved':None}
  elif path=='/api/ticket-room-ranker':data={'rooms':[{'id':'room-1','number':'204','floor':'2','rank':'B','issues':[{'id':WID,'issue':'Inspect fan','status':'Open','priority':'Normal'},{'id':'extra','issue':'Inspect light','status':'Open','priority':'Normal'}]}]}
  elif path=='/api/users':data={'users':[],'roles':['Chief Engineer','Front Desk']}
  elif path=='/api/engineering/purchase-orders':
   data={key:[] for key in ['cmpri_po_orders','cmpri_po_lines','cmpri_inventory_items','cmpri_po_receipts','cmpri_po_shipments','cmpri_po_sources']}
   data['cmpri_po_orders']=[{'id':'po-fixture','supplier':'Sample Supplier','origin':'manual','acceptance':'accepted','external_reference':'PO-1001','acceptance_note':None}]
   data['cmpri_po_lines']=[{'id':'line-fixture','order_id':'po-fixture','description':'Air filter','sku':'FILTER-1','ordered':4,'uom':'EA','inventory_item_id':'item-fixture','units_per_order_unit':1,'backordered':0,'backorder_note':None,'purchase_unit_price_cents':1200}]
   data['cmpri_inventory_items']=[{'id':'item-fixture','item_name':'Air filter','unit_of_measure':'EA','quantity_on_hand':2,'quantity_reserved':0,'active':True}]
  elif path=='/api/assets':data={'assets':[{'id':'asset-fixture','location_id':'loc-1','asset_type':'HVAC','name':'Sample Room Unit','asset_tag':'HVAC-204','active':True,'status':'Active','manufacturer':None,'model_family':None,'model_number':None,'serial_number':None,'generation':None,'install_year':None,'documentation_key':None}],'can_edit':True,'can_manage':True}
  elif path=='/api/assets/documentation':data={'documents':[],'verified':False,'catalog_warnings':[]}
  elif path=='/api/profile':data={'profile':{'id':UID,'full_name':'Alex Morgan','email':'fixture@example.invalid','role':'chief_engineer','active':True},'preferences':{'appearance':'dark','language':'en','notification_mode':'all','notifications':{}},'profile_settings_available':True,'can_manage_users':True,'chatgpt_connection':{'connected':True,'status':'active','access':'read_write'}}
  elif path=='/api/engineering/catalog':data={**{key:[] for key in ['vendors','contacts','proposals','inventory','compatibility','ideas','work_order_items','assets','locations']},'can_edit':True}
  elif path=='/api/enseo/assignments':data={'assets':[],'assignments':[],'locations':locations,'rows':[],'can_edit':True}
  elif path=='/api/employment':data={'applications':[{'id':'application-fixture','created_at':'2026-11-06T12:00:00Z','name':'Sample Applicant','email':'applicant@example.invalid'}],'application':{'id':'application-fixture','answers':{'name':'Sample Applicant','history':'Sample maintenance experience'}}}
  if data is not None:return await route.fulfill(json=data)
  await route.fallback()
 await ctx.route('**/api/**',extras)

async def audit_guides(browser,width,results):
 # Quick Guides belong to management; engineering roles intentionally lack this menu.
 ctx=await browser.new_context(viewport={'width':width,'height':1000},is_mobile=width<640,has_touch=width<640)
 await install(ctx,'manager')
 page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
 select=page.get_by_role('combobox',name='Front Desk Quick Guides',exact=True)
 for guide in ['enseo','dormakaba','guest-room']:
  await select.select_option(guide)
  viewer=page.locator('dialog[open]');await viewer.wait_for()
  await viewer.locator('canvas').first.wait_for(timeout=30000)
  scan=await page.evaluate(SCAN,'dialog[open],dialog[open] *');findings=scan['findings']
  assert scan['stats']['elements']>0,'Guide scan counted no elements'
  results.append({'width':width,'path':'quick-guide-'+guide,'state':'native PDF viewer','findings':findings,'scan':scan,'errors':errors[:]})
  print(json.dumps({'width':width,'path':'quick-guide-'+guide,'legacyNavy':len(findings),'errors':errors}),flush=True)
  OUT.joinpath('modal-background-audit.json').write_text(json.dumps(results,indent=2))
  await viewer.get_by_role('button',name='Close guide',exact=True).click()
 await ctx.close()

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  for width in map(int,os.environ.get('CMPRI_MODAL_WIDTHS','390,1440').split(',')):
   ctx=await browser.new_context(viewport={'width':width,'height':1000},is_mobile=width<640,has_touch=width<640)
   await install(ctx,'chief_engineer');await install_extras(ctx)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
   await page.wait_for_timeout(600)
   for path,title in ROUTES:
    selected=os.environ.get('CMPRI_MODAL_PATHS','').split(',')
    if selected!=[''] and path not in selected:continue
    start=len(errors)
    await page.evaluate("d=>window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:d}))",{'href':path,'title':title})
    shell=page.locator('.cmpri-modal-shell').last;await shell.wait_for()
    frame=await (await shell.locator('iframe').element_handle()).content_frame()
    await frame.locator('html[data-cmpri-modal-theme=true]').wait_for(state='attached',timeout=60000)
    await frame.locator('main').first.wait_for(timeout=60000);await frame.wait_for_timeout(600)
    async def record(state):
     scan=await frame.evaluate(SCAN);findings=scan['findings']
     assert scan['stats']['elements']>0,(path,state,'Frame scan counted no elements')
     row={'width':width,'path':path,'state':state,'findings':findings,'scan':scan,'errors':errors[start:]}
     results.append(row);print(json.dumps({'width':width,'path':path,'state':state,'legacyNavy':len(findings),'errors':errors[start:]}),flush=True)
     OUT.joinpath('modal-background-audit.json').write_text(json.dumps(results,indent=2))
     if state in ['inspection form','Edit Location','GIF picker','Edit Items']:
      await page.screenshot(path=str(OUT/(str(width)+'-'+state.replace(' ','-')+'.png')))
    await record('initial')
    neutral=frame.locator('button[class*="bg-slate-"],button[class*="bg-sky-"],button[class*="bg-cyan-"]').filter(visible=True)
    if await neutral.count():
     await neutral.first.hover();await record('hovered control')
    if await frame.locator('details').count():
     await frame.locator('details').evaluate_all('es=>es.forEach(e=>e.open=true)');await record('expanded details')
    if path=='/management/rooms':
     await frame.locator('.location-toggle').first.click();await record('expanded location')
     await frame.get_by_role('button',name='Edit Location',exact=True).click();await record('Edit Location')
     await frame.get_by_role('dialog',name='Edit Location').get_by_role('button',name='Cancel',exact=True).click()
     await frame.get_by_role('button',name='Add Location',exact=True).click();await record('Add Location')
     await frame.get_by_role('dialog',name='Add Location').get_by_role('button',name='Cancel',exact=True).click()
    elif path=='/engineering/pool-log':
     await frame.get_by_role('button',name='Pool Specs',exact=True).click();await record('Pool Specs')
     await frame.get_by_role('button',name='Close Pool Specs',exact=True).click()
    elif path=='/engineering/room-operations':
     cards=frame.locator('section.grid.grid-cols-2 > button')
     for i in range(await cards.count()):
      await cards.nth(i).click();await record('room summary '+str(i+1))
      await frame.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
     await frame.get_by_role('button',name='Upload Room Ops',exact=True).click();await record('import panel')
    elif path=='/engineering/room-ranking':
     await frame.get_by_role('button',name='2nd Floor',exact=False).click();await record('expanded floor')
     await frame.get_by_role('button',name='Show 1 additional issues for room 204',exact=True).click();await record('additional room issues')
     await frame.locator('dialog').get_by_role('button',name='Close',exact=True).click()
    elif path=='/engineering/preventive-maintenance':
     for name in ['Weekly Sheet','Quarterly PM','Maintenance History','Inspection Forms']:
      await frame.get_by_role('navigation',name='PM sections').get_by_role('button',name=name,exact=True).click();await record(name)
     await frame.get_by_role('button',name='Open form',exact=True).first.click();await record('inspection form')
     await frame.locator('.pm-inspection').get_by_role('button',name='Close',exact=True).click()
    elif path=='/engineering/parts':
     for name in ['Add Vendor','Add Vendor Contact','Add Inventory','Add Order Idea','Record Proposal']:
      await frame.get_by_role('button',name=name,exact=True).click();await record(name)
      await frame.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
    elif path=='/engineering/purchasing':
     for name in ['Shipments','Evidence','Stock & spending','Items & receiving']:
      await frame.get_by_role('button',name=name,exact=True).click();await record(name)
     await frame.get_by_role('button',name='Add Item',exact=True).click();await record('Add Item')
     await frame.get_by_role('dialog',name='Add Item',exact=True).get_by_role('button',name='Cancel',exact=True).click()
     await frame.get_by_role('button',name='Edit Items',exact=True).click();await record('Edit Items')
     await frame.get_by_role('dialog',name='Edit Items',exact=True).get_by_role('button',name='Close',exact=True).click()
     await frame.get_by_role('button',name='Add manual order',exact=True).click();await record('manual order form')
    elif path=='/management/equipment':
     await frame.get_by_role('button',name='Add Asset',exact=True).click();await record('Add Asset')
     await frame.get_by_role('dialog',name='Add Asset',exact=True).get_by_role('button',name='Close',exact=True).click()
     combo=frame.get_by_role('combobox').first
     await combo.click();await frame.get_by_role('option').filter(has_text='Sample Room Unit').click();await record('selected asset')
     await frame.get_by_role('button',name='Edit Equipment',exact=True).click();await record('asset editor')
     await frame.get_by_role('button',name='Choose PDF',exact=True).click();await record('asset documentation')
     await frame.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
    elif path=='/staff-notes':
     await frame.get_by_role('button',name='Media',exact=True).click();await record('media menu')
     await frame.get_by_role('group',name='GIF or Media').get_by_role('button',name='GIF',exact=True).click()
     await frame.get_by_role('dialog',name='GIPHY picker').wait_for();await record('GIF picker')
     await frame.get_by_role('dialog',name='GIPHY picker').press('Escape')
    elif path=='/engineering/hours-tracker':
     for name in ['Company PTO','Illinois Sick']:
      await frame.get_by_role('button',name=name,exact=False).click();await record(name+' configuration')
      await frame.get_by_role('dialog',name='Dated leave configuration').get_by_role('button',name='Cancel',exact=True).click()
     await frame.get_by_title('Clear this day to unentered').first.click();await record('confirm hours change')
     await frame.get_by_role('dialog',name='Confirm Hours Tracker change').get_by_role('button',name='Keep editing',exact=True).click()
     await frame.locator('button[aria-label$="schedule: Unentered"]').first.click()
     await shell.get_by_role('button',name='Close '+title,exact=True).click();await record('unsaved hours')
     await frame.get_by_role('dialog',name='Unsaved Hours Tracker changes').get_by_role('button',name='Discard',exact=True).click()
     await shell.wait_for(state='detached',timeout=10000)
    elif path=='/engineering/employment':
     await frame.get_by_role('button',name='Sample Applicant',exact=False).click();await record('questionnaire detail')
    elif path.startswith('/work-orders/'):
     link=frame.get_by_role('link',name='Original photo.gif',exact=True)
     await link.click();await record('attachment viewer')
     await frame.get_by_role('button',name='Close attachment',exact=True).click()
    elif path=='/work-orders':
     for name in ['Room / Location','Category','Priority']:
      control=frame.get_by_role('combobox',name=name,exact=True);await control.click();await record(name+' dropdown');await control.press('Escape')
     if width>=768:
      await ctx.grant_permissions(['camera'],origin=BASE)
      await frame.get_by_role('button',name='Open camera',exact=True).click();await frame.locator('.preview-camera').wait_for();await record('camera dialog')
      await frame.get_by_role('button',name='Close camera',exact=True).click()
    if await shell.count():await shell.get_by_role('button',name='Close '+title,exact=True).click()
    await shell.wait_for(state='detached',timeout=10000)
   if os.environ.get('CMPRI_MODAL_PATHS','')=='':
    for key,trigger in [('work-order-list',page.get_by_role('button',name='Work Order List',exact=True)),('work-order-approvals',page.locator('.cmpri-approved-bell'))]:
     await trigger.click();window=page.locator('[data-cmpri-desktop-window="'+key+'"]');await window.wait_for()
     scan=await page.evaluate(SCAN,'[data-cmpri-desktop-window="'+key+'"], [data-cmpri-desktop-window="'+key+'"] *');findings=scan['findings']
     assert scan['stats']['elements']>0,'Desktop window scan counted no elements'
     results.append({'width':width,'path':key,'state':'native desktop window','findings':findings,'scan':scan,'errors':errors[:]})
     print(json.dumps({'width':width,'path':key,'legacyNavy':len(findings)}),flush=True)
     await window.locator('.cmpri-desktop-close').click()
   await ctx.close()
   if os.environ.get('CMPRI_MODAL_PATHS','')=='':await audit_guides(browser,width,results)
  await browser.close()
 OUT.joinpath('modal-background-audit.json').write_text(json.dumps(results,indent=2))
 if os.environ.get('CMPRI_MODAL_AUDIT_ASSERT','1')=='1':
  assert not [r for r in results if r['findings'] or r['errors']],str(OUT/'modal-background-audit.json')

if __name__=='__main__':asyncio.run(main())
