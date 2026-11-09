"""Real uploaded-PDF diagrams in a synthetic work-order browser session."""
import asyncio
import base64
import copy
import hashlib
import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from cmpri_fixture import BASE, HOTEL, UID, WID, async_playwright, expect, install

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('CMPRI_GUIDE_OUTPUT', '/workspace/previews/troubleshooting'))
OUT.mkdir(parents=True, exist_ok=True)
PREFIX = os.environ.get('CMPRI_GUIDE_IMAGE_PREFIX', 'final-native-media')
CHIEF = '00000000-0000-4000-8000-000000000021'


async def capture_guide(page, guide, checklist, filename):
 await guide.evaluate("""panel=>{
  const frame=document.createElement('section');frame.dataset.mediaPreview='true';
  frame.style.cssText='padding:8px;background:#0f172a;border:1px solid #334155;border-radius:12px';
  const label=document.createElement('p');label.textContent='SYNTHETIC PREVIEW · Actual diagram from a fictional uploaded PDF';
  label.style.cssText='margin:0 0 6px;color:#cbd5e1;font:600 12px/1.4 sans-serif';
  panel.before(frame);frame.append(label,panel);
  window.__mediaPreviewHidden=[];
  for(const element of document.querySelectorAll('body *'))if(!frame.contains(element)&&['sticky','fixed'].includes(getComputedStyle(element).position)){
   window.__mediaPreviewHidden.push([element,element.style.visibility]);element.style.visibility='hidden';
  }
 }""")
 frame=page.locator('[data-media-preview]')
 await frame.evaluate('element=>window.scrollTo(0,window.scrollY+element.getBoundingClientRect().top)')
 box=await frame.bounding_box(); end=await checklist.bounding_box()
 await page.screenshot(path=str(OUT/filename),full_page=True,clip={'x':box['x'],'y':box['y']+await page.evaluate('scrollY'),'width':box['width'],'height':end['y']+end['height']-box['y']+8})
 await page.evaluate("for(const [element,visibility] of window.__mediaPreviewHidden||[])element.style.visibility=visibility;delete window.__mediaPreviewHidden")


async def capture_viewer(page, dialog, filename):
 await dialog.locator('h2').evaluate("heading=>{heading.dataset.originalText=heading.textContent;heading.textContent='SYNTHETIC PREVIEW · '+heading.textContent}")
 await expect(dialog.get_by_role('button', name='Zoom in', exact=True)).to_be_enabled()
 await page.screenshot(path=str(OUT / filename))
 await dialog.locator('h2').evaluate('heading=>{heading.textContent=heading.dataset.originalText;delete heading.dataset.originalText}')


