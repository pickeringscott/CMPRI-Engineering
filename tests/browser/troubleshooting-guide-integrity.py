"""Local checklist preview: fictional records, persistent fixture ledger, no production access."""
import asyncio, copy, json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from cmpri_fixture import install, UID, WID, BASE, async_playwright, expect

OUT = Path(os.environ.get('CMPRI_GUIDE_OUTPUT', '/workspace/previews/troubleshooting'))
OUT.mkdir(parents=True, exist_ok=True)
PDF = BASE + '/guides/guest-room.pdf'
CHIEF = '00000000-0000-4000-8000-000000000021'
MANAGER = '00000000-0000-4000-8000-000000000031'
OTHER_TECH = '00000000-0000-4000-8000-000000000041'
RED = 'rgb(239, 68, 68)'
GREEN = 'rgb(52, 211, 153)'

KNOWLEDGE = {
 'manufacturer': 'Fixture Laundry', 'equipment': 'Demonstrator', 'model_family': 'Demonstrator',
 'source': {'verified': True, 'type': 'Verbatim uploaded PDF excerpts', 'title': 'Washer service manual.pdf', 'source_file_name': 'Washer service manual.pdf', 'file_url': PDF,
  'source_kind': 'asset-upload', 'storage_path': 'fixture/asset-files/Washer service manual.pdf', 'sha256': 'a' * 64,
  'registered_file_id': '00000000-0000-4000-8000-000000000011', 'registered_updated_at': '2026-11-08T12:00:00Z'},
 'symptom_rules': [
  {'match': ['not draining'], 'steps': ['Inspect the drain hose for a kink or blockage.', 'Check the drain pump connector against the wiring diagram.', 'Compare the recorded drain test result with the service manual.'], 'source_pages': [4], 'source_url': PDF},
  {'match': ['not filling'], 'steps': ['Inspect the water inlet hose and supply valve.', 'Check the inlet filter for an obstruction.', 'Compare the recorded fill test result with the service manual.'], 'source_pages': [7], 'source_url': PDF},
  {'match': ['leaking', 'water leak'], 'steps': ['Inspect the water inlet connection and hose for a leak.'], 'source_pages': [9], 'source_url': PDF},
 ],
 'source_passages': [{'kind': 'troubleshooting', 'page': 6, 'text': 'FICTIONAL DRAIN DIAGNOSTIC EXCERPT: inspect the drain hose for a blockage.', 'source_file_name': 'Washer service manual.pdf', 'source_url': PDF}],
 'general_checks': [],
 'error_codes': [
  {'code': 'F1', 'problem': 'Fictional drain fault', 'action': 'Follow the F1 drain diagnostic in the verified service manual.', 'source_pages': [5], 'source_url': PDF},
  {'code': 'F2', 'problem': 'Fictional fill fault', 'action': 'Follow the F2 inlet diagnostic in the attached service manual.', 'source_pages': [8], 'source_url': PDF},
 ],
}


def fixtures():
 order = {'id': WID, 'display_id': '4218', 'revision': 1, 'room': '204', 'location_id': 'loc-1', 'asset_id': '00000000-0000-4000-8000-000000000099', 'asset_name': 'Fictional Washer', 'issue': 'Washer not draining; fault code F1 displayed', 'reporter_notes': '', 'status': 'Open', 'priority': 'High', 'category': 'Laundry', 'technician_name': '', 'created_by': UID, 'creator_name': 'Fixture Reporter', 'notes': 'Drain problem reported; no troubleshooting checklist has been checked yet.', 'created_at': '2026-11-08T12:00:00Z'}
 asset = {'id': order['asset_id'], 'location_id': 'loc-1', 'active': True, 'name': 'Fictional Washer', 'manufacturer': 'Fixture Laundry', 'model_family': 'Demonstrator', 'model_number': 'TEST-1', 'asset_type': 'Washer', 'documentation_key': 'verified-v1', 'documentation_revision_id': None, 'documentation_verified_at': None}
 rows = [{'order': order, 'asset': asset, 'knowledge': copy.deepcopy(KNOWLEDGE)}]
 changed_issue = copy.deepcopy(rows[0]); changed_issue['order'].update(revision=2, issue='Washer not filling; fault code F2 displayed')
 rows.append(changed_issue)
 changed_equipment = copy.deepcopy(changed_issue); changed_equipment['asset'].update(id='00000000-0000-4000-8000-000000000098', name='Fictional Replacement Washer', documentation_key='verified-v2'); changed_equipment['order'].update(revision=3, asset_id=changed_equipment['asset']['id'], asset_name=changed_equipment['asset']['name'])
 rows.append(changed_equipment)
 changed_hash = copy.deepcopy(changed_equipment); changed_hash['knowledge']['source']['sha256'] = 'b' * 64
 rows.append(changed_hash)
 changed_file = copy.deepcopy(changed_hash)
 changed_file['knowledge']['source'].update(source_file_name='Washer service manual revision.pdf', title='Washer service manual revision.pdf', storage_path='fixture/asset-files/Washer service manual revision.pdf', registered_file_id='00000000-0000-4000-8000-000000000012', registered_updated_at='2026-11-08T13:00:00Z')
 changed_file['knowledge']['source_passages'][0]['source_file_name'] = 'Washer service manual revision.pdf'
 rows.append(changed_file)
 everyday_issue = copy.deepcopy(changed_file); everyday_issue['order'].update(revision=4, issue='Water all over the floor')
 rows.append(everyday_issue)
 # Use the real shared source selector so the synthetic API cannot accidentally
 # return a context/step shape that the real screen would correctly reject.
 code = """
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeManualKnowledge} from './src/lib/manual-knowledge.ts';
import {deriveTroubleshootingChecklistContext} from './src/lib/work-orders/troubleshooting-checklist.ts';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(input.rows.map(row=>{
 const context=deriveTroubleshootingChecklistContext({...row.order,asset:row.asset},normalizeManualKnowledge(row.knowledge));
 return {...row,...context,contextKey:context.contextIdentity?createHash('sha256').update(context.contextIdentity).digest('hex'):null};
})));
"""
 result = json.loads(subprocess.check_output(['node', '--import', './tests/helpers/resolve-ts.mjs', '--experimental-strip-types', '--input-type=module', '-e', code], input=json.dumps({'rows': rows}), text=True))
 assert all(row['contextIdentity'] and row['steps'] for row in result)
 assert len({row['contextKey'] for row in result}) == 6, 'Issue, equipment, uploaded PDF bytes and attachment identity must each bind a different checklist context'
 return result


