"""Real production UI with isolated stock data; no production writes or AI calls."""
from cmpri_fixture import *
import re
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390,320]:
   ctx=await browser.new_context(viewport={'width':width,'height':1000},reduced_motion='reduce')
   await install(ctx,'chief_engineer')
   location='00000000-0000-4000-8000-000000000021';other='00000000-0000-4000-8000-000000000022';item_id='00000000-0000-4000-8000-000000000023'
   item={'id':item_id,'item_name':'Bromine','item_type':'Chemical','inventory_revision':1,'storage_location_id':location,'storage_location':'Pool Pump Room','unit_of_measure':'LB','quantity_on_hand':25,'quantity_reserved':2,'manufacturer':'','vendor_sku':'BR-25','preferred_vendor_id':None,'reorder_level':10,'active':True,'unit_locked':True}
   data={'inventory':[item]+[{'id':f'00000000-0000-4000-8000-{100+n:012d}','item_name':f'Other supply {n:02}','item_type':'Supply','inventory_revision':1,'storage_location_id':other,'storage_location':'Pool HVAC Room','unit_of_measure':'EA','quantity_on_hand':n,'quantity_reserved':0,'active':True} for n in range(25)],'ideas':[],'po_options':[],'vendors':[],'contacts':[],'proposals':[],'compatibility':[],'assets':[],'locations':[{'id':location,'name':'Pool Pump Room','active':True},{'id':other,'name':'Pool HVAC Room','active':True}],'work_order_items':[],'as_of':'2026-11-09T16:30:00Z'}
   notes=[{'id':'00000000-0000-4000-8000-000000000090','inventory_item_id':item_id,'recorded_at':'2026-11-09T16:30:00Z','actor_name':'Scott P.','actor_role':'Chief Engineer','kind':'Opening balance','message':'Physical shelf count','quantity_before':0,'quantity_after':25,'reserved_before':0,'reserved_after':0,'unit':'LB'}]
   reads=[];writes=[];history=[];used={};lose=True
   async def catalog(route):
    nonlocal lose
    if route.request.method=='GET':reads.append(route.request.url);return await route.fulfill(json=data)
    b=route.request.post_data_json;writes.append(b)
    if b['request_id'] in used:return await route.fulfill(json=used[b['request_id']])
    if b.get('action')=='adjust':
     if b['quantity']<item['quantity_reserved']:return await route.fulfill(status=400,json={'error':'Insufficient unreserved stock'})
     if b['expected_revision']!=item['inventory_revision']:return await route.fulfill(status=409,json={'error':'Inventory changed. Refresh and review.'})
     before=item['quantity_on_hand'];item.update(quantity_on_hand=b['quantity'],inventory_revision=item['inventory_revision']+1)
     note={**notes[0],'id':b['request_id'],'kind':'Physical count correction','message':b['reason'],'quantity_before':before,'quantity_after':item['quantity_on_hand'],'reserved_before':2,'reserved_after':2};notes.insert(0,note);result={'inventory_item':dict(item),'note':note}
    elif b['kind']=='inventory':
     created={**b,'id':b['request_id'],'storage_location':'Pool Pump Room','inventory_revision':1,'quantity_reserved':0,'unit_locked':b['quantity_on_hand']>0,'active':True};data['inventory'].append(created);result={'inventory_item':created}
    else:result={'idea':{'id':b['request_id'],'item_text':b.get('item_text','Bromine'),'inventory_item_id':item_id,'status':'Idea','source':'manual','created_at':'2026-11-09T16:30:00Z'}}
    used[b['request_id']]=result
    if lose:lose=False;return await route.abort('failed')
    await route.fulfill(json=result)
   async def note_route(route):history.append(route.request.url);await route.fulfill(json={'item':item,'notes':notes,'has_more':False})
   await ctx.route('**/api/engineering/catalog*',catalog);await ctx.route('**/api/engineering/inventory/*/notes*',note_route)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering/parts')
   await expect(page.get_by_role('heading',name='Parts Catalog',exact=True)).to_be_visible(timeout=30000)
   await expect(page.get_by_role('button',name='Inventory details for Bromine',exact=True)).to_be_visible()
   await page.wait_for_timeout(400)
   initial=len(reads)
   await page.get_by_role('button',name='Next',exact=True).click();await expect(page.get_by_text('Showing 21–26 of 26',exact=True)).to_be_visible()
   await page.get_by_role('searchbox',name='Search inventory',exact=True).fill('Bromine');await expect(page.get_by_text('Showing 1–1 of 1',exact=True)).to_be_visible();assert len(reads)==initial
   await page.get_by_role('button',name='Inventory details for Bromine',exact=True).click()
   await expect(page.get_by_role('heading',name='Stock notes · Bromine',exact=True)).to_be_visible()
   await expect(page.get_by_text('Physical shelf count',exact=True)).to_be_visible();assert len(history)==1
   await page.get_by_role('button',name='Adjust stock',exact=True).click()
   dialog=page.get_by_role('dialog',name='Adjust stock',exact=True)
   await dialog.get_by_role('spinbutton',name='Physical count',exact=True).fill('24')
   await dialog.get_by_role('textbox',name='Inventory reason',exact=True).fill('Physical count correction')
   await dialog.get_by_role('button',name='Save stock note',exact=True).click()
   retry=dialog.get_by_role('button',name='Retry unconfirmed save',exact=True);await expect(retry).to_be_visible();await expect(dialog.get_by_role('spinbutton',name='Physical count',exact=True)).to_be_disabled()
   if width==390:
    await page.reload();retry=page.get_by_role('button',name='Retry unconfirmed save',exact=True);await expect(retry).to_be_visible()
   await retry.click();await expect(dialog).to_have_count(0)
   assert writes[0]['request_id']==writes[1]['request_id'] and item['quantity_on_hand']==24 and item['quantity_reserved']==2
   await expect(page.get_by_text('On hand 25 → 24 LB · Reserved 2 → 2 LB',exact=True)).to_be_visible()
   await page.get_by_role('button',name='Adjust stock',exact=True).click();dialog=page.get_by_role('dialog',name='Adjust stock',exact=True)
   await dialog.get_by_role('spinbutton',name='Physical count',exact=True).fill('1');await dialog.get_by_role('textbox',name='Inventory reason',exact=True).fill('Rejected count')
   await dialog.get_by_role('button',name='Save stock note',exact=True).click();await expect(dialog.get_by_role('alert')).to_contain_text('Insufficient unreserved stock');await expect(dialog.get_by_role('spinbutton',name='Physical count',exact=True)).to_have_value('1')
   page.once('dialog',lambda d:d.accept());await dialog.get_by_role('button',name='Cancel',exact=True).click()
   await page.get_by_role('button',name='Add Inventory',exact=True).click();dialog=page.get_by_role('dialog',name='Add Inventory',exact=True)
   await dialog.get_by_role('textbox',name='Inventory item name',exact=True).fill('New pool chemical');await dialog.get_by_role('combobox',name='Inventory type',exact=True).select_option('Chemical');await dialog.get_by_role('combobox',name='Stock unit',exact=True).select_option('LB')
   await dialog.get_by_role('spinbutton',name='Opening quantity',exact=True).fill('8');await dialog.get_by_role('textbox',name='Inventory reason',exact=True).fill('Counted delivery')
   await dialog.get_by_role('combobox',name='Choose managed Storage Location',exact=True).click();await page.get_by_role('option',name='Pool Pump Room',exact=True).click()
   await dialog.get_by_role('button',name='Add Inventory Item',exact=True).click();await expect(dialog).to_have_count(0)
   assert writes[-1]['storage_location_id']==location and writes[-1]['unit_of_measure']=='LB' and writes[-1]['item_type']=='Chemical'
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
   assert not errors,errors
   await page.screenshot(path=str(OUT/f'inventory-tracking-{width}.png'),full_page=True)
   await ctx.close();print(json.dumps({'width':width,'local_search_and_pagination_no_reads':True,'lazy_history':True,'safe_retry_once':True,'errors_inside_dialog':True,'managed_location_and_units':True,'no_overflow':True}))
  await browser.close()
asyncio.run(main())
