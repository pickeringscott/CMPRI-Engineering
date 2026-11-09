"""Standalone local-only browser OCR check. Uses generated fictional data only."""
from cmpri_fixture import *

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
  await install(context,'chief_engineer')
  external=[];paths=[];old_extract=[];cache_headers={};origin=urlparse(BASE)
  async def guard(route):
   parsed=urlparse(route.request.url)
   if parsed.scheme in ('http','https') and (parsed.scheme,parsed.netloc)!=(origin.scheme,origin.netloc):
    external.append(parsed.hostname or 'unknown');await route.abort();return
   if parsed.scheme in ('http','https'):
    paths.append(parsed.path)
    if parsed.path in ('/api/room-operations/extract','/api/room-operations/guest-reports/extract'):old_extract.append(parsed.path)
   await route.fallback()
  await context.route('**/*',guard)
  page=await context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('response',lambda response:cache_headers.update({urlparse(response.url).path:response.headers.get('cache-control','')}) if '/local-ocr/' in urlparse(response.url).path else None)
  # Generate both documents on this device. Names, rooms and dates are fictional.
  png_data=await page.evaluate('''() => {
   const c=document.createElement('canvas');c.width=1800;c.height=360;const x=c.getContext('2d');
   x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='bold 34px sans-serif';
   x.fillText('ROOM NUMBER',20,65);x.fillText('GUEST NAME',300,65);x.fillText('ARRIVAL',850,65);x.fillText('DEPARTURE',1180,65);
   x.font='34px sans-serif';x.fillText('101',20,140);x.fillText('SAMPLE GUEST',300,140);x.fillText('2026-11-08',850,140);x.fillText('2026-11-10',1180,140);
   return c.toDataURL('image/png').split(',')[1];
  }''')
  png=__import__('base64').b64decode(png_data)
  await page.set_content('''<!doctype html><html><body style="font:28px sans-serif"><p>ROOM NUMBER &nbsp;&nbsp; GUEST NAME &nbsp;&nbsp; ARRIVAL &nbsp;&nbsp; DEPARTURE</p><p>101 &nbsp;&nbsp; SAMPLE GUEST &nbsp;&nbsp; 2026-11-08 &nbsp;&nbsp; 2026-11-10</p></body></html>''')
  pdf=await page.pdf(format='A4')
  await page.goto(BASE+'/engineering/room-operations');await page.get_by_role('button',name='Expand upload form').click(timeout=60000)
  panel=page.get_by_role('region',name='Upload Room Operations');await panel.get_by_text('Read a report image or PDF locally',exact=True).click()
  ocr=panel.get_by_role('region',name='On-device text recognition');chooser=ocr.get_by_label('Choose a document or image')
  # File names and browser-supplied MIME values do not establish file type.
  # A document must be rejected before preview or model loading if its bytes
  # are actually executable HTML rather than a PDF.
  bad_pdf=b'<!doctype html><script>fetch("https://invalid.example/private")</script>'
  await chooser.set_input_files({'name':'fictional.pdf','mimeType':'application/pdf','buffer':bad_pdf})
  await expect(ocr.get_by_role('alert')).to_contain_text('PNG',timeout=10000)
  assert await ocr.locator('iframe,img').count()==0,'Invalid PDF must not be previewed'
  assert not any('/local-ocr/' in path for path in paths),'Invalid PDF must not start OCR or download assets'
  for name,mime,content in [('fictional.png','image/png',png),('fictional.pdf','application/pdf',pdf)]:
   await chooser.set_input_files({'name':name,'mimeType':mime,'buffer':content})
   await ocr.get_by_role('button',name='Read text',exact=True).click()
   await ocr.locator('textarea[aria-label="Extracted text, page 1"], [role="alert"]').first.wait_for(timeout=120000)
   if await ocr.get_by_role('alert').count(): raise AssertionError(f'{name}: OCR failed: '+await ocr.get_by_role('alert').inner_text())
   textbox=ocr.get_by_role('textbox',name='Extracted text, page 1')
   recognized=(await textbox.input_value()).upper()
   assert 'ROOM' in recognized and 'GUEST' in recognized and '101' in recognized, f'{name}: expected fictional header/row missing'
   await ocr.get_by_role('button',name='Clear document').click()
   print(json.dumps({'file':name,'recognizedFictionalHeaderAndRow':True}),flush=True)
  assert not external, f'Unexpected external request hosts: {external}'
  assert not old_extract, f'Server image extraction was called: {old_extract}'
  assert not errors,errors
  assets=sorted({path for path in paths if '/local-ocr/' in path})
  for suffix in ('eng.traineddata.gz','worker.min.js','pdf.worker.min.mjs'):
   assert any(path.endswith(suffix) for path in assets),f'Missing same-origin asset: {suffix}'
  assert any(path.endswith('-lstm.wasm.js') for path in assets),'Missing same-origin OCR runtime'
  print(json.dumps({'externalRequestCount':len(external),'serverExtractionCalls':len(old_extract),'localOcrAssetsLoaded':True,'cacheHeaders':cache_headers}),flush=True)
  await context.close()
  # A missing asset must fail locally; it must never fall back to an external
  # worker/model CDN or leave the user waiting indefinitely.
  for suffix in ('/worker.min.js','/eng.traineddata.gz'):
   blocked=[];fallbacks=[]
   failing=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
   await install(failing,'chief_engineer')
   async def block_asset(route):
    parsed=urlparse(route.request.url)
    if parsed.scheme in ('http','https') and (parsed.scheme,parsed.netloc)!=(origin.scheme,origin.netloc):
     fallbacks.append(parsed.hostname or 'unknown');await route.abort();return
    if '/local-ocr/' in parsed.path and parsed.path.endswith(suffix):
     blocked.append(parsed.path);await route.abort();return
    await route.fallback()
   await failing.route('**/*',block_asset)
   failure_page=await failing.new_page();await failure_page.goto(BASE+'/engineering/room-operations')
   await failure_page.get_by_role('button',name='Expand upload form').click(timeout=60000)
   failure_panel=failure_page.get_by_role('region',name='Upload Room Operations');await failure_panel.get_by_text('Read a report image or PDF locally',exact=True).click()
   tool=failure_panel.get_by_role('region',name='On-device text recognition')
   await tool.get_by_label('Choose a document or image').set_input_files({'name':'fictional.png','mimeType':'image/png','buffer':png})
   await tool.get_by_role('button',name='Read text',exact=True).click()
   await expect(tool.get_by_role('alert')).to_be_visible(timeout=30000)
   assert blocked, f'The requested {suffix} was not blocked'
   assert not fallbacks, f'Blocked {suffix} triggered external fallback: {fallbacks}'
   print(json.dumps({'blockedAsset':suffix,'errorDisplayed':True,'externalFallbackCount':0}),flush=True)
   await failing.close()
  await browser.close()

asyncio.run(main())
