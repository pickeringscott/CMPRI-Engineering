import asyncio
from cmpri_fixture import BASE, UID, OUT, install, async_playwright, expect

async def run(browser, width, height, touch=False):
    context = await browser.new_context(viewport={'width':width,'height':height}, has_touch=touch, is_mobile=width<701, service_workers='block')
    await install(context,'chief_engineer')
    await context.add_init_script(f'localStorage.setItem("cmpri:beginners-guide:opened:{UID}","1"); localStorage.setItem("cmpri:ask-files-consent:v1","1");')
    reads=[]
    async def mock(route):
        reads.append(route.request.url)
        await route.fulfill(json={'dashboard':{'current':46,'high':59,'low':38,'precipitation':10,'wind':13,'bearing':300,'condition':'Cloudy','icon':None,'isDaytime':False,'moonAngle':42}})
    await context.route('**/api/weather-preview?part=dashboard',mock)
    page=await context.new_page()
    await page.goto(BASE+'/engineering',wait_until='domcontentloaded')
    await page.get_by_role('button',name='Safety & Logs',exact=True).wait_for(timeout=14000)
    dial=page.locator('[data-cmpri-weather-dial]')
    await expect(dial).to_have_attribute('aria-label','Open Weather. 46° · Cloudy. Forecast low 38° · Forecast high 59°. Precipitation chance 10% · Wind 13 mph')
    box=await dial.bounding_box()
    assert box and box['x']>=0 and box['y']>=0, box
    assert abs(box['x']+box['width']-width)<1 and abs(box['y']+box['height']-height)<1, box
    assert reads
    scale=box['width']/225
    if touch: assert not await page.evaluate("matchMedia('(hover: hover)').matches")
    assert await dial.evaluate('(e)=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
    await expect(dial.locator('svg[data-condition=cloud]')).to_be_visible()
    layout=await dial.evaluate('''e=>{
      const icon=e.querySelector('[data-cmpri-precipitation-icon]').getBoundingClientRect();
      const value=e.querySelector('[data-cmpri-precipitation-value]');
      const valueBox=value.getBoundingClientRect();
      const wind=e.querySelector('[data-cmpri-wind-indicator]');
      const style=getComputedStyle(value), canvas=document.createElement('canvas').getContext('2d');
      canvas.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const descent=canvas.measureText(value.textContent).actualBoundingBoxDescent;
      const valueBottom=new DOMPoint(Number(value.getAttribute('x')),Number(value.getAttribute('y'))+descent).matrixTransform(value.getScreenCTM()).y;
      const windBottom=new DOMPoint(Number(wind.getAttribute('cx')),Number(wind.getAttribute('cy'))+Number(wind.getAttribute('r'))+parseFloat(getComputedStyle(wind).strokeWidth)/2).matrixTransform(wind.getScreenCTM()).y;
      const edge=e.querySelector('feMorphology'), artboard=e.querySelector('svg');
      return {iconBottom:icon.bottom,valueTop:valueBox.top,alignment:Math.abs(valueBottom-windBottom),outlinePixels:Number(edge.getAttribute('radius'))*artboard.getBoundingClientRect().width/100};
    }''')
    assert layout['iconBottom'] < layout['valueTop'],layout
    assert layout['alignment'] <= 1.5,layout
    assert abs(layout['outlinePixels']-(96/72)*scale)<0.01,layout
    points=[(116,110),(116,30),(75,150),(157,174),(116,9),(213,110),(194,160),(68,191)]
    for x,y in points:
        assert await dial.evaluate('(e,p)=>document.elementFromPoint(e.getBoundingClientRect().x+p[0],e.getBoundingClientRect().y+p[1])===e',[x*scale,y*scale]),(width,height,x,y)
    await dial.screenshot(path=str(OUT/f'weather-widget-{width}.png'))
    tab=page.get_by_role('button',name='Safety & Logs',exact=True)
    if await tab.get_attribute('aria-expanded')!='true': await tab.click()
    # This point is blank space inside the circle, rather than a painted glyph.
    await dial.click(position={'x':116*scale,'y':30*scale})
    await expect(page.locator('iframe[src*="/previews/cmpri-weather-preview.html"]')).to_be_visible(timeout=10000)
    assert await tab.get_attribute('aria-expanded')=='true'
    print(f'{width}x{height} {"touch" if touch else "mouse"}: dial anchored to viewport, sourced fields, Weather opens and same tab stays selected',flush=True)
    await context.close()

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        await run(browser,1440,900)
        await run(browser,1920,950,touch=True)
        await run(browser,1024,600,touch=True)
        await run(browser,701,500)
        await run(browser,390,844,touch=True)
        await browser.close()

asyncio.run(main())
