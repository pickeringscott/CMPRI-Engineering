import asyncio,base64,os,time
from playwright.async_api import async_playwright
BASE=os.environ.get('PREVIEW_URL','http://127.0.0.1:3218')
PIXEL=base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for width,height in [(390,844),(320,568),(1280,900),(844,390)]:
   page=await browser.new_page(viewport={'width':width,'height':height});errors=[];requests=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   async def fixture(route):
    requests.append(route.request.url)
    item=lambda i:{'id':f'fixture{i}','title':f'Synthetic GIF {i}','url':f'https://giphy.com/gifs/fixture{i}','images':{'fixed_width':{'url':f'https://media.giphy.com/fixture{i}.gif?cid=retained','width':'200','height':str(100+i*15)}}}
    await route.fulfill(json={'data':[item(i) for i in range(12)],'pagination':{'total_count':12}} if '/search?' in route.request.url else {'data':item(0)})
   await page.route('https://api.giphy.com/**',fixture)
   await page.route('https://media.giphy.com/**',lambda route:route.fulfill(body=PIXEL,content_type='image/gif'))
   await page.goto(BASE);await page.get_by_text('Isolated local storage · notes and uploads persist',exact=True).wait_for()
   assert await page.get_by_text('Tenor',exact=False).count()==0
   await page.get_by_role('button',name='Add GIF or media').click()
   menu=page.get_by_role('group',name='Attachment options');mb=await menu.bounding_box();modal=await page.get_by_role('dialog').bounding_box()
   assert mb['x']>=modal['x'] and mb['x']+mb['width']<=modal['x']+modal['width']
   halves=await menu.locator('button').evaluate_all('(els)=>els.map(e=>e.getBoundingClientRect().width)');assert abs(halves[0]-halves[1])<1
   await page.get_by_role('button',name='GIF',exact=True).click();await page.get_by_role('textbox',name='Search GIFs').fill('hello & team');await page.get_by_role('button',name='Search',exact=True).click()
   await page.locator('.masonry button').last.wait_for();assert await page.locator('.masonry button').count()==12
   assert all(u.startswith('https://api.giphy.com/') for u in requests);assert any('q=hello+%26+team' in u for u in requests)
   await page.get_by_role('button',name='Attach Synthetic GIF 0 from GIPHY').click()
   await page.get_by_role('button',name='Add GIF or media').click()
   async with page.expect_file_chooser() as chooser:await page.get_by_role('button',name='Media',exact=True).click()
   await (await chooser.value).set_files({'name':'persist.gif','mimeType':'image/gif','buffer':PIXEL})
   text=f'Persistent browser test {width} {time.time()}';await page.get_by_role('textbox',name='Write a comment').fill(text)
   # Fail the save after a real successful upload. The draft and uploaded attachment must survive.
   async def fail(route):
    if route.request.method=='POST':await route.fulfill(status=503,json={'error':'Test retry failure'})
    else:await route.continue_()
   await page.route('**/api/notes',fail);await page.get_by_role('button',name='Post',exact=True).click();await page.locator('.error[role=alert]').wait_for();assert 'Test retry failure' in await page.locator('.error[role=alert]').inner_text(),await page.locator('.error[role=alert]').inner_text()
   assert await page.get_by_role('textbox',name='Write a comment').input_value()==text
   assert 'Uploaded' in await page.locator('.draft-attachments').inner_text()
   await page.unroute('**/api/notes',fail);await page.get_by_role('button',name='Post',exact=True).click();await page.locator('.notes').get_by_text(text,exact=True).wait_for()
   await page.reload();await page.locator('.notes').get_by_text(text,exact=True).wait_for()
   note=page.locator('.note').filter(has_text=text);assert await note.locator('[data-kind="external-link"]').get_attribute('href')=='https://giphy.com/gifs/fixture0'
   media_url=await note.locator('.local-card img').get_attribute('src');assert media_url.startswith('/api/media/')
   response=await page.request.get(BASE+media_url);assert await response.body()==PIXEL
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   if width==390:await page.screenshot(path='/tmp/cmpri-giphy-persistent-mobile.png')
   await page.close();print(f'PASS {width}x{height}: direct GIPHY fixture, real upload/save, failed-save retry, reload and downloaded bytes')
  await browser.close()
asyncio.run(main())
