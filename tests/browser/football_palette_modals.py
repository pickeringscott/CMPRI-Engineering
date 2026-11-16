"""Audit every hosted modal's rendered team colors using synthetic loopback data.

Run a local app, then CMPRI_UI_BASE=http://localhost:3120 python this file.
No production/provider requests or real writes are made. Photos, SVG marks,
canvas artwork and source documents are not interpreted as interface colors.
"""
import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse
os.environ.setdefault('CMPRI_UI_BASE','http://localhost:3120')
os.environ.setdefault('CMPRI_UI_OUTPUT','/workspace/work/football-palette-browser')
from cmpri_fixture import BASE, install, UID, WID, HOTEL, CAPS
from playwright.async_api import async_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(os.environ['CMPRI_UI_OUTPUT']);OUT.mkdir(parents=True,exist_ok=True)
source=(ROOT/'src/components/GlobalModalHost.tsx').read_text()
registry=re.search(r'const modalRoutes = new Set\(\[([\s\S]*?)\]\)',source)[1]
ROUTES=re.findall(r'"(/[^\"]+)"',registry)
ROUTES.append('/engineering/employment')
ROUTES.insert(0,'work-order-list');ROUTES.insert(ROUTES.index('/work-orders')+1,'/work-orders/'+WID)
TITLES={'work-order-list':'Work Order List','/work-orders':'Create Work Order','/work-orders/'+WID:'Work Order Detail','/staff-notes':'Staff Notes','/notes':'Notes','/management/equipment':'Assets','/management/rooms':'Manage Locations','/management/users':'Manage Users','/profile':'Manage Profile','/profile/ai-connection':'Connect ChatGPT','/engineering/room-ranker':'Room Ranker Old','/engineering/room-ranking':'Room Ranker','/engineering/preventive-maintenance':'Preventive Maintenance','/engineering/winter-preparedness':'Winter Preparedness','/engineering/purchasing':'PO','/engineering/gss':'GSS Reports','/engineering/pool-log':'Pool Log','/pool':'Pool','/engineering/hours-tracker':'Hours Tracker','/engineering/room-operations':'Daily Room Ops','/engineering/enseo-assignments':'Enseo Assignments','/engineering/parts':'Inventory','/engineering/import-work-orders':'Import Work Orders','/feedback':'Feedback','/engineering/employment':'Candidate questionnaires'}
AUDIT=r'''rootSelector=>{
 const root=rootSelector?document.querySelector(rootSelector):document.body;
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d',{willReadFrequently:true}),cache=new Map();
 const rgba=value=>{if(cache.has(value))return cache.get(value);c.clearRect(0,0,1,1);c.fillStyle=value;c.fillRect(0,0,1,1);const p=[...c.getImageData(0,0,1,1).data];cache.set(value,p);return p};
 const badColor=value=>{const [r,g,b,a]=rgba(value);if(a<9)return false;const chroma=Math.max(r,g,b)-Math.min(r,g,b);if(chroma<=9)return false;return r+3<g||g+3<b||(r-b>15&&(g-b)/(r-b)<.16)};
 const visible=e=>{if(e.matches('option,optgroup'))return e.closest('select')&&visible(e.closest('select'));const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0};
 const pick=e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\s+/).slice(0,3).join('.'):'');
 const colors={},bad=[],seen=new Set();let examined=0,controls=0,selected=0;
 for(const e of [root,...root.querySelectorAll('*')]){
  if(!(e instanceof HTMLElement)||!visible(e)||e.closest('iframe,canvas,svg,[data-source-document],.pdf-html-preview,.manual-document,.manual-preview-source'))continue;
  if(e.matches('input,select,textarea,button,[role=combobox],[role=option],[role=menuitem]'))controls++;
  if(e.matches('[aria-selected=true],[aria-pressed=true],:checked'))selected++;
  examined++;
  const s=getComputedStyle(e), props=['color','backgroundColor','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor'];
  if(e.matches(':focus-visible'))props.push('outlineColor');
  for(const property of props){
   if(property==='color'&&!e.textContent.trim()&&!e.matches('input,select,textarea'))continue;
   if(property.startsWith('border')&&(s.borderTopWidth==='0px'&&s.borderRightWidth==='0px'&&s.borderBottomWidth==='0px'&&s.borderLeftWidth==='0px'))continue;
   const value=s[property];if(!value)continue;colors[value]=(colors[value]||0)+1;
   if(badColor(value)){const key=pick(e)+'|'+property+'|'+value;if(!seen.has(key)){seen.add(key);bad.push({selector:pick(e),property,color:value,rgba:rgba(value),text:e.textContent.trim().slice(0,55)})}}
  }
  for(const property of ['backgroundImage','boxShadow','textShadow'])for(const value of (s[property].match(/(?:rgba?|color|oklch|oklab|hsl)\([^)]*\)/g)||[])){if(badColor(value)){const key=pick(e)+'|'+property+'|'+value;if(!seen.has(key)){seen.add(key);bad.push({selector:pick(e),property,color:value,rgba:rgba(value),text:e.textContent.trim().slice(0,55)})}}}
 }
 return{examined,controls,selected,uniqueColors:Object.keys(colors).length,bad:bad.slice(0,100),badCount:bad.length,
  theme:document.documentElement.dataset.cmpriSiteTheme,modalBase:getComputedStyle(root).getPropertyValue('--cmpri-modal-base').trim(),action:getComputedStyle(root).getPropertyValue('--cmpri-action-rgb').trim()};
}'''