async def diagram_pixels(image, original_path):
 raw = base64.b64encode(Path(original_path).read_bytes()).decode()
 return await image.evaluate("""async(image,raw)=>{
  const original=new Image();original.src='data:image/png;base64,'+raw;await original.decode();
  if(image.naturalWidth!==original.naturalWidth||image.naturalHeight!==original.naturalHeight)throw Error('Diagram dimensions changed');
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(original,0,0);
  const before=context.getImageData(0,0,canvas.width,canvas.height).data;context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0);
  const after=context.getImageData(0,0,canvas.width,canvas.height).data;
  const probe=document.createElement('canvas');probe.width=probe.height=1;const color=probe.getContext('2d');
  const style=getComputedStyle(image),palette={};
  for(const key of ['--cmpri-modal-base','--cmpri-modal-surface','--cmpri-modal-text','--cmpri-outline']){
   const element=document.createElement('i');element.style.backgroundColor=style.getPropertyValue(key);image.parentElement.append(element);
   const resolved=getComputedStyle(element).backgroundColor;element.remove();color.clearRect(0,0,1,1);color.fillStyle=resolved;color.fillRect(0,0,1,1);
   palette[key]=Array.from(color.getImageData(0,0,1,1).data);
  }
  const equal=(a,offset,b)=>a[offset]===b[0]&&a[offset+1]===b[1]&&a[offset+2]===b[2];
  let whiteBefore=0,whiteAfter=0,strongColors=0,strongColorsChanged=0,modalSurfacePixels=0,neutralNodePixels=0,neutralNodesMapped=0,darkNeutralInkPixels=0,darkNeutralInkMapped=0;
  for(let i=0;i<before.length;i+=4){
   if(before[i+3]<250)continue;
   const low=Math.min(before[i],before[i+1],before[i+2]),high=Math.max(before[i],before[i+1],before[i+2]);
   if(low>=249)whiteBefore++;
   if(Math.min(after[i],after[i+1],after[i+2])>=249)whiteAfter++;
   if(high-low>=60){strongColors++;if(!equal(after,i,before.slice(i,i+3)))strongColorsChanged++;}
   if(equal(after,i,palette['--cmpri-modal-surface']))modalSurfacePixels++;
   if(high-low<=18&&low>=210&&high<249){neutralNodePixels++;if(equal(after,i,palette['--cmpri-modal-surface']))neutralNodesMapped++;}
   if(high-low<=24&&high<=64){darkNeutralInkPixels++;if(equal(after,i,palette['--cmpri-modal-text']))darkNeutralInkMapped++;}
  }
  const digest=await crypto.subtle.digest('SHA-256',after);
  return {width:canvas.width,height:canvas.height,pixels:before.length/4,whiteBefore,whiteAfter,strongColors,strongColorsChanged,modalSurfacePixels,neutralNodePixels,neutralNodesMapped,darkNeutralInkPixels,darkNeutralInkMapped,palette,corner:Array.from(after.slice(0,4)),displayedPixelsSha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
 }""", raw)


def assert_native_diagram(stats):
 assert stats['whiteBefore'] > stats['pixels'] / 3, stats
 assert stats['whiteAfter'] == 0, stats
 assert stats['modalSurfacePixels'] >= stats['whiteBefore'], stats
 assert stats['corner'] == stats['palette']['--cmpri-modal-surface'], stats
 assert stats['strongColors'] > 1000 and stats['strongColorsChanged'] == 0, stats
 assert stats['neutralNodePixels'] > 1000 and stats['neutralNodesMapped'] >= stats['neutralNodePixels'] * .95, stats
 assert stats['darkNeutralInkPixels'] > 100 and stats['darkNeutralInkMapped'] >= stats['darkNeutralInkPixels'] * .95, stats


async def viewer_palette(dialog):
 return await dialog.evaluate("""dialog=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
  const rgba=(element,property)=>{context.clearRect(0,0,1,1);context.fillStyle=getComputedStyle(element).getPropertyValue(property);context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data)};
  const button=dialog.querySelector('button[aria-label="Close diagram"]');
  const action=getComputedStyle(dialog).getPropertyValue('--cmpri-action-rgb');context.clearRect(0,0,1,1);context.fillStyle='rgba('+action+',.14)';context.fillRect(0,0,1,1);const expectedControl=Array.from(context.getImageData(0,0,1,1).data);
  return {frame:rgba(dialog,'background-color'),text:rgba(dialog,'color'),outline:rgba(dialog,'border-top-color'),viewport:rgba(dialog.querySelector('[data-diagram-viewport]'),'background-color'),control:rgba(button,'background-color'),controlOutline:rgba(button,'border-top-color'),actionRgb:action.split(',').map(Number),expectedControl};
 }""")


