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
        asset = {'id': ASSET, 'name': 'Fixture Dryer', 'asset_type': 'Dryer', 'location_id': 'loc-1', 'manufacturer': 'Fixture Maker', 'model_number': 'TEST-1', 'active': True, 'updated_at': '2026-11-12T12:00:00Z'}
        source = f'/api/assets/documentation/source?assetId={ASSET}&fileId={FILE}&sha256=' + 'a' * 64
        knowledge = {'source': {'verified': True, 'source_kind': 'asset-upload', 'source_file_name': 'Fixture dryer manual.pdf', 'file_url': source, 'storage_path': 'fixture/manual.pdf', 'sha256': 'a' * 64, 'registered_file_id': FILE}, 'symptom_rules': [], 'error_codes': [], 'source_passages': [{'page': number, 'text': f'Heat error diagram on page {number}', 'kind': 'reference', 'source_url': source, 'source_document_id': FILE, 'source_sha256': 'a' * 64} for number in [1, 2, 3]]}
        order = {'id': WID, 'display_id': 'fixture-1', 'revision': 1, 'room': '204', 'location_id': 'loc-1', 'asset_id': ASSET, 'asset_name': asset['name'], 'issue': 'Heat error', 'status': 'Open', 'priority': 'Medium', 'category': 'Laundry', 'created_by': UID, 'technician_name': '', 'notes': '', 'created_at': '2026-11-12T12:00:00Z'}
        code = """import fs from 'node:fs';import {deriveTroubleshootingChecklistContext} from './src/lib/work-orders/troubleshooting-checklist.ts';import {normalizeManualKnowledge} from './src/lib/manual-knowledge.ts';const r=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(deriveTroubleshootingChecklistContext({...r.order,asset:r.asset},normalizeManualKnowledge(r.knowledge))));"""
        derived = json.loads(subprocess.check_output(['node', '--import', './tests/helpers/resolve-ts.mjs', '--experimental-strip-types', '--input-type=module', '-e', code], input=json.dumps({'order': order, 'asset': asset, 'knowledge': knowledge}), text=True))
        for width in [384, 1440]:
            context = await browser.new_context(viewport={'width': width, 'height': 1000}, service_workers='block')
            await install(context, 'chief_engineer')
            reads = []
            errors = []

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
                if url.path == '/api/work-orders/' + WID + '/troubleshooting':
                    return await reply({**derived, 'contextKey': 'b' * 64, 'revision': 0, 'actor': {'id': UID, 'name': 'Fixture Chief', 'role': 'chief'}, 'canEdit': True, 'canClearAll': True, 'canClearOwn': True, 'canSeePendingReview': True, 'taskStates': {}, 'pendingVisits': []})
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
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(BASE + '/work-orders/' + WID)
            guide = page.locator('[data-ticket-accordion="troubleshooting"]')
            await guide.wait_for(timeout=30000)
            await guide.locator('summary').first.click()
            first = guide.locator('[data-pdf-html-page="1"]')
            await expect(first.locator('img')).to_be_visible(timeout=45000)
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
            third = guide.locator('[data-pdf-html-page="3"]')
            await third.scroll_into_view_if_needed()
            await expect(third.locator('img')).to_be_visible(timeout=30000)
            await first.scroll_into_view_if_needed()
            assert await first.locator('img').get_attribute('src') == first_url
            assert len(reads) == 1, reads
            await first.screenshot(path=str(OUT / f'work-order-html-{width}.png'))
            await guide.get_by_role('button', name='Zoom in', exact=True).click()
            await expect(first.locator('img')).to_be_visible()
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
            assert len(reads) == 1, 'Local preview must use the selected File, without uploading or reading a server source.'
            await local_first.screenshot(path=str(OUT / f'reader-html-{width}.png'))
            assert not errors, errors
            print(json.dumps({'width': width, 'work_order_and_reader': 'passed', 'source_reads_across_scroll': len(reads), 'original_diagrams_and_selectable_text': True}), flush=True)
            await context.close()
        await browser.close()


asyncio.run(main())
