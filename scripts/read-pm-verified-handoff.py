"""Compile exact-cell source evidence locally; no database or network operations."""
import datetime as dt
import hashlib
import json
import pathlib
import re
import sys
from collections import Counter

root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
workbook = json.loads((root / 'corporate_pm_full_cell_export.json').read_text(encoding='utf-8'))
documents = json.loads((root / 'six_source_documents.json').read_text(encoding='utf-8'))
xlsx = root / 'Preventative Maintenance Tracking - CMPRI.xlsx'
digest = hashlib.sha256(xlsx.read_bytes()).hexdigest()
assert digest == '7e042647b7530db2b88f34f432d5b7c3965fd6f3a191acc1ae2a548a91831481'
assert len(workbook['sheets']) == 17
assert sum(len(s['cells']) for s in workbook['sheets']) == 9086
assert len(documents) == 6 and all(d.get('content') for d in documents)
catalog = json.loads((pathlib.Path(__file__).resolve().parents[1] / 'src/lib/pm/source-catalog.json').read_text(encoding='utf-8'))
normalize = lambda s: re.sub(r'\s+', ' ', str(s)).strip().casefold()
daily = {normalize(t['label']): t['id'] for t in catalog['daily']}
weekly = {normalize(t['label']): t['id'] for t in catalog['weekly']}
facts, unresolved, room_history, planning_cells, program_templates = [], [], [], [], []
for sheet in workbook['sheets']:
    name = sheet['name']
    cells = {(c['row'], c['column']): c for c in sheet['cells']}
    if name.isdigit():
        for cell in sheet['cells']:
            row, col, value = cell['row'], cell['column'], cell['value']
            source = {'library_id': workbook['source_library_id'], 'sheet': name, 'cell': cell['coordinate'], 'xlsx_sha256': digest}
            room = cells.get((row, 1), {}).get('value')
            if row >= 10 and col in range(2, 6) and str(room).replace('.0', '') in catalog['roomNumbers']:
                if value in ('', None): continue
                record = {'room': str(room).replace('.0', ''), 'year': int(name), 'quarter': col - 1, 'raw_value': value, 'source': source}
                try:
                    date = dt.date.fromisoformat(str(value)[:10])
                    if date.year != int(name) or (date.month - 1)//3 + 1 != col - 1: raise ValueError('Year or quarter mismatch')
                    room_history.append({**record, 'completed_date': date.isoformat(), 'completion_evidence': 'dated-source'})
                except ValueError:
                    if normalize(value) == 'marked comp':
                        room_history.append({**record, 'completed_date': None, 'completion_evidence': 'source-marked-complete-date-unrecorded'})
                    else: unresolved.append({**record, 'reason': 'Malformed or mismatched historical date; do not guess'})
            elif col >= 7:
                planning_cells.append({'source': source, 'value': value, 'cached_value': cell.get('cached_value'), 'data_type': cell.get('data_type')})
        if name == '2024':
            items = []
            for header_col, label_col, check_col in [(7,8,9),(11,12,13)]:
                for header_row in [11,16,21,26,31,36]:
                    week = cells[(header_row, header_col)]['value']
                    period_label = cells[(header_row, label_col)]['value']
                    for row in range(header_row+1,header_row+4):
                        label_cell = cells[(row,label_col)]
                        label = label_cell.get('cached_value')
                        if not label or normalize(label) == 'n/a': continue
                        checked = cells[(row,check_col)]
                        item_id = 'area-'+checked['coordinate'].lower()
                        items.append({'id': item_id, 'label': str(label), 'category': f'{week} {period_label}', 'source': f"{name}!{label_cell['coordinate']}"})
                        facts.append({'kind':'area-planning-task','template_id':'workbook:area-plan:2024','period_start':'2024-01-01','period_precision':'source-year-and-labelled-week','scope_key':'property','item_id':item_id,'checked':checked['value'], 'source':{'library_id':workbook['source_library_id'],'sheet':name,'cell':checked['coordinate'],'xlsx_sha256':digest}})
            program_templates.append({'id':'workbook:area-plan:2024','title':'2024 corporate area plan','cadence':'monthly','months':[1],'sourceYear':2024,'scope':'property','kind':'routine','sourceFile':catalog['workbook'],'sourceReference':'2024!G11:M39','instructions':'Preserves the recorded week ranges and cached area names from the supplied workbook. January 1 identifies the annual source grid, not an inspection date. Blank/false checks are not proof of a failed inspection.','checklist':items,'fields':[{'id':'notes','label':'Planning notes / revisit items','type':'textarea'}]})
        if name == '2023':
            items = [{'id':f'week-{week}','label':f'Week {week} binder maintenance compliance','category':'Source-year weekly compliance','source':f'2023!J{week+13}'} for week in range(1,53)]
            program_templates.append({'id':'workbook:compliance:2023','title':'2023 weekly binder compliance','cadence':'monthly','months':[1],'sourceYear':2023,'scope':'property','kind':'routine','sourceFile':catalog['workbook'],'sourceReference':'2023!I14:J65','instructions':'The supplied grid has week labels but no recorded weekly compliance answers. No checks are inferred from room dates or cached TODAY formulas. January 1 is a year anchor only.','checklist':items,'fields':[{'id':'notes','label':'Compliance findings / revisit plan','type':'textarea'}]})
        continue
    month = next(m for m in catalog['months'] if m['month'] == name)
    tasks = {normalize(t['label']): t['id'] for t in month['tasks']}
    for cell in sheet['cells']:
        value = cell['value']
        if not isinstance(value, bool):
            continue
        row, col = cell['row'], cell['column']
        label = normalize(cells.get((row, 1), {}).get('value', ''))
        source = {'library_id': workbook['source_library_id'], 'sheet': name,
                  'cell': cell['coordinate'], 'xlsx_sha256': digest}
        if col == 1:
            task_label = normalize(cells.get((row, 3), {}).get('value', ''))
            if task_label in tasks:
                facts.append({'kind': 'monthly-task', 'item_id': tasks[task_label],
                              'checked': value, 'source': source})
            else:
                unresolved.append({'source': source, 'value': value, 'reason': 'Unmapped monthly task label', 'label': task_label})
        elif label in daily:
            raw_date = cells.get((5, col), {}).get('value')
            try:
                date = dt.date.fromisoformat(str(raw_date)[:10])
                if date.year != 2026:
                    raise ValueError('Header year differs from approved program year')
            except ValueError:
                if value:
                    unresolved.append({'source': source, 'value': value, 'raw_date': raw_date,
                                       'reason': 'Checked cell has invalid or different-year date header'})
                continue
            facts.append({'kind': 'daily-rollup' if daily[label] == 'daily-21' else 'daily-task',
                          'item_id': daily[label], 'date': date.isoformat(), 'checked': value, 'source': source})
        elif label in weekly or label == 'weekly checklist completion':
            slot = str(cells.get((23, col), {}).get('value', '')).strip().upper()
            if not re.fullmatch(r'WK[1-5]', slot):
                if value: unresolved.append({'source': source, 'reason': 'No explicit weekly slot heading', 'value': value})
                continue
            facts.append({'kind': 'weekly-rollup' if label == 'weekly checklist completion' else 'weekly-task',
                          'item_id': f"{slot.lower()}:{weekly.get(label, 'rollup')}", 'checked': value, 'source': source,
                          'template_id': 'workbook:weekly-slots',
                          'period_start': f"2026-{catalog['months'].index(month)+1:02d}-01",
                          'scope_key': 'property', 'week_slot': slot, 'period_precision': 'month-and-source-week-slot'})