def real_pdf_fixtures():
 subprocess.run(['node', '--import', './tests/helpers/resolve-ts.mjs', '--experimental-strip-types',
  'tests/helpers/uploaded-guide-media-preview.mjs', str(OUT / 'real-pdf-media')], cwd=ROOT, check=True)
 artifact = json.loads((OUT / 'real-pdf-media/manifest.json').read_text())
 assert artifact['externalAttempts'] == []
 spec = importlib.util.spec_from_file_location('guide_integrity', Path(__file__).with_name('troubleshooting-guide-integrity.py'))
 previous = importlib.util.module_from_spec(spec)
 spec.loader.exec_module(previous)
 original = previous.fixtures()[0]
 rows = []
 for issue, index in [('Washer not draining', 0), ('Washer not filling', 0), ('Washer not filling', 1)]:
  row = copy.deepcopy(original)
  row['order'].update(issue=issue, reporter_notes='', revision=len(rows) + 1)
  row['knowledge'] = artifact['variants'][index]['knowledge']
  row['knowledge']['source']['file_url'] = BASE + '/guides/guest-room.pdf'
  row['mediaFiles'] = artifact['variants'][index]['mediaFiles']
  rows.append(row)
 code = """
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeManualKnowledge} from './src/lib/manual-knowledge.ts';
import {deriveTroubleshootingChecklistContext} from './src/lib/work-orders/troubleshooting-checklist.ts';
const rows=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(rows.map(row=>{
 const context=deriveTroubleshootingChecklistContext({...row.order,asset:row.asset},normalizeManualKnowledge(row.knowledge));
 return {...row,...context,contextKey:context.contextIdentity?createHash('sha256').update(context.contextIdentity).digest('hex'):null};
})));
"""
 rows = json.loads(subprocess.check_output(['node', '--import', './tests/helpers/resolve-ts.mjs',
  '--experimental-strip-types', '--input-type=module', '-e', code], cwd=ROOT, input=json.dumps(rows), text=True))
 assert len({row['contextKey'] for row in rows}) == 3
 for row in rows:
  assert row['steps'] and any(step.get('media') for step in row['steps']), row['steps']
 return rows


