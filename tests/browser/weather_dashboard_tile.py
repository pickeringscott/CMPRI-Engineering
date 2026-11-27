import asyncio
import os
from cmpri_fixture import BASE, OUT, install, async_playwright, expect

async def run(browser, width, height, touch=False):
    context = await browser.new_context(viewport={'width':width,'height':height}, has_touch=touch, is_mobile=width<701, service_workers='block')
    await install(context,'chief_engineer')
    await context.route_web_socket('wss://**',lambda socket:socket.close())
    await context.add_init_script('localStorage.setItem("cmpri:ask-files-consent:v1","1");')
    reads=[]
    async def mock(route):
        reads.append(route.request.url)
        await route.fulfill(json={'dashboard':{'current':46,'high':59,'low':38,'precipitation':10,'wind':13,'bearing':300,'condition':'Cloudy','icon':None,'isDaytime':False,'moonAngle':42}})
    await context.route('**/api/weather-preview?part=dashboard',mock)
    page=await context.new_page()
    response=await page.goto(BASE+'/engineering',wait_until='domcontentloaded')
    await page.get_by_role('button',name='Safety & Logs',exact=True).wait_for(timeout=14000)
    dial=page.locator('[data-cmpri-weather-dial]')
    guide=page.get_by_role('button',name='Beginner’s Guide',exact=True)
    dialog=page.locator('dialog[data-cmpri-guide-dialog]')
    motion=page.locator('.cmpri-animation-control')
    await expect(dialog).to_have_count(0)
    if width < 701:
        await expect(guide).to_be_hidden()
        await expect(motion).to_be_visible()
        motion_box=await motion.bounding_box()
        assert motion_box is not None and abs(motion_box['x'])<=1,motion_box
        assert await dial.count()==0 and len(reads)==0
        print('390px touch: Guide and dial hidden; Play/Pause at left edge; no weather feed request',flush=True)
    else:
        await expect(guide).to_be_visible()
        if width==1440:
            await guide.click()
            await expect(dialog).to_be_visible()
            await expect(dialog.get_by_role('button',name='Start Guide')).to_be_enabled()
            await page.reload(wait_until='domcontentloaded')
            await expect(guide).to_be_visible(timeout=14000)
            await expect(dialog).to_have_count(0)
        await expect(dial).to_have_attribute('aria-label','Open Weather. 46° · Cloudy. Forecast low 38° · Forecast high 59°. Precipitation chance 10% · Wind 13 mph')
        box=await dial.bounding_box()
        assert box=={'x':width-225,'y':height-225,'width':225,'height':225},box
        assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=width and box['y']+box['height']<=height
        if touch: assert not await page.evaluate("matchMedia('(hover: hover)').matches")
        assert await dial.evaluate('(e)=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
        await expect(dial.locator('canvas[data-cmpri-weather-scene]')).to_be_visible()
        layout=await dial.evaluate('''e=>{
          const box=name=>e.querySelector(`[data-cmpri-${name}]`).getBoundingClientRect();
          const icon=box('precipitation-icon'), precip=box('precipitation-value'), wind=box('wind-value');
          const low=box('low-temperature'), high=box('high-temperature'), current=box('current-temperature');
          const midX=rect=>(rect.left+rect.right)/2, midY=rect=>(rect.top+rect.bottom)/2;
          const edge=e.querySelector('feMorphology'), artboard=e.querySelector('svg');
          return {iconGap:precip.left-icon.right, rowSpread:Math.abs(midY(precip)-midY(wind)),
            iconAlignment:Math.abs(midY(icon)-midY(precip)), centerError:Math.abs(midX(current)-(midX(low)+midX(high))/2),
            precipAlignment:Math.abs(precip.right-low.right), windAlignment:Math.abs(wind.left-high.left),
            readingGap:Math.min(precip.top,wind.top)-current.bottom, pillGap:Math.min(low.top,high.top)-Math.max(precip.bottom,wind.bottom),
            outlinePixels:Number(edge.getAttribute('radius'))*artboard.getBoundingClientRect().width/100};
        }''')
        assert 0 < layout['iconGap'] < 6,layout
        assert max(layout['rowSpread'],layout['iconAlignment'],layout['centerError'],layout['precipAlignment'],layout['windAlignment']) < 2,layout
        assert min(layout['readingGap'],layout['pillGap']) > 0,layout
        assert abs(layout['outlinePixels']-96/72)<0.01,layout
        points=[(116,110),(116,30),(75,150),(157,174),(116,9),(213,110),(194,160),(68,191)]
        for x,y in points:
            assert await dial.evaluate('(e,p)=>document.elementFromPoint(e.getBoundingClientRect().x+p[0],e.getBoundingClientRect().y+p[1])===e',[x,y]),(width,height,x,y)
        await dial.screenshot(path=str(OUT/f'weather-widget-{width}.png'))
        tab=page.get_by_role('button',name='Safety & Logs',exact=True)
        if await tab.get_attribute('aria-expanded')!='true': await tab.click()
        launcher=page.get_by_role('button',name='Weather',exact=True)
        await expect(launcher).to_have_css('background-color','rgb(0, 0, 0)')
        # This point is blank space inside the circle, rather than a painted glyph.
        await dial.click(position={'x':116,'y':30})
        await expect(page.locator('iframe[src*="/previews/cmpri-weather-preview.html"]')).to_be_visible(timeout=10000)
        assert await tab.get_attribute('aria-expanded')=='true'
        print(f'{width}x{height} {"touch" if touch else "mouse"} desktop: dial visible and inside viewport, sourced fields, Weather opens and same tab stays selected',flush=True)
    await context.close()

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        await run(browser,1440,900)
        await run(browser,1920,950,touch=True)
        await run(browser,1024,600,touch=True)
        await run(browser,701,500)
        await run(browser,390,844,touch=True)
        await browser.close()

asyncio.run(main())