for fact in facts:
    if fact['kind'].startswith('monthly'):
        month_index = next(i for i,m in enumerate(catalog['months'], 1) if m['month'] == fact['source']['sheet'])
        fact.update(template_id='workbook:monthly:'+fact['source']['sheet'].lower(), period_start=f'2026-{month_index:02d}-01', scope_key='property')
    elif fact['kind'].startswith('daily'):
        fact.update(template_id='workbook:daily', period_start=fact['date'], scope_key='property')

result = {'status': 'source-evidence-only-not-an-import', 'xlsx_sha256': digest,
          'source_library_id': workbook['source_library_id'], 'sheets': len(workbook['sheets']),
          'meaningful_cells': 9086, 'source_documents': [{'title': d['title'], 'id': d['id'],
          'url': d.get('url'), 'text_sha256': hashlib.sha256(d['content'].encode()).hexdigest()} for d in documents],
          'facts': facts, 'room_history': room_history, 'planning_cells': planning_cells, 'unresolved': unresolved,
          'limits': ['No inspection condition inferred from master checkbox.',
                     'False source cells are not authorization to reset user responses.',
                     'Historical and planning cells remain in the complete native export; not silently discarded.',
                     'Weekly periods retain explicit month/WK headings; month anchors are not inspection dates.',
                     'Planning cells are preserved pending semantic control integration.']}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(pathlib.Path(__file__).resolve().parents[1] / 'src/lib/pm/program-history-templates.json').write_text(json.dumps(program_templates,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'verified_tabs': 17, 'verified_cells': 9086, 'verified_documents': 6,
                  'true_counts': dict(Counter(f['kind'] for f in facts if f['checked'])),
                  'unresolved_checked_or_unmapped_cells': len(unresolved)}))