async def main():
 variants = fixtures(); results = []
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
  for width in [384, 1440]:
   state = {'variant': 0, 'mode': 'verified', 'failNext': False, 'ticketRevision': 1, 'notes': variants[0]['order']['notes'], 'failExitFor': None, 'staleOnce': None}
   ledger = {}; visits = {}; exit_notes = []; exit_attempts = []; issue_writes = []; calls = []; writes = []; unexpected = []; external_hosts = []; forbidden_sources = []; mocked_realtime = []; pages = []

   async def open_role(role, actor_id, actor_name):
    ctx = await browser.new_context(viewport={'width': width, 'height': 1000}, timezone_id='America/Chicago', service_workers='block')
    await install(ctx, role, user_id=actor_id)
    async def websocket(ws):
     host = urlparse(ws.url).hostname
     if host in ['127.0.0.1', 'localhost']:
      ws.connect_to_server()
     elif host == 'ci-placeholder.supabase.co':
      # This is the dev server's deliberately fictional CMPRI realtime URL;
      # satisfy its transport locally rather than contact any remote service.
      mocked_realtime.append(host); await ws.close()
     else:
      external_hosts.append(host or 'unknown-websocket'); await ws.close()
    await ctx.route_web_socket('**/*', websocket)
    errors = []
    actor = {'id': actor_id, 'name': actor_name, 'role': 'chief' if role == 'chief_engineer' else 'technician' if role == 'technician' else 'manager'}
    can_edit = actor['role'] != 'manager'

    async def route(r):
     u = urlparse(r.request.url)
     if u.scheme in ('chrome', 'chrome-extension'):
      return await r.continue_()
     if u.hostname not in ['127.0.0.1', 'localhost']:
      external_hosts.append(u.hostname or 'unknown')
      return await r.abort()
     if not u.path.startswith('/api/'):
      return await r.fallback()
     calls.append({'role': role, 'path': u.path, 'method': r.request.method})
     if u.path in ['/api/assets/documentation', '/api/assistant', '/api/chat', '/api/room-operations/extract', '/api/room-operations/guest-reports/extract', '/api/maintenance-reference/search', '/api/catalog/search', '/api/source-search'] or u.path.startswith('/api/ai/') or parse_qs(u.query).get('source') == ['catalog']:
      forbidden_sources.append(u.path); return await r.abort()
     current = variants[state['variant']]
     async def respond(data, status=200):
      await r.fulfill(status=status, content_type='application/json', headers={'Cache-Control': 'no-store'}, body=json.dumps(data))
     if u.path == '/api/work-orders/' + WID + '/troubleshooting/exit':
      body = r.request.post_data_json
      assert set(body) == {'visitId'}, body
      visit_id = body['visitId']; visit = visits.get(visit_id)
      exit_attempts.append({'actorId': actor_id, 'visitId': visit_id})
      if visit and visit['actorId'] != actor_id: return await respond({'error': 'This visit belongs to another account.'}, 403)
      if state['failExitFor'] == actor_id: return await respond({'error': 'Fictional exit note failure. Changes remain pending.'}, 503)
      if visit is None:
       visit = {'actorId': actor_id, 'actorName': actor_name, 'events': [], 'mutationIds': set(), 'finalized': False}
       visits[visit_id] = visit
      already = visit['finalized']
      if not already:
       if visit['events']:
        documents = {}
        for event in visit['events']:
         documents.setdefault(event['sourcePath'], event['sourceFile'])
        grouped = {}
        for event in visit['events']:
         label = event['label'].rstrip(' .;\r\n\t')
         contexts = grouped.setdefault(label, {})
         contexts.setdefault(event['contextKey'], []).append(event['action'].lower())
        descriptions = [label + ' — ' + ' / '.join(' → '.join(actions) for actions in contexts.values()) for label, contexts in grouped.items()]
        sources = 'Source: ' + next(iter(documents.values())) if len(documents) == 1 else 'Sources: ' + '; '.join(documents.values())
        text = 'Troubleshooting: ' + '; '.join(descriptions) + '. ' + sources + '.'
        state['notes'] += '\nCMPRI2|2026-11-09T04:30:00Z|' + actor_name + '|' + role + '|note|' + text
        state['ticketRevision'] += 1
        exit_notes.append({'visitId': visit_id, 'actorId': actor_id, 'text': text, 'events': copy.deepcopy(visit['events'])})
       visit['finalized'] = True
      return await respond({'ok': True, 'finalized': True, 'alreadyFinalized': already, 'eventCount': len(visit['events']), 'workOrderRevision': state['ticketRevision'], 'notes': state['notes']})
     if u.path == '/api/work-orders/' + WID + '/troubleshooting':
      if r.request.method == 'GET' and state['staleOnce'] is not None:
       current = variants[state['staleOnce']]; state['staleOnce'] = None
      row = ledger.setdefault(current['contextKey'], {'revision': 0, 'taskStates': {}})
      if r.request.method == 'PATCH':
       body = r.request.post_data_json
       assert {'contextKey', 'expectedRevision', 'itemId', 'visitId', 'mutationId'} <= set(body) <= {'contextKey', 'expectedRevision', 'itemId', 'visitId', 'mutationId', 'action'}, body
       visit_id = body['visitId']; visit = visits.setdefault(visit_id, {'actorId': actor_id, 'actorName': actor_name, 'events': [], 'mutationIds': set(), 'finalized': False})
       if visit['actorId'] != actor_id: return await respond({'error': 'This visit belongs to another account.'}, 403)
       if visit['finalized']: return await respond({'error': 'This visit was already finalized.'}, 409)
       if body['mutationId'] in visit['mutationIds']:
        return await respond({'contextKey': current['contextKey'], 'contextIdentity': current['contextIdentity'], 'revision': row['revision'], 'actor': actor, 'canEdit': can_edit, 'canClearAll': actor['role'] in ('chief', 'technician') and can_edit, 'canClearOwn': True, 'canSeePendingReview': role == 'chief_engineer', 'steps': current['steps'], 'taskStates': row['taskStates'], 'pendingVisits': []})
       if body['contextKey'] != current['contextKey']: return await respond({'error': 'The issue or equipment changed.', 'code': 'context_changed'}, 409)
       if body['expectedRevision'] != row['revision']: return await respond({'error': 'The checklist changed. Reload it.', 'code': 'revision_changed'}, 409)
       if body['itemId'] not in [step['id'] for step in current['steps']]: return await respond({'error': 'Invalid step.'}, 400)
       if state['failNext']:
        state['failNext'] = False
        return await respond({'error': 'Fictional save failure. Nothing was saved.'}, 503)
       mark = copy.deepcopy(row['taskStates'].get(body['itemId'], {'status': 'empty'}))
       owner = mark.get('workerId') == actor_id
       clear = body.get('action') == 'clear' or (actor['role'] == 'chief' and mark.get('status') == 'approved') or (owner and actor['role'] != 'chief' and (mark.get('workerChecked') or mark.get('status') == 'approved'))
       if clear:
        if actor['role'] != 'chief' and not owner: return await respond({'error': 'Only the worker or Chief Engineer can clear this check.'}, 403)
        mark = {'status': 'empty'}; verb = 'Cleared'
       elif not can_edit:
        return await respond({'error': 'Checklist marks are read-only for this account.'}, 403)
       elif actor['role'] == 'technician':
        if mark.get('workerChecked') and mark.get('workerId') != actor_id: return await respond({'error': 'Another technician owns this completion.'}, 403)
        mark.update(workerChecked=not mark.get('workerChecked', False), workerId=actor_id, workerName=actor_name)
        mark['status'] = 'needs' if mark['workerChecked'] else 'empty'
        verb = 'Checked' if mark['workerChecked'] else 'Cleared'
       else:
        if mark.get('status') == 'needs':
         mark['status'] = 'approved'; mark['reviewedBy'] = actor_name; verb = 'Verified'
        else:
         mark = {'status': 'needs', 'workerId': actor_id, 'workerName': actor_name, 'workerChecked': True}; verb = 'Checked'
       row['taskStates'][body['itemId']] = mark
       row['revision'] += 1
       step = next(step for step in current['steps'] if step['id'] == body['itemId'])
       source = current['knowledge']['source']
       event = {'action': verb, 'contextKey': current['contextKey'], 'itemId': body['itemId'], 'label': step['label'], 'sourcePath': source['storage_path'], 'sourceFile': source['source_file_name'], 'sourcePages': step['sourcePages']}
       visit['events'].append(event); visit['mutationIds'].add(body['mutationId'])
       writes.append({'role': role, 'actorId': actor_id, 'visitId': visit_id, 'contextKey': current['contextKey'], 'revision': row['revision'], 'itemId': body['itemId'], 'state': copy.deepcopy(mark)})
      elif r.request.method != 'GET':
       unexpected.append(u.path)
       return await r.abort()
      pending = [{'visitId': visit_id, 'startedAt': '2026-11-09T04:00:00Z', 'lastEventAt': '2026-11-09T04:01:00Z', 'eventCount': len(visit['events'])} for visit_id, visit in visits.items() if visit['actorId'] == actor_id and not visit['finalized'] and visit['events']]
      return await respond({'contextKey': current['contextKey'], 'contextIdentity': current['contextIdentity'], 'revision': row['revision'], 'actor': actor, 'canEdit': can_edit, 'canClearAll': actor['role'] in ('chief', 'technician') and can_edit, 'canClearOwn': True, 'canSeePendingReview': role == 'chief_engineer', 'steps': current['steps'], 'taskStates': row['taskStates'], 'pendingVisits': pending})
     if u.path == '/api/work-orders/' + WID and r.request.method == 'PATCH':
      body = r.request.post_data_json
      assert set(body) == {'expected_revision', 'issue'}, body
      if body['expected_revision'] != state['ticketRevision']: return await respond({'error': 'The ticket changed.'}, 409)
      target = next(index for index in [1, 5] if body['issue'] == variants[index]['order']['issue'])
      state['variant'] = target; state['ticketRevision'] += 1; issue_writes.append(body)
      return await respond({'workOrder': {**variants[target]['order'], 'revision': state['ticketRevision'], 'notes': state['notes']}})
     if r.request.method not in ['GET', 'HEAD']:
      unexpected.append(u.path)
      return await r.abort()
     if u.path == '/api/work-orders/' + WID: return await respond({'workOrder': {**current['order'], 'revision': state['ticketRevision'], 'notes': state['notes']}})
     if u.path == '/api/maintenance-reference':
      if not parse_qs(u.query).get('assetId'): return await respond({'assets': [current['asset']], 'technicians': [{'id': UID, 'full_name': 'Alex Morgan', 'active': True}]})
      assert parse_qs(u.query).get('source') == ['asset-upload'], 'Work-order guide requested a catalog-capable source'
      if state['mode'] == 'unavailable': return await respond({'error': 'Fictional documentation unavailable'}, 503)
      if state['mode'] == 'revision': return await respond({'manualKnowledge': None, 'documentation_status': 'not_found', 'documentation_reason': 'No verified uploaded PDF is attached to this equipment.'})
      if state['mode'] == 'scanned': return await respond({'manualKnowledge': None, 'documentation_status': 'no_guidance', 'documentation_reason': 'The attached PDF has no extractable text. Upload a searchable manufacturer PDF before using troubleshooting instructions.'})
      return await respond({'documentation_status': 'verified', 'manualKnowledge': current['knowledge'], 'asset_id': current['asset']['id']})
     if u.path == '/api/assets/documentation': return await respond({'documents': [
      {'name': current['knowledge']['source']['source_file_name'], 'storage_path': current['knowledge']['source']['storage_path'], 'url': PDF, 'verified': state['mode'] == 'verified', 'source': 'uploaded'},
      {'name': 'Decoy catalog manual.pdf', 'storage_path': 'catalog/decoy.pdf', 'url': PDF, 'verified': True, 'source': 'catalog'},
     ]})
     if u.path == '/api/work-orders/' + WID + '/parts': return await respond({'items': [], 'parts': [], 'poLines': []})
     if u.path.endswith('/attachments'): return await respond({'images': []})
     return await r.fallback()

    await ctx.route('**/*', route)
    page = await ctx.new_page(); pages.append((ctx, page, errors))
    page.on('pageerror', lambda e: errors.append(str(e) + '\n' + str(e.stack)))
    await page.goto(BASE + '/work-orders/' + WID)
    guide = page.get_by_role('heading', name='Suggested Troubleshooting', exact=True).locator('xpath=../..')
    await guide.wait_for(timeout=60000)
    if await guide.get_attribute('open') is None: await guide.locator('summary').first.click()
    checklist = guide.get_by_role('region', name='Work-order troubleshooting checklist')
    if actor_id == OTHER_TECH:
     await expect(checklist.get_by_text('Another technician has checked steps. Continue their progress or start a new checklist?')).to_be_visible()
     await checklist.get_by_role('button', name='Continue', exact=True).click()
    await checklist.get_by_role('checkbox').first.wait_for(timeout=30000)
    return ctx, page, guide, checklist, errors

   async def reopen(page):
    await page.reload()
    guide = page.get_by_role('heading', name='Suggested Troubleshooting', exact=True).locator('xpath=../..')
    await guide.wait_for(timeout=30000)
    if await guide.get_attribute('open') is None: await guide.locator('summary').first.click()
    checklist = guide.get_by_role('region', name='Work-order troubleshooting checklist')
    await checklist.get_by_role('checkbox').first.wait_for(timeout=30000)
    return guide, checklist

   async def leave_and_confirm(page, actor_id, visit_id):
    await page.get_by_role('link', name='← Engineering Dashboard', exact=True).click()
    await expect(page).to_have_url(BASE + '/engineering', timeout=30000)
    assert visits[visit_id]['finalized']
    note = next(note for note in exit_notes if note['visitId'] == visit_id)
    assert note['actorId'] == actor_id
    assert len([entry for entry in exit_notes if entry['visitId'] == visit_id]) == 1
    response = await page.evaluate("async args => { const response=await fetch('/api/work-orders/'+args.id+'/troubleshooting/exit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitId:args.visitId})});return response.json(); }", {'id': WID, 'visitId': visit_id})
    assert response['alreadyFinalized'] is True
    assert len([entry for entry in exit_notes if entry['visitId'] == visit_id]) == 1
    return note

   async def return_to_ticket(page):
    await page.goto(BASE + '/work-orders/' + WID)
    guide = page.get_by_role('heading', name='Suggested Troubleshooting', exact=True).locator('xpath=../..')
    await guide.wait_for(timeout=30000)
    if await guide.get_attribute('open') is None: await guide.locator('summary').first.click()
    checklist = guide.get_by_role('region', name='Work-order troubleshooting checklist')
    await checklist.get_by_role('checkbox').first.wait_for(timeout=30000)
    return guide, checklist

   async def visual(control, status, color=None):
    await expect(control).to_have_attribute('data-preview-status', status)
    await expect(control).to_have_attribute('aria-checked', 'false' if status == 'empty' else 'true')
    if color:
     assert await control.locator('span').evaluate('e=>getComputedStyle(e).color') == color
    box = await control.locator('span').bounding_box()
    assert box['width'] <= 24 and box['height'] <= 24, box

   async def capture(page, guide, name):
    await guide.evaluate("""(panel, name) => {
     const frame = document.createElement('section');
     frame.setAttribute('data-guide-preview', name);
     frame.style.cssText = 'padding:12px;background:#0f172a;border:1px solid #334155;border-radius:16px;';
     const label = document.createElement('p');
     label.style.cssText = 'margin:0 0 10px;color:#cbd5e1;font:600 12px/1.4 sans-serif;letter-spacing:.02em;';
     label.textContent = 'SYNTHETIC PREVIEW · Fictional work order · No production changes';
     panel.parentNode.insertBefore(frame, panel);frame.appendChild(label);frame.appendChild(panel);
    }""", name)
    await guide.scroll_into_view_if_needed()
    frame = page.locator('[data-guide-preview="' + name + '"]')
    await frame.evaluate("""frame => {
     window.__guidePreviewVisibility = [];
     for (const element of document.querySelectorAll('body *')) {
      if (!frame.contains(element) && ['sticky','fixed'].includes(getComputedStyle(element).position)) {
       window.__guidePreviewVisibility.push([element, element.style.visibility]);element.style.visibility = 'hidden';
      }
     }
    }""")
    await page.screenshot(path=str(OUT / (name + '-page.png')), full_page=True)
    await frame.screenshot(path=str(OUT / (name + '-sources.png')))
    # Crop the rendered preview to its actual issue-specific checklist, leaving
    # the complete page and manual-reference view available as separate images.
    await frame.evaluate('e=>window.scrollTo(0,window.scrollY+e.getBoundingClientRect().top)')
    box = await frame.bounding_box()
    checklist_box = await guide.get_by_role('region', name='Work-order troubleshooting checklist').bounding_box()
    await page.screenshot(path=str(OUT / (name + '.png')), full_page=True, clip={'x': box['x'], 'y': box['y'] + await page.evaluate('window.scrollY'), 'width': box['width'], 'height': checklist_box['y'] + checklist_box['height'] - box['y'] + 12})
    await page.evaluate("for (const [element,visibility] of window.__guidePreviewVisibility || []) element.style.visibility=visibility;delete window.__guidePreviewVisibility;")

   async def capture_note(page, text, name):
    content = page.get_by_text(text, exact=True)
    await expect(content).to_have_count(1)
    row = content.locator('xpath=ancestor::div[contains(@class,"border-b")][1]')
    await row.evaluate("""row => {
     window.__notePreview = {history:row.parentElement,style:row.parentElement.getAttribute('style'),hidden:[]};
     row.parentElement.style.maxHeight='none';row.parentElement.style.overflow='visible';
     const label=document.createElement('p');label.setAttribute('data-note-preview','true');
     label.style.cssText='padding:10px;background:#0f172a;color:#cbd5e1;font:600 12px/1.4 sans-serif;';
     label.textContent='SYNTHETIC PREVIEW · One saved work-order note after leaving';row.before(label);
     for(const element of document.querySelectorAll('body *'))if(['sticky','fixed'].includes(getComputedStyle(element).position)){window.__notePreview.hidden.push([element,element.style.visibility]);element.style.visibility='hidden';}
    }""")
    label = page.locator('[data-note-preview]')
    await label.evaluate('e=>window.scrollTo(0,window.scrollY+e.getBoundingClientRect().top)')
    a = await label.bounding_box(); b = await row.bounding_box()
    await page.screenshot(path=str(OUT / name), full_page=True, clip={'x': a['x'], 'y': a['y'] + await page.evaluate('window.scrollY'), 'width': a['width'], 'height': b['y'] + b['height'] - a['y'] + 8})
    await page.evaluate("const p=window.__notePreview;if(p.style===null)p.history.removeAttribute('style');else p.history.setAttribute('style',p.style);for(const [element,visibility] of p.hidden)element.style.visibility=visibility;document.querySelector('[data-note-preview]').remove();delete window.__notePreview;")

   tech_ctx, tech, guide, checklist, tech_errors = await open_role('technician', UID, 'Alex Morgan')
   controls = checklist.get_by_role('checkbox')
   assert await controls.count() == len(variants[0]['steps']) >= 3
   await expect(checklist.get_by_text('Washer service manual.pdf', exact=False).first).to_be_visible()
   await expect(guide.get_by_text('Decoy catalog manual.pdf', exact=True)).to_have_count(0)
   for control in await controls.all(): await visual(control, 'empty')
   await expect(guide.get_by_role('button', name='Copy', exact=True)).to_have_count(0)
   await expect(guide.get_by_role('button', name='Copy code', exact=True)).to_have_count(0)
   await expect(guide.get_by_role('button', name='Clear check', exact=True)).to_have_count(0)
   await expect(checklist.get_by_text('Source: Washer service manual.pdf', exact=True)).to_have_count(1)
   await expect(guide.locator('a[href="' + PDF + '"]')).to_have_count(1)
   await expect(guide.locator('a[href*="#page="]')).to_have_count(0)
   for row in await checklist.locator('li').all():
    await expect(row.get_by_role('checkbox')).to_have_count(1)
    await expect(row.locator('button')).to_have_count(1)
    await expect(row.locator('a')).to_have_count(0)
    await expect(row.get_by_text('Source: Washer service manual.pdf', exact=True)).to_have_count(0)
    assert 'Clear check' not in (await row.get_by_role('checkbox').get_attribute('title') or '')
   note = tech.locator('#technician-note-editor')
   unsaved_note = 'Fictional unsaved finding: drain hose inspected; pump test still pending.'
   for index in [0, 1]:
    if index == 1: await note.fill(unsaved_note)
    await controls.nth(index).click()
    await visual(controls.nth(index), 'approved', GREEN)
    await expect(controls.nth(index)).to_have_attribute('data-task-status', 'needs')
   async with tech.expect_response(lambda response: urlparse(response.url).path == '/api/work-orders/' + WID) as refreshed:
    await tech.evaluate("async () => { await window.__cmpriDeviceData.invalidate(['orders']); }")
   await (await refreshed.value).json()
   await tech.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
   await expect(note).to_have_value(unsaved_note)
   await note.fill('')
   initial_tech_visit = writes[-1]['visitId']
   assert not any(entry['visitId'] == initial_tech_visit for entry in exit_notes), 'Checklist taps must not append individual work-order notes'
   await guide.locator('summary').first.click()
   for _ in range(100):
    if any(entry['visitId'] == initial_tech_visit for entry in exit_notes): break
    await tech.wait_for_timeout(100)
   assert visits[initial_tech_visit]['finalized'], 'Closing the troubleshooting accordion must save its checklist summary'
   assert len([entry for entry in exit_notes if entry['visitId'] == initial_tech_visit]) == 1
   await guide.locator('summary').first.click()
   await checklist.get_by_role('checkbox').first.wait_for(timeout=30000)
   await expect(checklist.get_by_role('link', name='Washer service manual.pdf', exact=True)).to_have_attribute('href', PDF)
   assert await tech.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'The checklist must fit without horizontal overflow'
   await capture(tech, guide, 'final-guide-tech-' + ('phone' if width == 384 else 'desktop'))
   guide, checklist = await reopen(tech)
   for index in [0, 1]: await visual(checklist.get_by_role('checkbox').nth(index), 'approved', GREEN)
   # A new editor session must be able to clear its worker's durable completion.
   await checklist.get_by_role('checkbox').first.click()
   await visual(checklist.get_by_role('checkbox').first, 'empty')
   assert writes[-1]['state'] == {'status': 'empty'}
   await checklist.get_by_role('checkbox').first.click()
   await visual(checklist.get_by_role('checkbox').first, 'approved', GREEN)
   own_clear_visit = writes[-1]['visitId']
   assert not any(entry['visitId'] == own_clear_visit for entry in exit_notes)
   own_note = await leave_and_confirm(tech, UID, own_clear_visit)
   assert [event['action'] for event in own_note['events']] == ['Cleared', 'Checked']
   other_ctx, other, other_guide, other_list, other_errors = await open_role('technician', OTHER_TECH, 'Riley Chen')
   for index in [0, 1]: await expect(other_list.get_by_role('checkbox').nth(index)).to_be_enabled()
   await expect(other_list.get_by_role('checkbox').nth(2)).to_be_enabled()
   await other_ctx.close()

   chief_ctx, chief, chief_guide, chief_list, chief_errors = await open_role('chief_engineer', CHIEF, 'Jordan Lee')
   chief_controls = chief_list.get_by_role('checkbox')
   for index in [0, 1]: await visual(chief_controls.nth(index), 'needs', RED)
   await chief_controls.first.click()
   await visual(chief_controls.first, 'approved', GREEN)
   await visual(chief_controls.nth(1), 'needs', RED)
   await expect(chief_list.get_by_text('Approved · Completed by Alex Morgan · Reviewed by Jordan Lee', exact=True)).to_be_visible()
   await capture(chief, chief_guide, 'final-guide-chief-' + ('phone' if width == 384 else 'desktop'))
   manager_ctx, manager, manager_guide, manager_list, manager_errors = await open_role('manager', MANAGER, 'Morgan Taylor')
   for control in await manager_list.get_by_role('checkbox').all():
    await expect(control).to_be_disabled()
    assert await control.get_attribute('data-preview-status') != 'needs', 'Only the Chief Engineer may see red review marks'
   for index in [0, 1]: await visual(manager_list.get_by_role('checkbox').nth(index), 'approved', GREEN)
   await manager_ctx.close()
   chief_visit = writes[-1]['visitId']
   assert not any(entry['visitId'] == chief_visit for entry in exit_notes)
   # Chief controls are a single blank -> red -> green -> blank cycle. There
   # are no separate clear actions in the interface.
   await chief_list.get_by_role('checkbox').first.click()
   await visual(chief_list.get_by_role('checkbox').first, 'empty')
   assert writes[-1]['state'] == {'status': 'empty'}
   await chief_list.get_by_role('checkbox').nth(1).click()
   await visual(chief_list.get_by_role('checkbox').nth(1), 'approved', GREEN)
   await chief_list.get_by_role('checkbox').nth(1).click()
   await visual(chief_list.get_by_role('checkbox').nth(1), 'empty')
   await chief_list.get_by_role('checkbox').nth(2).click()
   await visual(chief_list.get_by_role('checkbox').nth(2), 'needs', RED)
   await chief_list.get_by_role('checkbox').nth(2).click()
   await visual(chief_list.get_by_role('checkbox').nth(2), 'approved', GREEN)
   await chief_list.get_by_role('checkbox').nth(2).click()
   await visual(chief_list.get_by_role('checkbox').nth(2), 'empty')
   assert len(visits[chief_visit]['events']) == 7
   assert not any(entry['visitId'] == chief_visit for entry in exit_notes)

   state['failExitFor'] = CHIEF
   await chief.get_by_role('link', name='← Engineering Dashboard', exact=True).click()
   await expect(chief.get_by_role('alert').filter(has_text='Fictional exit note failure')).to_be_visible(timeout=30000)
   assert urlparse(chief.url).path == '/work-orders/' + WID
   assert not visits[chief_visit]['finalized']
   assert not any(entry['visitId'] == chief_visit for entry in exit_notes)
   chief_guide, chief_list = await reopen(chief)
   # Passive loading must never finalize an earlier editing visit. The user
   # explicitly selects its existing recovery action after reopening.
   assert not visits[chief_visit]['finalized']
   attempts_after_load = len([attempt for attempt in exit_attempts if attempt['visitId'] == chief_visit])
   await chief.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
   assert len([attempt for attempt in exit_attempts if attempt['visitId'] == chief_visit]) == attempts_after_load
   state['failExitFor'] = None
   await chief_list.get_by_role('button', name='Recover earlier summary', exact=True).click()
   await expect(chief_list.get_by_role('button', name='Recover earlier summary', exact=True)).to_have_count(0, timeout=30000)
   await chief.get_by_role('link', name='← Engineering Dashboard', exact=True).click()
   await expect(chief).to_have_url(BASE + '/engineering', timeout=30000)
   assert visits[chief_visit]['finalized']
   combined = next(entry for entry in exit_notes if entry['visitId'] == chief_visit)
   assert len(combined['events']) == 7
   assert {'Checked', 'Verified', 'Cleared'} <= {event['action'] for event in combined['events']}
   assert combined['text'].startswith('Troubleshooting: ')
   assert combined['text'].count('Washer service manual.pdf') == 1
   assert '2026-' not in combined['text'] and 'Jordan Lee' not in combined['text'], 'Time and actor belong only in the note closure header'
   for index in [0, 1, 2]: assert combined['text'].count(variants[0]['steps'][index]['label'].rstrip(' .;\r\n\t')) == 1
   assert 'checked → verified → cleared' in combined['text']
   assert len([entry for entry in exit_notes if entry['visitId'] == chief_visit]) == 1
   chief_guide, chief_list = await return_to_ticket(chief)
   for control in await chief_list.get_by_role('checkbox').all(): await visual(control, 'empty')
   if width == 1440: await capture_note(chief, combined['text'], 'final-exit-note.png')

   # Fail without committing; no optimistic completion may survive a reload.
   state['failNext'] = True
   blank = chief_list.get_by_role('checkbox').nth(2)
   await blank.click()
   await expect(chief_list.get_by_role('alert')).to_contain_text('Nothing was saved.')
   await visual(blank, 'empty')
   chief_guide, chief_list = await reopen(chief)
   await visual(chief_list.get_by_role('checkbox').nth(2), 'empty')

   await chief.locator('[data-reported-issue] > summary').click()

   # Same ticket, newly saved issue or equipment: previous marks remain in their
   # old ledger context and must not appear on the current checklist.
   for index in [1, 2, 3, 4]:
    if index == 1 and width == 1440:
     # Exercise the real issue editor. Blurring the field saves
     # the issue; simply typing must only change the read-only guide preview.
     await chief_list.get_by_role('checkbox').first.click()
     await visual(chief_list.get_by_role('checkbox').first, 'needs', RED)
     before_checklist_writes = len(writes)
     await chief.get_by_role('button', name='Edit reported issue', exact=True).click()
     await chief.get_by_role('textbox', name='Reported Issue', exact=True).fill(variants[1]['order']['issue'])
     for step in variants[1]['steps']: await expect(chief_list.get_by_text(step['label'], exact=False).first).to_be_visible()
     for step in variants[0]['steps']: await expect(chief_list.get_by_text(step['label'], exact=False)).to_have_count(0)
     for control in await chief_list.get_by_role('checkbox').all(): await expect(control).to_be_disabled()
     assert len(writes) == before_checklist_writes
     assert len(issue_writes) == 0
     await capture(chief, chief_guide, 'final-issue-edit-readonly')
     await chief.get_by_role('textbox', name='Reported Issue', exact=True).blur()
     await expect(chief.get_by_role('button', name='Edit reported issue', exact=True)).to_contain_text(variants[1]['order']['issue'])
     await expect(chief_list.get_by_role('checkbox').first).to_be_enabled(timeout=30000)
     assert len(issue_writes) == 1
     # A late response for the previous issue cannot bring its rows or marks back.
     state['staleOnce'] = 0
     await chief.evaluate("async () => { await window.__cmpriDeviceData.invalidate(['orders']); }")
     await expect(chief_list.get_by_role('alert')).to_contain_text('changed', timeout=30000)
     for step in variants[0]['steps']: await expect(chief_list.get_by_text(step['label'], exact=False)).to_have_count(0)
     await chief_list.get_by_role('button', name='Reload checklist', exact=True).click()
     await expect(chief_list.get_by_role('checkbox').first).to_be_enabled(timeout=30000)
    else:
     state['variant'] = index
     if index in [1, 2]: state['ticketRevision'] += 1
     await chief.evaluate("async () => { await window.__cmpriDeviceData.invalidate(['orders','reference']); }")
    await expect(chief.get_by_role('button', name='Edit reported issue', exact=True)).to_contain_text(variants[index]['order']['issue'])
    await expect(chief_list.get_by_role('checkbox').first).to_have_attribute('data-preview-status', 'empty', timeout=30000)
    for control in await chief_list.get_by_role('checkbox').all(): await visual(control, 'empty')
    if index < 4:
     await chief_list.get_by_role('checkbox').first.click()
     await visual(chief_list.get_by_role('checkbox').first, 'needs', RED)

   if width == 1440:
    before_everyday = len(writes)
    await chief.get_by_role('button', name='Edit reported issue', exact=True).click()
    await chief.get_by_role('textbox', name='Reported Issue', exact=True).fill(variants[5]['order']['issue'])
    await expect(chief_list.get_by_text(variants[5]['steps'][0]['label'], exact=True)).to_be_visible()
    for step in variants[1]['steps']: await expect(chief_list.get_by_text(step['label'], exact=False)).to_have_count(0)
    for control in await chief_list.get_by_role('checkbox').all(): await expect(control).to_be_disabled()
    assert len(writes) == before_everyday
    await capture(chief, chief_guide, 'final-everyday-issue-readonly')
    await chief.get_by_role('textbox', name='Reported Issue', exact=True).blur()
    await expect(chief.get_by_role('button', name='Edit reported issue', exact=True)).to_have_text(variants[5]['order']['issue'])
    await expect(chief_list.get_by_role('checkbox').first).to_be_enabled(timeout=30000)
    for control in await chief_list.get_by_role('checkbox').all(): await visual(control, 'empty')
    assert len(issue_writes) == 2

   # Documentation becomes unavailable: hide the old checklist and explain why.
   for mode, warning in [('revision', 'No verified uploaded PDF is attached'), ('scanned', 'The attached PDF has no extractable text'), ('unavailable', 'uploaded document could not be checked')]:
    state['mode'] = mode
    await chief.evaluate("async () => { await window.__cmpriDeviceData.invalidate(['reference']); }")
    await expect(chief_guide.get_by_text(warning, exact=False)).to_be_visible(timeout=30000)
    await expect(chief_guide.get_by_role('region', name='Work-order troubleshooting checklist')).to_have_count(0)
   for ctx, page, errors in pages:
    assert not errors, errors
   assert not unexpected, unexpected
   assert not external_hosts, 'Unexpected external service/provider attempts: ' + repr(external_hosts)
   assert not forbidden_sources, 'Unexpected catalog/source-search/AI endpoints: ' + repr(forbidden_sources)
   pending_source_visit = writes[-1]['visitId']
   assert not any(entry['visitId'] == pending_source_visit for entry in exit_notes)
   source_note = await leave_and_confirm(chief, CHIEF, pending_source_visit)
   assert len(source_note['events']) == 3 + int(width == 1440)
   assert len(writes) == 14 + int(width == 1440), writes
   assert all(unsaved_note not in entry['text'] for entry in exit_notes)
   results.append({'width': width, 'technicianCheckboxBlankGreenToggle': True, 'chiefCheckboxBlankRedGreenBlankCycle': True, 'onlyChiefSeesRed': True, 'onePrimaryCheckboxPerStep': True, 'noPerStepSourceLinksOrControls': True, 'noCopyOrSeparateClearButtons': True, 'sourceFilenameShownOnce': True, 'singleTopPdfLinkOnly': True, 'durableReloadAcrossRoles': True, 'ownClearAfterReopen': True, 'chiefClearRemovesWholeCompletion': True, 'oneCombinedNoteOnExitIncludingClearedActions': True, 'compactExitNoteEachStepOnce': True, 'compactExitNoteWithOneSource': True, 'passiveLoadDoesNotFinalizeEarlierVisit': True, 'explicitEarlierVisitRecovery': True, 'exitFailureRecoveryAndIdempotency': True, 'unsavedNoteSurvivesChecklistSaveAndRefresh': True, 'managerReadOnly': True, 'otherTechnicianOwnership': True, 'failedSaveNotCommitted': True, 'issueEquipmentAndUploadedFileHashClearOldContext': True, 'typedIssueImmediatelyChangesReadOnlyGuide': True if width == 1440 else None, 'plainLanguageIssueFindsUploadedDocumentSteps': True if width == 1440 else None, 'lateOldIssueDataRejected': True if width == 1440 else None, 'strictUploadedSourceQuery': True, 'catalogSourceExcluded': True, 'externalProviderAttempts': len(external_hosts), 'catalogSearchOrAiEndpointRequests': len(forbidden_sources), 'cmpriRealtimeMockedLocally': bool(mocked_realtime), 'scannedPdfFailsClearly': True, 'documentationFailureClearsChecklist': True, 'fixtureWrites': len(writes), 'productionWrites': 0, 'pageErrors': 0})
   print(json.dumps(results[-1]), flush=True)
   await tech_ctx.close(); await chief_ctx.close()
  await browser.close()
 OUT.joinpath('results.json').write_text(json.dumps(results, indent=2))

if __name__ == '__main__':
 asyncio.run(main())
