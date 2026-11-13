"""Guide loading/recovery with fictional equipment; every API response is local."""
import asyncio
import json
import subprocess
from urllib.parse import parse_qs, urlparse
from cmpri_fixture import BASE, UID, WID, install, async_playwright, expect


def fixtures():
    cases = [
        ('Washer', 'Washer drain is not working', 'No Drain'),
        ('Television', 'Television power is not working', 'No Power'),
        ('Room HVAC', 'Heat not working says its running but never got warm', 'No heat'),
        ('Water heater', 'Heater has exhaust errors', 'Exhaust error'),
        ('Parts-only equipment', 'Exhaust errors', None),
    ]
    rows = []
    for index, (name, issue, heading) in enumerate(cases):
        asset = {'id': f'00000000-0000-4000-8000-{index + 20:012d}', 'name': name,
                 'location_id': 'loc-1', 'active': True, 'manufacturer': 'Fixture Maker',
                 'asset_type': name, 'model_number': 'TEST-1'}
        order = {'id': WID, 'display_id': 'fixture-1', 'revision': 1, 'room': '204',
                 'location_id': 'loc-1', 'asset_id': asset['id'], 'asset_name': name,
                 'issue': issue, 'status': 'Open', 'priority': 'High', 'category': 'Other',
                 'created_by': UID, 'technician_name': '', 'notes': '',
                 'created_at': '2026-11-12T12:00:00Z'}
        file_name = 'Fixture service manual.pdf' if heading else 'Fixture parts list.pdf'
        knowledge = {'source': {'verified': True, 'source_kind': 'asset-upload',
                               'source_file_name': file_name, 'file_url': BASE + '/guides/guest-room.pdf',
                               'storage_path': 'fixture/manual.pdf', 'sha256': 'a' * 64,
                               'registered_file_id': '00000000-0000-4000-8000-000000000099'},
                     'symptom_rules': [{'match': [heading], 'steps': ['Check the fixture connection.'],
                                        'source_pages': [2]}] if heading else [],
                     'source_passages': [], 'error_codes': []}
        rows.append({'asset': asset, 'order': order, 'knowledge': knowledge, 'has_steps': bool(heading)})
    code = """
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeManualKnowledge} from './src/lib/manual-knowledge.ts';
import {deriveTroubleshootingChecklistContext} from './src/lib/work-orders/troubleshooting-checklist.ts';
console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(row=>{
  const context=deriveTroubleshootingChecklistContext({...row.order,asset:row.asset},normalizeManualKnowledge(row.knowledge));
  return {...row,...context,contextKey:createHash('sha256').update(context.contextIdentity).digest('hex')};
})));
"""
    return json.loads(subprocess.check_output(
        ['node', '--import', './tests/helpers/resolve-ts.mjs', '--experimental-strip-types',
         '--input-type=module', '-e', code], input=json.dumps(rows), text=True))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for width in [384, 1440]:
            for row in fixtures():
                context = await browser.new_context(viewport={'width': width, 'height': 1000}, service_workers='block')
                await install(context, 'technician')
                gate = asyncio.Event()
                state = {'failed': True, 'guide_reads': 0}
                errors = []

                async def route(request):
                    url = urlparse(request.request.url)
                    async def reply(data, status=200):
                        await request.fulfill(status=status, content_type='application/json', body=json.dumps(data))
                    if url.path == '/api/work-orders/' + WID:
                        return await reply({'workOrder': row['order']})
                    if url.path == '/api/maintenance-reference':
                        if not parse_qs(url.query).get('assetId'):
                            return await reply({'assets': [row['asset']], 'technicians': []})
                        assert parse_qs(url.query).get('source') == ['asset-upload']
                        state['guide_reads'] += 1
                        await gate.wait()
                        if state['failed']:
                            return await reply({'error': 'The attachment register is temporarily unavailable.'}, 503)
                        return await reply({'assets': [row['asset']], 'manualKnowledge': row['knowledge'],
                                            'documentation_status': 'verified' if row['has_steps'] else 'no_guidance',
                                            'documentation_reason': 'Fixture parts list.pdf is attached, but no troubleshooting section or explicit actions were found. Select a service or troubleshooting manual in Assets to provide procedures.'})
                    if url.path == '/api/work-orders/' + WID + '/troubleshooting':
                        return await reply({**{key: row[key] for key in ['contextKey', 'contextIdentity', 'steps']},
                                            'revision': 0, 'actor': {'id': UID, 'name': 'Fixture Technician', 'role': 'technician'},
                                            'canEdit': True, 'canClearAll': False, 'canClearOwn': True,
                                            'canSeePendingReview': False, 'taskStates': {}, 'pendingVisits': []})
                    if url.path.endswith('/parts'):
                        return await reply({'items': [], 'parts': [], 'poLines': []})
                    return await request.fallback()

                await context.route('**/*', route)
                page = await context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(BASE + '/work-orders/' + WID)
                guide = page.locator('[data-ticket-accordion="troubleshooting"]')
                await guide.wait_for(timeout=30000)
                await guide.locator('summary').click()
                await expect(guide.get_by_text('Loading the equipment’s uploaded guide…', exact=True)).to_be_visible()
                gate.set()
                await expect(guide.get_by_text('The attachment register is temporarily unavailable.', exact=True)).to_be_visible()
                state['failed'] = False
                await guide.get_by_role('button', name='Reload guide', exact=True).click()
                await expect(guide.get_by_role('checkbox')).to_have_count(1 if row['has_steps'] else 0)
                if row['has_steps']:
                    await expect(guide.get_by_role('checkbox')).to_be_enabled()
                else:
                    await expect(guide.get_by_text('Fixture parts list.pdf is attached', exact=False)).to_be_visible()
                await expect(guide.get_by_text('The attachment register is temporarily unavailable.', exact=True)).to_have_count(0)
                assert state['guide_reads'] >= 2
                assert not errors, errors
                print(json.dumps({'equipment': row['asset']['name'], 'width': width,
                                  'loading_error_retry': 'passed', 'steps': len(row['steps'])}), flush=True)
                await context.close()
        await browser.close()


asyncio.run(main())
