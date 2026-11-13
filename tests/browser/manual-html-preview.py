"""Real PDF-to-HTML rendering on local fixtures; no production writes or catalog reads."""
import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from cmpri_fixture import BASE, UID, WID, install, async_playwright, expect

ASSET = '00000000-0000-4000-8000-000000000020'
FILE = '00000000-0000-4000-8000-000000000021'
OUT = Path(os.environ.get('CMPRI_UI_OUTPUT', 'work/manual-html-preview'))
OUT.mkdir(parents=True, exist_ok=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        generator = await browser.new_page()
        await generator.set_content('''<style>@page{size:612pt 792pt;margin:0}body{margin:0}.sheet{height:792pt;position:relative;break-after:page}h1{margin:0;padding:20pt;font:18pt sans-serif}footer{position:absolute;bottom:15pt;right:20pt;font:14pt sans-serif}svg{position:absolute;left:15pt;top:100pt;width:580pt;height:550pt}</style>''' + ''.join(
            f'''<section class="sheet"><h1>HEAT ERROR PAGE {number}</h1><svg viewBox="0 0 580 550"><text x="5" y="20">LEFT DIAGRAM LABEL</text><rect x="30" y="40" width="500" height="450" fill="none" stroke="red" stroke-width="4"/><path d="M50 80 L500 450" stroke="blue" stroke-width="4"/><text x="360" y="530">BOTTOM DIAGRAM LABEL</text></svg><footer>COMPLETE FOOTER {number}</footer></section>''' for number in range(1, 4)))
        pdf = await generator.pdf(prefer_css_page_size=True)
        await generator.close()
        actual_path = os.environ.get('CMPRI_MANUAL_PREVIEW_PDF')
        if actual_path:
            pdf = Path(actual_path).read_bytes()
        (OUT / 'source.pdf').write_bytes(pdf)
        asset = {'id': ASSET, 'name': 'Fixture Dryer', 'asset_type': 'Dryer', 'location_id': 'loc-1', 'manufacturer': 'Fixture Maker', 'model_number': 'TEST-1', 'active': True, 'updated_at': '2026-11-12T12:00:00Z'}
        source = f'/api/assets/documentation/source?assetId={ASSET}&fileId={FILE}&sha256=' + 'a' * 64
        knowledge = {'source': {'verified': True, 'source_kind': 'asset-upload', 'source_file_name': 'Fixture dryer manual.pdf', 'file_url': source, 'storage_path': 'fixture/manual.pdf', 'sha256': 'a' * 64, 'registered_file_id': FILE}, 'symptom_rules': [], 'error_codes': [], 'source_passages': [{'page': number, 'text': f'Heat error diagram on page {number}', 'kind': 'reference', 'source_url': source, 'source_document_id': FILE, 'source_sha256': 'a' * 64} for number in [1, 2, 3]]}
        knowledge['symptom_rules'] = [
            {'match': ['heat error'], 'steps': ['HEATING — Supply present? — Yes: Inspect the connection.'], 'source_pages': [1]},
            {'match': ['heat error'], 'steps': ['HEATING — Supply present? — No: Check the supply.'], 'source_pages': [3]},
            {'match': ['door stuck'], 'steps': ['Inspect the door.'], 'source_pages': [2]},
        ]
        if os.environ.get('CMPRI_MANUAL_PREVIEW_KNOWLEDGE'):
            extracted = json.loads(Path(os.environ['CMPRI_MANUAL_PREVIEW_KNOWLEDGE']).read_text())
            knowledge.update(extracted)
        order = {'id': WID, 'display_id': 'fixture-1', 'revision': 1, 'room': '204', 'location_id': 'loc-1', 'asset_id': ASSET, 'asset_name': asset['name'], 'issue': 'Heat error', 'status': 'Open', 'priority': 'Medium', 'category': 'Laundry', 'created_by': UID, 'technician_name': '', 'notes': '', 'created_at': '2026-11-12T12:00:00Z'}
        code = """import fs from 'node:fs';import {deriveTroubleshootingChecklistContext} from './src/lib/work-orders/troubleshooting-checklist.ts';import {normalizeManualKnowledge} from './src/lib/manual-knowledge.ts';const r=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(deriveTroubleshootingChecklistContext({...r.order,asset:r.asset},normalizeManualKnowledge(r.knowledge))));"""
        derived = json.loads(subprocess.check_output(['node', '--import', './tests/helpers/resolve-ts.mjs', '--experimental-strip-types', '--input-type=module', '-e', code], input=json.dumps({'order': order, 'asset': asset, 'knowledge': knowledge}), text=True))
        for width in [384, 1440]:
            context = await browser.new_context(viewport={'width': width, 'height': 1000}, service_workers='block')
            await install(context, 'chief_engineer')
            order.update({'notes': '', 'revision': 1})
            exit_requests = []
            reads = []
            errors = []
            saved = {'revision': 0, 'taskStates': {}}

            async def api(route):
                url = urlparse(route.request.url)
                query = parse_qs(url.query)
                async def reply(data):
                    await route.fulfill(content_type='application/json', body=json.dumps(data))
                if url.path == '/api/assets/documentation/source':
                    assert query.get('format') == ['pdf']
                    assert route.request.headers.get('authorization') == 'Bearer fixture-token'
                    reads.append(route.request.url)
                    return await route.fulfill(content_type='application/pdf', body=pdf)
                if url.path == '/api/work-orders/' + WID:
                    return await reply({'workOrder': order})
                if url.path == '/api/work-orders/' + WID + '/troubleshooting/exit':
                    assert not order['notes'], 'The summary must be created once at close.'
                    assert saved['taskStates'], 'Close must wait for the saved checkbox.'
                    body = route.request.post_data_json
                    exit_requests.append(body)
                    completed = [step['label'] for step in derived['steps'] if saved['taskStates'].get(step['id'], {}).get('workerChecked')]
                    order['notes'] = 'CMPRI2|2026-11-13T01:00:00Z|Fixture Chief|chief_engineer|note|Troubleshooting: ' + '; '.join(completed) + ' — checked.'
                    order['revision'] += 1
                    return await reply({'ok': True, 'finalized': True, 'alreadyFinalized': False, 'eventCount': 1, 'workOrderRevision': order['revision'], 'notes': order['notes']})
                if url.path == '/api/work-orders/' + WID + '/troubleshooting':
                    if route.request.method == 'PATCH':
                        body = route.request.post_data_json
                        assert body['expectedRevision'] == saved['revision']
                        assert any(step['id'] == body['itemId'] for step in derived['steps'])
                        saved['revision'] += 1
                        saved['taskStates'][body['itemId']] = {'status': 'needs', 'workerChecked': True, 'workerId': UID, 'workerName': 'Fixture Chief'}
                    return await reply({**derived, 'contextKey': 'b' * 64, **saved, 'actor': {'id': UID, 'name': 'Fixture Chief', 'role': 'chief'}, 'canEdit': True, 'canClearAll': True, 'canClearOwn': True, 'canSeePendingReview': True, 'pendingVisits': []})
                if url.path == '/api/maintenance-reference':
                    assert 'pageImage' not in query, 'Scrolling must not download the entire PDF for each page.'
                    return await reply({'assets': [asset], 'technicians': [], 'documentation_status': 'verified', 'manualKnowledge': knowledge} if query.get('assetId') else {'assets': [asset], 'technicians': []})
                if url.path == '/api/assets':
                    return await reply({'assets': [asset], 'can_manage': True})
                if url.path == '/api/assets/photo':
                    return await route.fulfill(status=404)
                if url.path == '/api/assets/documentation':
                    return await reply({'ready': True, 'files': [], 'links': [], 'documents': [], 'verified': False, 'updated_at': asset['updated_at']})
                if url.path.endswith('/parts'):
                    return await reply({'items': [], 'parts': [], 'poLines': []})
                return await route.fallback()

            await context.route('**/api/**', api)
            page = await context.new_page()
            page.on('pageerror', lambda error: (errors.append(str(error)), print(error.stack, flush=True)))
            await page.goto(BASE + '/work-orders/' + WID)
            guide = page.locator('[data-ticket-accordion="troubleshooting"]')
            await guide.wait_for(timeout=30000)
            await guide.locator('summary').first.click()
            await expect(guide.get_by_role('checkbox')).to_have_count(len(derived['steps']))
            check = guide.get_by_role('checkbox').first
            await expect(check).to_be_enabled()
            await check.click()
            await expect(check).to_be_checked()
            assert saved['revision'] == 1
            await page.screenshot(path=str(OUT / f'guide-top-{width}.png'))
            expected_pages = sorted({number for step in derived['steps'] for number in step['sourcePages']})
            assert await guide.locator('[data-continuous-source-page]').evaluate_all('(nodes)=>nodes.map(node=>Number(node.dataset.continuousSourcePage))') == expected_pages
            assert await guide.locator('[data-source-page-surface] a').all_text_contents() == [f'Page {number}' for number in expected_pages]
            assert not re.search(r'pages indexed|Guidance uses|Equipment details changed|Extracted text from|HTML manual preview|No matching instructions', await guide.inner_text())
            first = guide.locator(f'[data-pdf-html-page="{expected_pages[0]}"]')
            await expect(first.locator('img')).to_be_visible(timeout=45000)
            first_url = await first.locator('img').get_attribute('src')
            settled_reads = len(reads)
            async def paper_color(preview):
                return await preview.locator('img').evaluate('''async img => {const bitmap=await createImageBitmap(await (await fetch(img.src)).blob()); const canvas=document.createElement('canvas'); canvas.width=bitmap.width; canvas.height=bitmap.height; const ctx=canvas.getContext('2d'); ctx.drawImage(bitmap,0,0); const rgb=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3); bitmap.close(); return rgb;}''')
            async def surface_color(preview):
                return await preview.evaluate("node=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);}")
            assert await paper_color(first) == await surface_color(first), ('PDF paper must use the current app surface', await paper_color(first), await surface_color(first))
            await first.evaluate("node=>node.closest('[data-pdf-html-preview]').style.setProperty('--cmpri-modal-surface','#20262f')")
            await expect(first.locator('img')).not_to_have_attribute('src', first_url)
            assert await paper_color(first) == [32,38,47]
            first_url = await first.locator('img').get_attribute('src')
            await expect(first.locator('[data-pdf-text-layer] span').first).to_be_attached()
            if not actual_path:
                assert 'COMPLETE FOOTER 1' in await first.locator('[data-pdf-text-layer]').inner_text()
                assert 'BOTTOM DIAGRAM LABEL' in await first.locator('[data-pdf-text-layer]').inner_text()
                footer = first.locator('[data-pdf-text-layer] span').filter(has_text='COMPLETE FOOTER 1').first
                bounds = await first.bounding_box()
                text_bounds = await footer.bounding_box()
                assert text_bounds['y'] > bounds['y'] + bounds['height'] * .9
                assert text_bounds['x'] + text_bounds['width'] <= bounds['x'] + bounds['width'] + 2
            third = guide.locator(f'[data-pdf-html-page="{expected_pages[-1]}"]')
            await third.scroll_into_view_if_needed()
            await expect(third.locator('img')).to_be_visible(timeout=30000)
            await first.scroll_into_view_if_needed()
            assert await first.locator('img').get_attribute('src') == first_url
            assert len(reads) == settled_reads, reads
            await first.screenshot(path=str(OUT / f'work-order-html-{width}.png'))
            assert not order['notes'], 'Checkbox progress must not add notes before close.'
            await page.get_by_role('link', name='← Engineering Dashboard', exact=True).click()
            await expect(page).to_have_url(BASE + '/engineering')
            assert len(exit_requests) == 1
            assert derived['steps'][0]['label'] in order['notes'] and '|Fixture Chief|' in order['notes']
            await page.goto(BASE + '/work-orders/' + WID)
            guide = page.locator('[data-ticket-accordion="troubleshooting"]')
            await guide.locator('summary').first.click()
            await expect(guide.get_by_role('checkbox').first).to_be_checked()
            await guide.get_by_role('button', name='Zoom in', exact=True).click()
            await expect(first.locator('img')).to_be_visible()
            reader_baseline = len(reads)
            await page.goto(BASE + '/management/equipment')
            await page.get_by_label('Search equipment').fill('Fixture Dryer')
            await page.get_by_role('button', name=re.compile(r'Fixture Dryer.*TEST-1')).click()
            await page.get_by_role('button', name='Documentation', exact=True).click()
            await page.get_by_role('button', name='Add Documentation', exact=True).click()
            dialog = page.get_by_role('dialog').last
            await dialog.get_by_label('Choose a manual PDF (up to 100 MB) or label image').set_input_files({'name': 'Fixture dryer manual.pdf', 'mimeType': 'application/pdf', 'buffer': pdf})
            await dialog.get_by_text('Read the complete manual or label on this device', exact=True).click()
            reader = dialog.get_by_role('region', name='On-device text recognition')
            local_first = reader.locator('[data-pdf-html-page="1"]')
            await local_first.scroll_into_view_if_needed(timeout=30000)
            await expect(local_first.locator('img')).to_be_visible(timeout=45000)
            await expect(local_first.locator('[data-pdf-text-layer] span').first).to_be_attached()
            assert len(reads) == reader_baseline, 'Local preview must use the selected File without a server read.'
            assert await paper_color(local_first) == await surface_color(local_first), 'Read preview must use the current app surface'
            await local_first.screenshot(path=str(OUT / f'reader-html-{width}.png'))
            assert not errors, errors
            print(json.dumps({'width': width, 'work_order_and_reader': 'passed', 'focused_pages': expected_pages, 'persisted_checkboxes': len(derived['steps']), 'additional_reads_on_theme_change_or_scroll': 0, 'app_theme': True, 'original_diagrams_and_selectable_text': True}), flush=True)
            await context.close()
        await browser.close()


asyncio.run(main())
