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
   info=await page.evaluate('''action=>{const b=[...document.querySelectorAll('#previews button.action')].find(b=>b.dataset.control===action);if(!b)throw Error('Reference action not found: '+action);openColorDemo(b);const d=document.querySelector('#color-demo'),body=d.querySelector('.demo-body'),t=document.querySelector('#demo-titlebar'),rgb=d.style.getPropertyValue('--action-rgb').split(',').map(Number),c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(d).backgroundColor;c.fillRect(0,0,1,1);c.fillStyle=`rgba(${rgb},.055)`;c.fillRect(0,0,1,1);const result={background:[...c.getImageData(0,0,1,1).data].slice(0,3),base:getComputedStyle(d).backgroundColor,text:getComputedStyle(body).color,title:getComputedStyle(t).backgroundColor,titleText:getComputedStyle(t).color,height:getComputedStyle(t).height,input:getComputedStyle(d.querySelector('input')).backgroundColor};d.close();return result}''',action);refs[action]=info
  for action,path in [('Work Order List','/work-orders'),('Work Order List','/work-orders/'+WID),('Daily Room Ops','/engineering/room-operations'),('Staff Notes','/staff-notes'),('Pool Log','/engineering/pool-log')]:
   await page.goto(BASE+path);await page.locator('html[data-cmpri-modal-theme=true]').wait_for();await page.wait_for_timeout(400)
   actual=await page.evaluate('''()=>{const e=document.querySelector('main'),s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.fillStyle=s.backgroundColor;c.fillRect(0,0,1,1);return {background:[...c.getImageData(0,0,1,1).data].slice(0,3),text:s.color,root:document.documentElement.style.getPropertyValue('--cmpri-modal-text')}}''')
   expected=refs[action];assert all(abs(a-b)<=1 for a,b in zip(actual['background'],expected['background'])),(action,path,actual,expected)
   assert actual['text'].replace(' ','')==expected['text'].replace(' ',''),(action,actual,expected)
   results.append({'action':action,'path':path,'background':actual['background'],'approved':expected['background'],'passed':True})
  # A real hosted title bar matches the approved 28 CSS pixels and tinted backing.
  await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for();await page.locator('.cmpri-header-v23').get_by_role('button',name='Work Order List',exact=True).click();title=page.locator('.cmpri-desktop-titlebar').last;await title.wait_for();actual=await title.evaluate('e=>({height:getComputedStyle(e).height,background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,base:getComputedStyle(e.parentElement).backgroundColor})');expected=refs['Work Order List'];assert actual['height']=='28px' and actual['background']==expected['title'] and actual['color']==expected['titleText'] and actual['base']==expected['base'],(actual,expected)
  print(json.dumps({'palette':results,'titlebar':actual},indent=2));OUT.joinpath('palette.json').write_text(json.dumps(results,indent=2));await browser.close()
 server.shutdown()
asyncio.run(main())
