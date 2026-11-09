"""Production UI, isolated pool/chemical data: no production reads or writes."""
from cmpri_fixture import *
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390,320]:
   ctx=await browser.new_context(viewport={'width':width,'height':1000})
   await install(ctx,'chief_engineer')
   facility={'id':'00000000-0000-4000-8000-000000000020','pool_name':'Fixture Pool','facility_name':'Fixture Pool','sanitizer':'Bromine'}
   row={'id':'00000000-0000-4000-8000-000000000021','revision':1,'log_date':'2026-11-09','pool_facility_id':facility['id'],'ph_am':7.4,'sanitizer_band_am':'3-6','temperature_f':84,'flow_rate_gpm':55,'main_drain_visible':True,'filter_backwashed':False,'closure_condition':False,'closure_reason':'','remarks':'Routine check','completed_by_initials':'TEST','updated_at':'2026-11-09T15:00:00Z','manual_closure':False}
   item={'id':'00000000-0000-4000-8000-000000000022','item_name':'Bromine','quantity_on_hand':10,'quantity_reserved':2,'unit_of_measure':'LB'}
   writes=[];keys=set();lose=True;errors=[]
   async def pool_route(route):
    nonlocal row,lose
    if route.request.method=='POST':
     body=route.request.post_data_json;writes.append(body)
     for use in body.get('chemical_uses',[]):
      if use['id'] not in keys:keys.add(use['id']);item['quantity_on_hand']-=1
     row={**row,**body,'revision':row['revision']+1}
     if lose:lose=False;return await route.abort('failed')
     return await route.fulfill(json={'log':row,'closure_required':False})
    await route.fulfill(json={'facility':facility,'facilities':[facility],'log':row,'can_edit':True,'can_edit_saved':True})
   await ctx.route('**/api/pool-log?*',pool_route)
   await ctx.route('**/api/pool-log',pool_route)
   await ctx.route('**/api/pool-log/supplies',lambda r:r.fulfill(json={'items':[item]}))
   page=await ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering/pool-log')
   section=page.locator('details.pool-chemical-usage');summary=section.locator('summary')
   await expect(summary).to_be_visible(timeout=30000)
   await expect(section).not_to_have_attribute('open','')
   remarks=page.locator('label').filter(has_text='Remarks / actions taken').locator('textarea')
   await expect(remarks).to_be_visible()
   assert (await remarks.bounding_box())['y']+(await remarks.bounding_box())['height']<=(await summary.bounding_box())['y']
   await summary.focus();await page.keyboard.press('Enter')
   await expect(section).to_have_attribute('open','')
   await page.get_by_label('Pool chemical supply',exact=True).select_option(item['id'])
   await page.get_by_label('Pool chemical quantity used',exact=True).fill('16')
   await page.get_by_label('Pool chemical usage unit',exact=True).select_option('OZ')
   await page.get_by_role('button',name='Add chemical use',exact=True).click()
   await expect(remarks).to_have_value('Routine check\nChemical used: 16 OZ Bromine.')
   assert item['quantity_on_hand']==10 and not writes,'Staging must not consume inventory'
   await page.get_by_role('button',name="Add to today's pool log",exact=True).click()
   retry=page.get_by_role('button',name='Retry Save Pool Log',exact=True)
   await expect(retry).to_be_visible()
   await expect(remarks).to_be_disabled();await expect(page.get_by_label('Pool chemical supply',exact=True)).to_be_disabled()
   await retry.click()
   await expect(page.get_by_text('Pool log saved to the database.',exact=False)).to_be_visible()
   assert len(writes)==2 and writes[0]['chemical_uses']==writes[1]['chemical_uses'] and len(keys)==1 and item['quantity_on_hand']==9
   await expect(page.get_by_label('Pool chemical supply',exact=True).locator('option').last).to_contain_text('7 LB available')
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
   assert not errors,errors
   await page.screenshot(path=str(OUT/f'pool-chemicals-{width}.png'),full_page=True)
   await ctx.close();print(json.dumps({'width':width,'expanding_section_below_remarks':True,'staged_without_deduction':True,'same_key_retry':True,'inventory_refreshed':True,'no_overflow':True}))
  await browser.close()
asyncio.run(main())