async def fixtures(context,role='chief_engineer'):
 await install(context,role)
 async def extras(route):
  path=urlparse(route.request.url).path
  # Empty synthetic collections follow each page's expected response shape.
  payload=None
  if path=='/api/profile':payload={'profile':{'id':UID,'email':'fixture@example.invalid','full_name':'Alex Morgan','role':role},'preferences':{'appearance':'dark','language':'en','notification_mode':'in_app','notifications':{'new_work_orders':True,'status_changes':True,'mentions':True}},'profile_settings_available':True,'can_manage_users':True,'chatgpt_connection':{'connected':False,'status':'disconnected','access':'disconnected','provider':'fixture','endpoint':'','message':'Not connected'}}
  elif path=='/api/profile/ai-connection':payload={'connection':{'connected':False,'status':'disconnected','access':'disconnected','endpoint':'https://fixture.invalid','message':'Fixture disconnected state','oauth_connected':False,'oauth_access':'disconnected','personal_link_active':False}}
  elif path=='/api/profile/phone-notifications':payload={'public_key':'','subscribed_on_this_device':False,'configured':False,'settings':{'timezone':'UTC','schedule':{day:{'enabled':False,'start':'09:00','end':'17:00'} for day in ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']}}}
  elif path.startswith('/api/work-orders/') and path.endswith('/parts'):payload={'items':[],'parts':[],'poLines':[]}
  elif path.startswith('/api/work-orders/') and path.endswith('/activity'):payload={'events':[],'activity':[],'purchases':[],'enseo':[],'warranties':[],'followups':[]}
  elif path=='/api/winter-preparedness':payload={'items':[],'preview_read_only':False}
  elif path=='/api/employment':payload={'applications':[]}
  elif path=='/api/engineering/purchase-orders':payload={'cmpri_po_orders':[],'cmpri_po_lines':[],'cmpri_inventory_items':[],'cmpri_po_receipts':[],'cmpri_po_shipments':[],'cmpri_po_sources':[]}
  elif path=='/api/preventive-maintenance':payload={'entries':[],'workbook':{'daily':{},'weekly':{},'monthly':{},'rooms':[],'fetchedAt':'2026-11-16T12:00:00Z'},'locations':[],'review_queue':[],'can_edit':True,'can_review':True,'access_roles':['chief_engineer'],'spreadsheet_sync_enabled':False}
  elif path=='/api/pool-log':
   facility={'id':'00000000-0000-4000-8000-000000000023','pool_name':'Pool','facility_name':'Pool','city':'Fixture City','sanitizer':'Bromine','volume_gallons':18000}
   payload={'facility':facility,'facilities':[facility],'log':None,'can_edit':True,'can_edit_saved':True,'daily_entries':[]}
  elif path=='/api/hours-tracker':payload={'saved':None}
  elif path=='/api/ticket-room-ranker':payload={'rooms':[{'id':'room-1','number':'101','floor':'1','rank':'B','issues':[]}]}
  elif path=='/api/rooms':payload={'locations':[{'id':'loc-1','name':'204','room_number':'204','location_type':'Guest Room','area':'Rooms','active':True}],'work_orders':[],'pm_plans':[],'pm_completions':[],'can_edit':True}
  elif path in ['/api/engineering/parts','/api/engineering/catalog']:payload={'vendors':[],'contacts':[],'proposals':[],'inventory':[],'compatibility':[],'ideas':[],'work_order_items':[],'assets':[],'locations':[]}
  elif path=='/api/engineering/enseo/assignments' or path=='/api/enseo/assignments':payload={'configured':True,'can_manage':True,'assignments':[],'assets':[],'locations':[],'history':[]}
  elif path=='/api/users':payload={'users':[]}
  elif path=='/api/engineering/purchasing':payload={'purchase_orders':[],'orders':[],'vendors':[],'items':[],'notifications':[]}
  elif path=='/api/engineering/gss':payload={'reports':[],'summary':[],'months':[],'rows':[]}
  elif path=='/api/room-operations':payload={'rows':[],'summary':{},'date':'2026-11-16'}
  elif path=='/api/pool-log/supplies':payload={'items':[],'uses':[]}
  if payload is not None:return await route.fulfill(json=payload)
  return await route.fallback()
 await context.route('**/api/**',extras)

async def verify_source_badges(frame):
 # The metadata helper keeps physical/source meanings. Its UI labels must still
 # resolve to the active team palette even when callers supply legacy inline RGB.
 semantics=(ROOT/'src/lib/work-orders/source-semantics.ts').read_text()
 badges=[{'kind':kind,'label':label,'color':color} for kind,label,color in re.findall(r"\w+: \{ kind: '([^']+)', label: '([^']+)', color: '(#[0-9a-f]+)' \}",semantics)]
 assert len(badges)==4,badges
 results=await frame.evaluate(r'''badges=>{
  const box=document.createElement('div');box.id='source-badge-palette-probes';
  box.setAttribute('role','group');box.setAttribute('aria-label','Source label palette probes');
  document.querySelector('main').append(box);
  const expectedTokens={urgent:'priority',caution:'gold',success:'completed',information:'link'};
  const context=document.createElement('canvas').getContext('2d');
  const pixels=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data]};
  return badges.map(badge=>{
   const label=document.createElement('span');label.dataset.sourceSemantics=badge.kind;label.textContent=badge.label;
   label.style.cssText='display:inline-block;padding:4px;border:1px solid '+badge.color+';color:'+badge.color;
   box.append(label);const actual=getComputedStyle(label),expected=getComputedStyle(document.documentElement).getPropertyValue('--cmpri-palette-'+expectedTokens[badge.kind]).trim();
   return {kind:label.dataset.sourceSemantics,label:label.textContent,inlineColor:label.style.color,
    color:pixels(actual.color),border:pixels(actual.borderTopColor),expected:pixels(expected),source:pixels(badge.color)};
  });
 }''',badges)
 for original,result in zip(badges,results):
  assert result['kind']==original['kind'] and result['label']==original['label'],result
  assert result['color']==result['expected'] and result['border']==result['expected'],result
 return results

async def verify_case(browser,path):
 title=TITLES[path];result={'path':path,'title':title};errors=[]
 context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
 await fixtures(context,'system_admin' if path=='/management/users' else 'chief_engineer')
 page=await context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
 try:
  await page.goto(BASE+'/engineering',wait_until='domcontentloaded');await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
  root_selector='.cmpri-modal-shell'
  if path=='work-order-list':
   await page.get_by_role('button',name='Work Order List',exact=True).click();root_selector='.cmpri-desktop-window'
  else:await page.evaluate("d=>window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:d.path,title:d.title}}))",{'path':path,'title':title})
  shell=page.locator(root_selector).last;await expect(shell).to_be_visible(timeout=15000)
  result['shell']=await page.evaluate(AUDIT,root_selector)
  iframe=shell.locator('iframe')
  if await iframe.count():
   frame=await (await iframe.element_handle()).content_frame();await frame.wait_for_load_state('domcontentloaded')
   await frame.wait_for_selector('html[data-cmpri-framed=true]',timeout=30000)
   await frame.wait_for_selector('main',timeout=30000);await frame.wait_for_timeout(350)
   result['body']=await frame.evaluate(AUDIT,None)
   inputs=frame.locator('input:not([type=hidden]),textarea,select,[role=combobox]')
   for input in (await inputs.all())[:4]:
    if await input.is_visible() and await input.is_enabled():
     await input.focus();result.setdefault('focus',[]).append(await frame.evaluate(AUDIT,None))
     if await input.get_attribute('role')=='combobox':
      await input.click();await frame.wait_for_timeout(60);result.setdefault('menus',[]).append(await frame.evaluate(AUDIT,None));await input.press('Escape')
   # The explicit football palette also wins over a previously saved light preference.
   if path=='/work-orders':
    await frame.evaluate("document.documentElement.dataset.theme='light'");result['sourceBadges']=await verify_source_badges(frame);result['lightPreference']=await frame.evaluate(AUDIT,None)
  else:
   await page.locator('[data-preview-status]').first.wait_for(timeout=15000)
   result['body']=await page.evaluate(AUDIT,root_selector)
  await page.screenshot(path=str(OUT/(path.strip('/').replace('/','-')+'.png')))
  result['errors']=errors
  audits=[result['shell'],result['body'],*result.get('focus',[]),*result.get('menus',[])]
  if 'lightPreference' in result:audits.append(result['lightPreference'])
  result['passed']=not errors and all(a['badCount']==0 for a in audits)
 except Exception as error:
  result['failure']=str(error);result['errors']=errors;result['passed']=False
 finally:await context.close()
 return result

async def main():
 results=[]
 async with async_playwright() as driver:
  browser=await driver.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for path in ROUTES:
   result=await verify_case(browser,path);results.append(result)
   print(json.dumps({'path':path,'passed':result['passed'],'failure':result.get('failure'),'bodyBad':result.get('body',{}).get('badCount'),'errors':result.get('errors')}),flush=True)
   OUT.joinpath('results.json').write_text(json.dumps(results,indent=2))
  await browser.close()
 print(json.dumps({'checks':len(results),'passed':all(r['passed'] for r in results),'productionDataAccessed':False}))
 assert all(r['passed'] for r in results),f'{sum(not r["passed"] for r in results)} modal palette checks failed; see {OUT}/results.json'

if __name__=='__main__':asyncio.run(main())
