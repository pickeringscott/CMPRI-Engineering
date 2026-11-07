from cmpri_fixture import *
import threading,functools
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
async def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(Path(__file__).resolve().parents[2])));threading.Thread(target=server.serve_forever,daemon=True).start();refbase=f'http://127.0.0.1:{server.server_port}'
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox']);ctx=await browser.new_context(viewport={'width':1440,'height':1000});await install(ctx,'manager');page=await ctx.new_page()
  await page.goto(refbase+'/.bridge/ChatGPT%20Errors/CMPRI-selected-tabbed-pills%20(2).html');await page.select_option('#role',label='Chief Engineer');await page.wait_for_timeout(300)
  refs={}
  for action in ['Work Order List','Daily Room Ops','Staff Notes','Pool Log','Room Ranker','Preventative Maintenance','Hours Tracker']:
   info=await page.evaluate('''action=>{const b=[...document.querySelectorAll('#previews button.action')].find(b=>b.dataset.control===action);if(!b)throw Error('Reference action not found: '+action);openColorDemo(b);const d=document.querySelector('#color-demo'),body=d.querySelector('.demo-body'),t=document.querySelector('#demo-titlebar'),rgb=d.style.getPropertyValue('--action-rgb').split(',').map(Number),c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(d).backgroundColor;c.fillRect(0,0,1,1);c.fillStyle=`rgba(${rgb},.055)`;c.fillRect(0,0,1,1);const result={accent:rgb,background:[...c.getImageData(0,0,1,1).data].slice(0,3),base:getComputedStyle(d).backgroundColor,text:getComputedStyle(body).color,title:getComputedStyle(t).backgroundColor,titleText:getComputedStyle(t).color,height:getComputedStyle(t).height,input:getComputedStyle(d.querySelector('input')).backgroundColor};d.close();return result}''',action);refs[action]=info
  # The later approved navy cleanup uses a neutral #181818 base for ordinary modals.
  for value in refs.values():
   value['base']='rgb(24, 24, 24)'
   value['background']=[round(channel*.055+24*.945) for channel in value['accent']]
  # Explicitly approved schemes replace the original Coral Glow work-order modals.
  for action,accent,base in [('Create Work Order',[148,180,206],[16,19,25]),('Work Order Detail',[162,171,209],[17,19,26])]:
   refs[action]={'background':[round(a*.055+b*.945) for a,b in zip(accent,base)],'text':'rgb('+', '.join(str(round(a*.12+255*.88)) for a in accent)+')'}
  for action,path in [('Create Work Order','/work-orders'),('Work Order Detail','/work-orders/'+WID),('Daily Room Ops','/engineering/room-operations'),('Staff Notes','/staff-notes'),('Pool Log','/engineering/pool-log')]:
   await page.goto(BASE+path);await page.locator('html[data-cmpri-modal-theme=true]').wait_for();await page.wait_for_timeout(400)
   actual=await page.evaluate('''()=>{const e=document.querySelector('main'),s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.fillStyle=s.backgroundColor;c.fillRect(0,0,1,1);return {background:[...c.getImageData(0,0,1,1).data].slice(0,3),text:s.color,root:document.documentElement.style.getPropertyValue('--cmpri-modal-text')}}''')
   expected=refs[action];assert all(abs(a-b)<=1 for a,b in zip(actual['background'],expected['background'])),(action,path,actual,expected)
   # color-mix() may serialize as color(srgb ...); compare rendered sRGB pixels.
   text_pixels=await page.evaluate('''colors=>colors.map(color=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3)})''',[actual['text'],expected['text']])
   assert all(abs(a-b)<=1 for a,b in zip(*text_pixels)),(action,actual,expected)
   results.append({'action':action,'path':path,'background':actual['background'],'approved':expected['background'],'passed':True})
  # A real hosted title bar matches the approved 28 CSS pixels and tinted backing.
  await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for();await page.locator('.cmpri-header-v23').get_by_role('button',name='Work Order List',exact=True).click();title=page.locator('.cmpri-desktop-titlebar').last;await title.wait_for();actual=await title.evaluate('e=>({height:getComputedStyle(e).height,background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,base:getComputedStyle(e.parentElement).backgroundColor})');expected=refs['Work Order List'];assert actual['height']=='28px' and actual['background']==expected['title'] and actual['color']==expected['titleText'] and actual['base']==expected['base'],(actual,expected)
  print(json.dumps({'palette':results,'titlebar':actual},indent=2));OUT.joinpath('palette.json').write_text(json.dumps(results,indent=2));await browser.close()
 server.shutdown()
asyncio.run(main())
