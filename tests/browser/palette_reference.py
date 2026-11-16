"""Compare actual modal colors with the shared palette JSON, using local fixtures."""
from cmpri_fixture import *
import re

ROOT=Path(__file__).resolve().parents[2]
PALETTE=json.loads((ROOT/'src/lib/ui/site-palette.json').read_text())
REFERENCE=(ROOT/'.bridge/ChatGPT Errors/CMPRI-selected-tabbed-pills (2).html').read_text()
INVENTORY=json.loads(re.search(r'const inventories=(\{[^\n]+\});',REFERENCE)[1])
NAMES=list(dict.fromkeys(name for groups in INVENTORY.values() for group in groups for name in group[1:]))


def rgb(value):
 if value.startswith('#'):return [int(value[n:n+2],16) for n in [1,3,5]]
 return [int(n) for n in value.split(',')]


def expected_palette(action):
 special={'Create Work Order':'create','Work Order Detail':'detail','Hours Tracker':'hours'}.get(action)
 if special:
  scheme=PALETTE['special'][special];accent=rgb(scheme['rgb']);base=rgb(scheme['base'])
  text=[round(a*.12+255*.88) for a in accent]
  title=[round(a*.16+b*.84) for a,b in zip(accent,base)]
 else:
  accent=rgb(PALETTE['maintenance'] if 'Maintenance' in action else PALETTE['accents'][NAMES.index(action)%len(PALETTE['accents'])]['rgb'])
  base=rgb(PALETTE['modalBase']);text=[round(a*.18+255*.82) for a in accent]
  title=[round(a*.14+b*.86) for a,b in zip(accent,base)]
 return {'accent':accent,'base':base,'background':[round(a*.055+b*.945) for a,b in zip(accent,base)],'text':text,'title':title}


async def pixels(page,color,base=None):
 return await page.evaluate('''({color,base})=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d');if(base){c.fillStyle=`rgb(${base})`;c.fillRect(0,0,1,1)}c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3)}''',{'color':color,'base':base})


def matches(actual,expected):
 return all(abs(a-b)<=1 for a,b in zip(actual,expected))


async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  ctx=await browser.new_context(viewport={'width':1440,'height':1000});await install(ctx,'manager');page=await ctx.new_page()
  for action,path in [('Create Work Order','/work-orders'),('Work Order Detail','/work-orders/'+WID),('Daily Room Ops','/engineering/room-operations'),('Staff Notes','/staff-notes'),('Pool Log','/engineering/pool-log')]:
   await page.goto(BASE+path);await page.locator('html[data-cmpri-modal-theme=true]').wait_for();await page.wait_for_timeout(400)
   actual=await page.evaluate('''()=>{const root=getComputedStyle(document.documentElement),s=getComputedStyle(document.querySelector('main'));return {background:s.backgroundColor,text:s.color,accent:root.getPropertyValue('--cmpri-action-rgb').trim()}}''')
   expected=expected_palette(action)
   actual_bg=await pixels(page,actual['background']);actual_text=await pixels(page,actual['text'])
   assert actual['accent']==','.join(map(str,expected['accent'])),(action,path,actual,expected)
   assert matches(actual_bg,expected['background']),(action,path,actual,expected)
   assert matches(actual_text,expected['text']),(action,path,actual,expected)
   results.append({'action':action,'path':path,'background':actual_bg,'expected':expected['background'],'passed':True})
  # Keep the actual hosted title-bar dimensions and launcher/modal color contract.
  await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for()
  await page.locator('.cmpri-header-v23').get_by_role('button',name='Work Order List',exact=True).click()
  title=page.locator('.cmpri-desktop-titlebar').last;await title.wait_for()
  actual=await title.evaluate('e=>({height:getComputedStyle(e).height,background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,base:getComputedStyle(e.parentElement).backgroundColor})')
  expected=expected_palette('Work Order List')
  assert actual['height']=='28px',actual
  assert matches(await pixels(page,actual['base']),expected['base']),(actual,expected)
  assert matches(await pixels(page,actual['background'],expected['base']),expected['title']),(actual,expected)
  assert matches(await pixels(page,actual['color']),expected['text']),(actual,expected)
  print(json.dumps({'palette':results,'titlebar':actual},indent=2))
  OUT.joinpath('palette.json').write_text(json.dumps(results,indent=2));await browser.close()


asyncio.run(main())
