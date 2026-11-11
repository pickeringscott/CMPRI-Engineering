"""Exercise compact source-chart branches on phone and desktop with fictional data."""
import asyncio, json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from cmpri_fixture import install, UID, WID, BASE, async_playwright, expect

PDF=BASE+'/guides/guest-room.pdf'
ASSET='00000000-0000-4000-8000-000000000099'
order={'id':WID,'display_id':'4218','revision':1,'room':'204','location_id':'loc-1','asset_id':ASSET,'asset_name':'Fixture valve','issue':'No hot water','reporter_notes':'','status':'Open','priority':'High','category':'Plumbing','technician_name':'','created_by':UID,'creator_name':'Reporter','notes':'','created_at':'2026-11-08T12:00:00Z'}
asset={'id':ASSET,'location_id':'loc-1','active':True,'name':'Fixture valve','manufacturer':'Fixture','model_family':'Valve','model_number':'V1','asset_type':'Valve','documentation_key':'fixture','documentation_revision_id':None,'documentation_verified_at':None}
labels=['MODELS A AND B — NO HOT WATER — Supply on? — Yes: Check the valve.','MODELS A AND B — NO HOT WATER — Supply on? — No: Open the supply.']
knowledge={'manufacturer':'Fixture','model_family':'Valve','model_number':'V1','source':{'verified':True,'source_kind':'asset-upload','storage_path':'fixture/manual.pdf','registered_file_id':'00000000-0000-4000-8000-000000000011','sha256':'a'*64,'source_file_name':'Fixture manual.pdf','file_url':PDF},'symptom_rules':[{'match':['no hot water'],'steps':labels,'source_pages':[4]}]}
code="""import fs from 'node:fs';import{createHash}from'node:crypto';import{normalizeManualKnowledge}from'./src/lib/manual-knowledge.ts';import{deriveTroubleshootingChecklistContext}from'./src/lib/work-orders/troubleshooting-checklist.ts';const {order,asset,knowledge}=JSON.parse(fs.readFileSync(0,'utf8'));const context=deriveTroubleshootingChecklistContext({...order,asset},normalizeManualKnowledge(knowledge));console.log(JSON.stringify({...context,contextKey:createHash('sha256').update(context.contextIdentity).digest('hex')}));"""
context=json.loads(subprocess.check_output(['node','--import','./tests/helpers/resolve-ts.mjs','--experimental-strip-types','--input-type=module','-e',code],input=json.dumps({'order':order,'asset':asset,'knowledge':knowledge}),text=True))
assert len(context['steps'])==2

async def main():
 out=Path(os.environ.get('CMPRI_GUIDE_OUTPUT','/tmp/cmpri-guide-preview'));out.mkdir(parents=True,exist_ok=True)
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [384,1440]:
   ctx=await browser.new_context(viewport={'width':width,'height':900},service_workers='block');await install(ctx,'technician')
   async def route(r):
    u=urlparse(r.request.url)
    async def reply(data):await r.fulfill(content_type='application/json',headers={'Cache-Control':'no-store'},body=json.dumps(data))
    if u.path=='/api/work-orders/'+WID:return await reply({'workOrder':order})
    if u.path=='/api/work-orders/'+WID+'/troubleshooting':return await reply({**context,'revision':0,'actor':{'id':UID,'name':'Alex Morgan','role':'technician'},'canEdit':True,'canClearAll':True,'canClearOwn':True,'canSeePendingReview':False,'taskStates':{},'pendingVisits':[]})
    if u.path=='/api/maintenance-reference':return await reply({'documentation_status':'verified','manualKnowledge':knowledge,'asset_id':ASSET} if parse_qs(u.query).get('assetId') else {'assets':[asset],'technicians':[]})
    if u.path=='/api/work-orders/'+WID+'/parts':return await reply({'items':[],'parts':[],'poLines':[]})
    return await r.fallback()
   await ctx.route('**/*',route);page=await ctx.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   await page.goto(BASE+'/work-orders/'+WID);guide=page.locator('[data-ticket-accordion="troubleshooting"]');await guide.wait_for(timeout=30000);await guide.locator('summary').first.click()
   await expect(guide.get_by_role('checkbox')).to_have_count(2,timeout=30000)
   await expect(guide.locator('[data-chart-context]')).to_have_count(1)
   await expect(guide.get_by_text('Supply on? — Yes: Check the valve.',exact=True)).to_be_visible()
   await expect(guide.get_by_text('Supply on? — No: Open the supply.',exact=True)).to_be_visible()
   await expect(guide.locator('[data-chart-context] summary')).to_have_count(1)
   assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'horizontal overflow at {width}px'
   assert not errors,errors
   await guide.screenshot(path=str(out/f'chart-group-{width}.png'))
   print(json.dumps({'width':width,'checks':2,'chart_contexts':1,'page_errors':len(errors)}),flush=True)
   await ctx.close()
  await browser.close()
asyncio.run(main())
