"""Standalone local-only browser OCR check. Uses generated fictional data only."""
from cmpri_fixture import *

async def main():
 results=[]
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
  # The image is genuinely wider than the OCR working-resolution bound. Its
  # text stays large after downsampling; trailing PNG bytes also put the file
  # over the old 10 MiB gate without allocating a huge noisy pixel fixture.
  large_png_data=await page.evaluate('''() => {
   const c=document.createElement('canvas');c.width=8000;c.height=600;const x=c.getContext('2d');
   x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='bold 120px sans-serif';
   x.fillText('ROOM GUEST 101',100,240);
   return c.toDataURL('image/png').split(',')[1];
  }''')
  large_png=__import__('base64').b64decode(large_png_data)
  assert large_png[-12:]==b'\x00\x00\x00\x00IEND\xaeB`\x82','Expected a complete generated PNG'
  large_png+=b'\x00'*(10*1024*1024+1-len(large_png))
  assert len(large_png)>10*1024*1024,'Large-image fixture must exceed the former byte limit'
  await page.set_content('''<!doctype html><html><body style="font:28px sans-serif"><p>ROOM NUMBER &nbsp;&nbsp; GUEST NAME &nbsp;&nbsp; ARRIVAL &nbsp;&nbsp; DEPARTURE</p><p>101 &nbsp;&nbsp; SAMPLE GUEST &nbsp;&nbsp; 2026-11-08 &nbsp;&nbsp; 2026-11-10</p></body></html>''')
  pdf=await page.pdf(format='A4')
  # Eleven small real PDF pages keep recognition fast while exercising the
  # default first batch, the remaining page, and original source numbering.
  await page.set_content('''<!doctype html><html><head><style>
   @page { size:450px 170px; margin:0; }
   body { margin:0; font:32px/1.3 sans-serif; }
   .sheet { height:170px; box-sizing:border-box; padding:20px; break-after:page; }
   .sheet:last-child { break-after:auto; }
  </style></head><body>'''+''.join(f'<div class="sheet"><div>ROOM GUEST 101</div><div>PAGE {number}</div></div>' for number in range(1,12))+'</body></html>')
  long_pdf=await page.pdf(prefer_css_page_size=True)
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
  await chooser.set_input_files({'name':'fictional-large.png','mimeType':'image/png','buffer':large_png})
  await expect(ocr.get_by_role('heading',name='Original: fictional-large.png',exact=True)).to_be_visible()
  await expect(ocr.get_by_text('This large image will be resized locally for recognition.',exact=False)).to_be_visible()
  assert await ocr.locator('img').count()==0,'Large-image selection must not eagerly decode a full-size preview'
  assert not any('/local-ocr/' in path for path in paths),'Selection alone must not start OCR'
  await expect(ocr.get_by_role('button',name='Read text',exact=True)).to_be_enabled()
  await ocr.get_by_role('button',name='Read text',exact=True).click()
  await ocr.locator('textarea[aria-label="Extracted text, page 1"], [role="alert"]').first.wait_for(timeout=120000)
  if await ocr.get_by_role('alert').count(): raise AssertionError('Large-image OCR failed: '+await ocr.get_by_role('alert').inner_text())
  recognized=(await ocr.get_by_role('textbox',name='Extracted text, page 1').input_value()).upper()
  assert all(value in recognized for value in ('ROOM','GUEST','101')),f'Large-image OCR lost the fictional text: {recognized!r}'
  await page.screenshot(path=str(OUT/'local-ocr-large-image.png'),full_page=True)
  results.append({'file':'fictional-large.png','bytes':len(large_png),'sourceWidth':8000,'sourceHeight':600,'eagerImagePreview':False,'recognizedFictionalHeaderAndRow':True})
  print(json.dumps(results[-1]),flush=True)
  await ocr.get_by_role('button',name='Clear document').click()
  await expect(ocr.get_by_role('textbox')).to_have_count(0)
  for name,mime,content in [('fictional.png','image/png',png),('fictional.pdf','application/pdf',pdf)]:
   await chooser.set_input_files({'name':name,'mimeType':mime,'buffer':content})
   await ocr.get_by_role('button',name='Read text',exact=True).click()
   await ocr.locator('textarea[aria-label="Extracted text, page 1"], [role="alert"]').first.wait_for(timeout=120000)
   if await ocr.get_by_role('alert').count(): raise AssertionError(f'{name}: OCR failed: '+await ocr.get_by_role('alert').inner_text())
   textbox=ocr.get_by_role('textbox',name='Extracted text, page 1')
   recognized=(await textbox.input_value()).upper()
   assert 'ROOM' in recognized and 'GUEST' in recognized and '101' in recognized, f'{name}: expected fictional header/row missing'
   await ocr.get_by_role('button',name='Clear document').click()
   results.append({'file':name,'recognizedFictionalHeaderAndRow':True});print(json.dumps(results[-1]),flush=True)
  await chooser.set_input_files({'name':'fictional-eleven-pages.pdf','mimeType':'application/pdf','buffer':long_pdf})
  await expect(ocr.get_by_role('button',name='Read text',exact=True)).to_be_enabled()
  await ocr.get_by_role('button',name='Read text',exact=True).click()
  await ocr.locator('textarea[aria-label="Extracted text, page 10"], [role="alert"]').first.wait_for(timeout=120000)
  if await ocr.get_by_role('alert').count(): raise AssertionError('First PDF batch failed: '+await ocr.get_by_role('alert').inner_text())
  await expect(ocr.get_by_role('status')).to_have_text('Pages 1–10 of 11 are ready to review.')
  assert await ocr.get_by_role('textbox').count()==10,'Default PDF batch must contain ten source pages'
  for number in range(1,11):
   recognized=(await ocr.get_by_role('textbox',name=f'Extracted text, page {number}',exact=True).input_value()).upper()
   assert all(value in recognized for value in ('ROOM','GUEST','101')),f'PDF source page {number}: fictional text missing'
  next_batch=ocr.get_by_role('button',name='Read pages 11–11',exact=True)
  await expect(next_batch).to_be_disabled()
  await expect(ocr.get_by_role('button',name='Copy reviewed text',exact=True)).to_be_disabled()
  await ocr.get_by_role('checkbox').check()
  await expect(next_batch).to_be_enabled()
  await expect(ocr.get_by_role('button',name='Copy reviewed text',exact=True)).to_be_enabled()
  await next_batch.click()
  await ocr.locator('textarea[aria-label="Extracted text, page 11"], [role="alert"]').first.wait_for(timeout=120000)
  if await ocr.get_by_role('alert').count(): raise AssertionError('Next PDF batch failed: '+await ocr.get_by_role('alert').inner_text())
  await expect(ocr.get_by_role('status')).to_have_text('Pages 11–11 of 11 are ready to review.')
  await expect(ocr.get_by_role('textbox')).to_have_count(1)
  await expect(ocr.get_by_role('textbox',name='Extracted text, page 1',exact=True)).to_have_count(0)
  recognized=(await ocr.get_by_role('textbox',name='Extracted text, page 11',exact=True).input_value()).upper()
  assert all(value in recognized for value in ('ROOM','GUEST','101')),f'PDF source page 11: fictional text missing: {recognized!r}'
  await expect(ocr.get_by_role('checkbox')).not_to_be_checked()
  await expect(ocr.get_by_role('button',name='Copy reviewed text',exact=True)).to_be_disabled()
  await page.screenshot(path=str(OUT/'local-ocr-pdf-page-11.png'),full_page=True)
  await ocr.get_by_role('button',name='Clear document').click()
  await expect(ocr.get_by_role('textbox')).to_have_count(0)
  results.append({'file':'fictional-eleven-pages.pdf','sourcePages':11,'defaultBatchPages':list(range(1,11)),'nextBatchPages':[11],'recognizedFictionalHeaderAndRow':True,'reviewResetBetweenBatches':True})
  print(json.dumps(results[-1]),flush=True)
  assert not external, f'Unexpected external request hosts: {external}'
  assert not old_extract, f'Server image extraction was called: {old_extract}'
  assert not errors,errors
  assets=sorted({path for path in paths if '/local-ocr/' in path})
  for suffix in ('eng.traineddata.gz','worker.min.js','pdf.worker.min.mjs'):
   assert any(path.endswith(suffix) for path in assets),f'Missing same-origin asset: {suffix}'
  assert any(path.endswith('-lstm.wasm.js') for path in assets),'Missing same-origin OCR runtime'
  results.append({'externalRequestCount':len(external),'serverExtractionCalls':len(old_extract),'localOcrAssetsLoaded':True,'cacheHeaders':cache_headers});print(json.dumps(results[-1]),flush=True)
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
   results.append({'blockedAsset':suffix,'errorDisplayed':True,'externalFallbackCount':0});print(json.dumps(results[-1]),flush=True)
   await failing.close()
  await browser.close()
 OUT.joinpath('local-ocr-privacy.json').write_text(json.dumps(results,indent=2))

asyncio.run(asyncio.wait_for(main(),timeout=360))
