from cmpri_fixture import *
import re

async def main():
 results=[]
 # Compare the unchanged bell artwork with the supplied approval, excluding the dynamic badge.
 approved=Path('.bridge/ChatGPT Errors/CMPRI-selected-tabbed-pills (2).html').read_text()
 approved_paths=re.findall(r'<path d="([^"]+)"',approved)
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width,dpr in [(1440,1),(1440,1.25),(1440,2),(390,1),(390,2)]:
   context=await browser.new_context(viewport={'width':width,'height':850},device_scale_factor=dpr,is_mobile=width<640,has_touch=width<640)
   await install(context,'chief_engineer');page=await context.new_page();await page.goto(BASE+'/engineering');bell=page.locator('notification-bell');await bell.wait_for();await page.wait_for_function("document.fonts.check('900 300px BellRounded')")
   pool=page.locator('.cmpri-header-utilities').get_by_role('button').first;create=page.locator('.cmpri-header-create');pr=await pool.bounding_box();cr=await create.bounding_box()
   assert 0<=cr['y']-pr['y']-pr['height']<=5 and abs(cr['x']+cr['width']/2-pr['x']-pr['width']/2)<1,(pr,cr)
   for count in ['0','1','18','123','1234']:
    await bell.evaluate('(e,n)=>e.setAttribute("count",n)',count)
    measurements=await bell.evaluate('''e=>{
     const r=e.shadowRoot,face=r.querySelector('.face'),bubble=r.querySelector('.bubble'),b=e.getBoundingClientRect(),rect=n=>n?.getBoundingClientRect().toJSON();
     const c=document.createElement('canvas').getContext('2d');const s=getComputedStyle(face||e);c.font=s.fontWeight+' '+s.fontSize+' '+s.fontFamily;c.textAlign='center';const m=c.measureText(e.getAttribute('count'));const point=(x,y)=>new DOMPoint(x,y).matrixTransform(face.getScreenCTM());const top=face&&point(face.x.baseVal[0].value-m.actualBoundingBoxLeft,face.y.baseVal[0].value-m.actualBoundingBoxAscent),bottom=face&&point(face.x.baseVal[0].value+m.actualBoundingBoxRight,face.y.baseVal[0].value+m.actualBoundingBoxDescent);
     return {ink:face&&{left:top.x,top:top.y,right:bottom.x,bottom:bottom.y,height:bottom.y-top.y},host:rect(e),face:rect(face),bubble:rect(bubble),numberFilter:r.querySelector('.number')&&getComputedStyle(r.querySelector('.number')).filter,faceFilter:face&&getComputedStyle(face).filter,artwork:[...r.querySelectorAll('svg>path,svg>g[clip-path]>path')].map(p=>p.getAttribute('d')),logoRight:e.closest('button').previousElementSibling.getBoundingClientRect().right};
    }''')
    assert measurements['host']['width']==18 and measurements['host']['height']==18
    assert all(d in approved_paths for d in measurements['artwork']),measurements['artwork']
    if count=='0':assert measurements['face'] is None and measurements['bubble'] is None
    else:
     f=measurements['ink'];b=measurements['bubble'];assert f['height']>=9 and f['left']>b['left'] and f['right']<b['right'] and f['top']>b['top'] and f['bottom']<b['bottom'],measurements
     assert b['left']>measurements['logoRight'],measurements
     assert measurements['faceFilter']==measurements['numberFilter']=='none'
    if count=='18':await page.screenshot(path=str(OUT/f'header-bell-{width}-{dpr}.png'))
   results.append({'width':width,'deviceScaleFactor':dpr,'counts':['0','1','18','123','1234'],'passed':True});print(json.dumps(results[-1]),flush=True);await context.close()
  await browser.close()
 OUT.joinpath('header-pool-bell.json').write_text(json.dumps(results,indent=2))

asyncio.run(main())
