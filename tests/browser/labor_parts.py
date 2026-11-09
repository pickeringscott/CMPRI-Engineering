"""Real desktop/mobile work-order UI with isolated inventory/PO responses."""
from cmpri_fixture import *
import re

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390,320]:
   ctx=await browser.new_context(viewport={'width':width,'height':1000},reduced_motion='reduce')
   await install(ctx,'chief_engineer')
   orders[0].update(issue='Bathroom light is out',notes='CMPRI2|2026-11-09T10:00:00Z|Scott|Engineer|note|Need a replacement fitting.',parts='',hours=0,cost=0,asset_id=None)
   state={'items':[{'id':'bulb','item_name':'LED bulb','description':'Bathroom light bulb','quantity_on_hand':12,'quantity_reserved':2,'unit_of_measure':'EA'},{'id':'washer','item_name':'Faucet washer','quantity_on_hand':5,'quantity_reserved':0,'unit_of_measure':'EA'}],'parts':[],'poLines':[]}
   reads={'count':0};writes=[];used=set();lose={'response':True,'create':False,'conflict':False,'update':False}
   async def parts_route(route):
    if route.request.method=='POST':
     b=route.request.post_data_json;writes.append(b)
     part={'id':b['id'],'name':b['name'],'inventory_item_id':b['item'],'requested_status':b['status'],'status':b['status'],'quantity':b['quantity'],'po_line_id':b['po_line'],'order_idea_id':b['id'] if b['status']=='Need to Order' else None,'revision':1}
     existing=next((part for part in state['parts'] if part['id']==b['id']),None)
     if lose['update'] and existing:
      lose['update']=False;lose['conflict']=True
      existing.update(name='Different saved part edit',revision=3)
      return await route.abort('failed')
     if lose['conflict'] and existing:
      lose['conflict']=False
      return await route.fulfill(status=409,json={'error':'Part changed; refresh before saving'})
     state['parts']=[p for p in state['parts'] if p['id']!=b['id']]+[part]
     if lose['create']:
      lose['create']=False;lose['conflict']=True
      part.update(name='Part edited by another technician',revision=2)
      return await route.abort('failed')
     return await route.fulfill(json={'id':b['id']})
    reads['count']+=1
    await route.fulfill(json=state)
   async def use_route(route):
    b=route.request.post_data_json;writes.append(b)
    if b['id'] not in used:used.add(b['id']);state['items'][0]['quantity_on_hand']-=b['quantity']
    if lose['response']:lose['response']=False;return await route.abort('failed')
    await route.fulfill(json={'id':b['id']})
   await ctx.route('**/api/work-orders/'+WID+'/parts',parts_route)
   await ctx.route('**/api/engineering/supply-use',use_route)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   await page.goto(BASE+'/work-orders/'+WID)
   summary=page.locator('summary').filter(has=page.get_by_role('heading',name='Labor & Parts',exact=True))
   await expect(summary).to_be_visible(timeout=60000)
   panel=summary.locator('..')
   await expect(panel).not_to_have_attribute('open','')
   guide=page.locator('summary').filter(has=page.get_by_role('heading',name='Suggested Troubleshooting',exact=True))
   assert (await summary.locator('h2').get_attribute('class')).replace('w-fit ','')==await guide.locator('h2').get_attribute('class')
   await summary.locator('h2').click()
   await expect(panel).to_have_attribute('open','')
   supply=page.get_by_label('Supply',exact=True)
   await expect(supply).to_be_visible(timeout=15000)
   assert await supply.locator('option').count()==2
   await page.get_by_role('button',name='Show all supplies',exact=True).click()
   assert await supply.locator('option').count()==3
   await supply.select_option('bulb')
   await expect(page.get_by_label('Part name',exact=True)).to_have_value('LED bulb')
   # Live suggestions follow issue edits; explicit selected supply remains unchanged.
   await page.get_by_role('button',name='Edit reported issue',exact=True).click()
   issue_field=page.get_by_role('textbox',name='Reported Issue',exact=True)
   await issue_field.fill('Faucet is leaking')
   await expect(page.locator('optgroup[label="Suggested from current issue"] option')).to_have_text(['Faucet washer'])
   await expect(supply).to_have_value('bulb')
   await issue_field.fill('Bathroom light is out')
   await page.get_by_role('button',name='Done',exact=True).click()

   await page.get_by_role('button',name='Save part',exact=True).click()
   await expect(page.get_by_role('status').filter(has_text='Part saved.')).to_be_visible()
   status=page.get_by_label('Selected part status',exact=True)
   assert await status.locator('option').all_text_contents()==['In-House','Need to Order','On Order','Received']
   await status.focus();await status.select_option('In-House')
   await expect(panel).to_have_attribute('open','')
   await page.get_by_label('Quantity used',exact=True).fill('1')
   await page.get_by_role('button',name='Record supply use',exact=True).click()
   retry=page.get_by_role('button',name='Retry supply use',exact=True)
   await expect(retry).to_be_visible()
   # Storage-full during an uncertain retry must retain its original operation identity.
   await page.evaluate("""() => {window.__partsQuota=true; const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('cmpri:parts-draft:')&&window.__partsQuota)throw new DOMException('Quota','QuotaExceededError');return original.call(this,k,v);};}""")
   await retry.click()
   await expect(page.get_by_role('status').filter(has_text='Cannot preserve this save attempt locally.')).to_be_visible()
   await expect(retry).to_be_visible()
   await page.evaluate('window.__partsQuota=false')
   await retry.click()
   await expect(page.get_by_role('status').filter(has_text='Supply use recorded once.')).to_be_visible()
   assert len(used)==1 and state['items'][0]['quantity_on_hand']==11
   assert writes[-1]['id']==writes[-2]['id']
   assert 'note' not in writes[-1]
   await status.select_option('Need to Order')
   await page.get_by_role('button',name='Save order idea',exact=True).click()
   await expect(page.get_by_role('status').filter(has_text='Part saved.')).to_be_visible()
   assert writes[-1]['status']=='Need to Order'
   # Lost creation followed by another editor's save must never create a second identity.
   await page.get_by_label('Choose ticket part',exact=True).select_option('')
   await page.get_by_label('Supply',exact=True).select_option('bulb')
   await status.select_option('Need to Order')
   lose['create']=True
   await page.get_by_role('button',name='Save order idea',exact=True).click()
   await page.get_by_role('button',name='Retry part save',exact=True).click()
   await expect(page.get_by_label('Part name',exact=True)).to_have_value('Part edited by another technician')
   assert len(state['parts'])==2
   assert writes[-1]['id']==writes[-2]['id']
   await page.get_by_label('Part name',exact=True).fill('Unsaved part edit')
   # Registered guard blocks the real ticket exit rather than silently losing the draft.
   close=page.get_by_role('button',name=re.compile('Close work order',re.I))
   if await close.count():
    await close.first.click()
    await expect(page.get_by_text('Save or discard the part changes, and confirm any pending supply use before closing this ticket.',exact=False)).to_be_visible()
   lose['update']=True
   await page.get_by_role('button',name='Save order idea',exact=True).click()
   await page.get_by_role('button',name='Retry part save',exact=True).click()
   await expect(page.get_by_role('status').filter(has_text='Your local edits are preserved')).to_be_visible()
   await expect(page.get_by_label('Part name',exact=True)).to_have_value('Unsaved part edit')
   page.once('dialog',lambda dialog:dialog.accept())
   await page.get_by_role('button',name='Cancel part edit',exact=True).click()
   await expect(page.get_by_label('Part name',exact=True)).to_have_value('Different saved part edit')
   assert await panel.locator('textarea').count()==0
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   heading=await summary.locator('h2').bounding_box();status_box=await status.bounding_box()
   assert heading['x']+heading['width']<=status_box['x'] or heading['y']+heading['height']<=status_box['y'],(heading,status_box)
   await summary.focus();await page.keyboard.press('Enter');await expect(panel).not_to_have_attribute('open','')
   before=reads['count'];state['items'][0]['quantity_on_hand']=8
   await page.keyboard.press('Space');await expect(panel).to_have_attribute('open','')
   await expect(supply.locator('option[value="bulb"]')).to_contain_text('6 EA available')
   assert reads['count']>before
   # Drafts survive reopening this exact ticket without changing stock or creating records.
   await page.get_by_label('Part name',exact=True).fill('Locally retained part edit')
   await page.wait_for_function("Object.keys(localStorage).some(key=>key.startsWith('cmpri:parts-draft:')&&localStorage.getItem(key).includes('Locally retained part edit'))")
   count=len(state['parts']);page.once('dialog',lambda dialog:dialog.accept());await page.reload()
   await expect(page.get_by_label('Part name',exact=True)).to_have_value('Locally retained part edit')
   assert len(state['parts'])==count
   page.once('dialog',lambda dialog:dialog.accept())
   await page.get_by_role('button',name='Cancel part edit',exact=True).click()
   await expect(page.get_by_label('Part name',exact=True)).not_to_have_value('Locally retained part edit')
   await panel.screenshot(path=str(OUT/f'labor-parts-{width}.png'))
   assert not errors,errors
   print(f'PASS {width}px: matching accordion, keyboard, stock options, exact mapping, part save, same-key retry, no double deduction, Order Idea action, no extra notes, no overflow')
   await ctx.close()
  await browser.close()
asyncio.run(main())