async def main():
 variants = real_pdf_fixtures()
 results = []
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
  for width in [1440, 384]:
   role = 'chief_engineer' if width == 1440 else 'technician'
   actor_id = CHIEF if width == 1440 else UID
   actor = {'id': actor_id, 'name': 'Jordan Lee' if width == 1440 else 'Alex Morgan', 'role': 'chief' if width == 1440 else 'technician'}
   ctx = await browser.new_context(viewport={'width': width, 'height': 1000}, is_mobile=width == 384, has_touch=width == 384, service_workers='block')
   await install(ctx, role, user_id=actor_id)
   state = {'variant': 0, 'holdNext': False}
   image_calls, forbidden, external, errors = [], [], [], []
   held = {'started': asyncio.Event(), 'release': asyncio.Event()}
   async def websocket(ws):
    host = urlparse(ws.url).hostname
    if host in ['127.0.0.1', 'localhost']: ws.connect_to_server()
    elif host == 'ci-placeholder.supabase.co': await ws.close()
    else: external.append(host); await ws.close()
   await ctx.route_web_socket('**/*', websocket)
   async def route(request):
    parsed = urlparse(request.request.url)
    query = parse_qs(parsed.query)
    if parsed.hostname not in ['127.0.0.1', 'localhost']:
     external.append(parsed.hostname); return await request.abort()
    if not parsed.path.startswith('/api/'): return await request.fallback()
    if parsed.path == '/api/assets/documentation' or any(token in parsed.path for token in ['/api/ai/', '/api/catalog/', '/api/source-search', '/api/assistant', '/api/chat']) or query.get('source') == ['catalog']:
     forbidden.append(parsed.path); return await request.abort()
    current = variants[state['variant']]
    async def respond(data):
     await request.fulfill(content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(data))
    if parsed.path == '/api/maintenance-reference' and query.get('imageId'):
     assert request.request.method == 'GET'
     assert set(query) == {'source', 'assetId', 'imageId', 'sha256'}, query
     assert query['source'] == ['asset-upload'] and query['assetId'] == [current['asset']['id']]
     assert query['sha256'] == [current['knowledge']['source']['sha256']]
     assert request.request.headers.get('authorization') == 'Bearer fixture-token'
     image_id = query['imageId'][0]
     assert image_id in current['mediaFiles']
     image_calls.append({'id': image_id, 'sha256': query['sha256'][0], 'variant': state['variant']})
     if state['holdNext']:
      state['holdNext'] = False; held['started'].set(); await held['release'].wait()
     return await request.fulfill(content_type='image/png', headers={'Cache-Control': 'private, no-store, max-age=0'}, body=Path(current['mediaFiles'][image_id]).read_bytes())
    if request.request.method not in ['GET', 'HEAD']:
     forbidden.append(request.request.method + ' ' + parsed.path); return await request.abort()
    if parsed.path == '/api/work-orders/' + WID:
     return await respond({'workOrder': current['order']})
    if parsed.path == '/api/maintenance-reference':
     if not query.get('assetId'): return await respond({'assets': [current['asset']], 'technicians': []})
     assert query.get('source') == ['asset-upload']
     return await respond({'documentation_status': 'verified', 'manualKnowledge': current['knowledge'], 'asset_id': current['asset']['id']})
    if parsed.path == '/api/work-orders/' + WID + '/troubleshooting':
     states = {current['steps'][0]['id']: {'status': 'needs', 'workerChecked': True, 'workerId': UID, 'workerName': 'Alex Morgan'}} if state['variant'] == 0 else {}
     return await respond({'contextKey': current['contextKey'], 'contextIdentity': current['contextIdentity'], 'revision': 0, 'actor': actor,
      'canEdit': True, 'canClearAll': width == 1440, 'canClearOwn': True, 'canSeePendingReview': width == 1440,
      'steps': current['steps'], 'taskStates': states, 'pendingVisits': []})
    if parsed.path.endswith('/attachments'): return await respond({'images': []})
    return await request.fallback()
   await ctx.route('**/*', route)
   page = await ctx.new_page()
   page.on('pageerror', lambda error: errors.append(str(error)))
   await page.goto(BASE + '/work-orders/' + WID)
   # Local Next development chrome is absent from the released application.
   await page.add_style_tag(content='nextjs-portal{display:none!important}')
   guide = page.get_by_role('heading', name='Suggested Troubleshooting', exact=True).locator('xpath=../..')
   await guide.wait_for(timeout=60000)
   if await guide.get_attribute('open') is None: await guide.locator('summary').first.click()
   checklist = guide.get_by_role('region', name='Work-order troubleshooting checklist')
   await checklist.get_by_role('checkbox').first.wait_for(timeout=30000)
   images = checklist.get_by_role('region', name='Step images and diagrams')
   await expect(images.first).to_be_visible(timeout=30000)
   assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   await expect(guide.locator('a[href="' + BASE + '/guides/guest-room.pdf"]')).to_have_count(1)
   await expect(guide.locator('a[href*="#page="]')).to_have_count(0)
   for row in await checklist.locator('li').all():
    await expect(row.get_by_role('checkbox')).to_have_count(1)
    assert 'Clear check' not in (await row.get_by_role('checkbox').get_attribute('title') or '')
   await expect(guide.get_by_role('button', name='Copy', exact=True)).to_have_count(0)
   await expect(guide.get_by_role('button', name='Clear check', exact=True)).to_have_count(0)
   image_link = images.first.get_by_role('link', name='Open image/diagram', exact=True)
   if width == 384:
    assert not image_calls, 'Phone must fetch image only after its explicit link is selected'
    await expect(images.locator('img')).to_have_count(0)
    await image_link.click()
   else:
    inline = images.first.locator('img').first
    await expect(inline).to_be_visible()
    await expect(inline).to_have_js_property('complete', True)
    assert await inline.evaluate('image=>image.naturalWidth>100 && image.naturalHeight>50')
    await inline.click()
   dialog = page.get_by_role('dialog')
   await expect(dialog).to_be_visible(timeout=30000)
   drain_ids = {image['id'] for step in variants[0]['steps'] for image in step.get('media', [])}
   assert image_calls and all(call['id'] in drain_ids for call in image_calls), 'Drain issue must not request fill, logo or unrelated figures'
   viewport = dialog.locator('[data-diagram-viewport]')
   await expect(dialog.locator('[data-diagram-image]')).to_be_visible()
   await expect(dialog.get_by_role('button', name='Zoom in', exact=True)).to_be_enabled()
   raw_path = variants[0]['mediaFiles'][image_calls[0]['id']]
   pixels = await diagram_pixels(dialog.locator('[data-diagram-image]'),raw_path)
   assert_native_diagram(pixels)
   frame_palette=await viewer_palette(dialog)
   assert frame_palette['frame']==frame_palette['viewport']==pixels['palette']['--cmpri-modal-surface'],frame_palette
   assert frame_palette['text']==pixels['palette']['--cmpri-modal-text'],frame_palette
   assert frame_palette['outline']==frame_palette['controlOutline']==pixels['palette']['--cmpri-outline'],frame_palette
   assert frame_palette['control']==frame_palette['expectedControl'],frame_palette
   await capture_viewer(page,dialog,PREFIX + '-diagram-' + ('phone' if width == 384 else 'desktop') + '.png')
   await dialog.get_by_role('button', name='Zoom in', exact=True).click()
   assert float(await viewport.get_attribute('data-diagram-scale')) > 1
   await dialog.get_by_role('button', name='Reset zoom', exact=True).click()
   assert float(await viewport.get_attribute('data-diagram-scale')) == 1
   if width == 384:
    cdp = await ctx.new_cdp_session(page)
    box = await viewport.bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    async def touch(kind, points):
     await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': px, 'y': py, 'id': index + 1} for index, (px, py) in enumerate(points)]})
    await touch('touchStart', [(x - 25, y), (x + 25, y)])
    await touch('touchMove', [(x - 75, y), (x + 75, y)])
    await touch('touchEnd', [])
    await expect(viewport).not_to_have_attribute('data-diagram-scale', '1')
    before = (float(await viewport.get_attribute('data-diagram-x')), float(await viewport.get_attribute('data-diagram-y')))
    await touch('touchStart', [(x, y)])
    await touch('touchMove', [(x + 30, y + 20)])
    await touch('touchEnd', [])
    after = (float(await viewport.get_attribute('data-diagram-x')), float(await viewport.get_attribute('data-diagram-y')))
    assert before != after, 'Pinched image must pan with one touch'
   if width == 384: await capture_viewer(page,dialog,PREFIX + '-diagram-phone-zoomed.png')
   await dialog.get_by_role('button', name='Close diagram', exact=True).click()
   await expect(dialog).to_have_count(0)
   await capture_guide(page,guide,checklist,PREFIX + '-guide-' + ('tech-phone' if width == 384 else 'chief-desktop') + '.png')
   # A saved issue replacement must close a currently open image and remove the
   # old instruction/diagram even when its previous source PDF still exists.
   if width == 384: await image_link.click()
   else: await images.first.locator('img').first.click()
   await expect(dialog).to_be_visible()
   state['variant'] = 1
   await page.evaluate("async()=>{await window.__cmpriDeviceData.invalidate(['orders','reference']);}")
   await expect(page.get_by_role('button', name='Edit reported issue', exact=True)).to_contain_text('Washer not filling')
   await expect(dialog).to_have_count(0)
   for step in variants[0]['steps']:
    await expect(checklist.get_by_text(step['label'], exact=True)).to_have_count(0)
   # Source replacement while a phone image is loading must discard that late
   # previous-SHA reply. Desktop replacement must discard its open viewer.
   if width == 384:
    state['holdNext'] = True
    await images.first.get_by_role('link', name='Open image/diagram', exact=True).click()
    await asyncio.wait_for(held['started'].wait(), 15)
   else:
    await expect(images.first.locator('img').first).to_be_visible()
    await images.first.locator('img').first.click()
    await expect(dialog).to_be_visible()
   state['variant'] = 2
   await page.evaluate("async()=>{await window.__cmpriDeviceData.invalidate(['orders','reference']);}")
   await expect(images.first.locator('a').first).to_have_attribute('href', re.compile('sha256=' + variants[2]['knowledge']['source']['sha256']))
   await expect(checklist.get_by_role('checkbox').first).to_have_attribute('data-preview-status', 'empty')
   held['release'].set()
   await expect(dialog).to_have_count(0)
   if width == 384:
    await images.first.get_by_role('link', name='Open image/diagram', exact=True).click()
    await expect(dialog).to_be_visible(timeout=30000)
    await dialog.get_by_role('button', name='Close diagram', exact=True).click()
   else:
    await expect(images.first.locator('img').first).to_be_visible()
   assert any(call['variant'] == 2 for call in image_calls)
   # The same source must follow a live host palette change, without painting
   # an old themed raster into a newly colored modal. Restore before returning.
   if width == 384: await images.first.get_by_role('link',name='Open image/diagram',exact=True).click()
   else: await images.first.locator('img').first.click()
   await expect(dialog).to_be_visible()
   original_theme=await page.evaluate("""()=>{
    const root=document.documentElement,values={'--cmpri-modal-surface':'rgb(31,37,41)','--cmpri-modal-base':'rgb(20,24,27)','--cmpri-modal-text':'rgb(244,239,225)','--cmpri-outline':'rgba(76,190,171,.42)','--cmpri-action-rgb':'76,190,171'};
    const previous=Object.fromEntries(Object.keys(values).map(key=>[key,root.style.getPropertyValue(key)]));
    for(const [key,value]of Object.entries(values))root.style.setProperty(key,value);
    window.dispatchEvent(new Event('cmpri-palette-change'));return previous;
   }""")
   await expect(dialog).to_have_count(0)
   if width == 384: await images.first.get_by_role('link',name='Open image/diagram',exact=True).click()
   else: await images.first.locator('img').first.click()
   await expect(dialog).to_be_visible()
   await expect(dialog.get_by_role('button',name='Zoom in',exact=True)).to_be_enabled()
   fill_id=variants[2]['steps'][0]['media'][0]['id']
   changed_pixels=await diagram_pixels(dialog.locator('[data-diagram-image]'),variants[2]['mediaFiles'][fill_id])
   assert_native_diagram(changed_pixels)
   assert changed_pixels['palette']['--cmpri-modal-surface']==[31,37,41,255], changed_pixels
   await page.evaluate("""previous=>{const root=document.documentElement;for(const[key,value]of Object.entries(previous)){if(value)root.style.setProperty(key,value);else root.style.removeProperty(key);}window.dispatchEvent(new Event('cmpri-palette-change'));}""",original_theme)
   await expect(dialog).to_have_count(0)
   assert not external, external
   assert not forbidden, forbidden
   assert not errors, errors
   results.append({'width': width, 'realPdfMedia': True, 'issueSpecificSourceFigureOnly': True, 'desktopInlineOrMobileExplicitLink': True,
    'nativeModalCanvasAndNodes': True, 'viewerFrameInheritsModalSurface': True, 'chromaticSourcePixelsUnchanged': True, 'inheritsLiveHostPalette': True, 'viewerPalette': frame_palette,
    'sourcePdfSha256': variants[0]['knowledge']['source']['sha256'], 'rawPngSha256': hashlib.sha256(Path(raw_path).read_bytes()).hexdigest(), 'diagramPixels': pixels,
    'viewerZoomResetClose': True, 'nativePinchAndPan': True if width == 384 else None,
    'issueReplacementClosesOldDiagram': True, 'sourceReplacementDropsStaleDiagram': True,
    'topPdfOnlyAndOneCheckboxPerStep': True, 'externalProviderAttempts': 0,
    'catalogSearchOrAiRequests': 0, 'productionWrites': 0, 'pageErrors': 0, 'mediaRequests': len(image_calls)})
   print(json.dumps(results[-1]), flush=True)
   await ctx.close()
  await browser.close()
 (OUT / 'media-browser-results.json').write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
 asyncio.run(main())
