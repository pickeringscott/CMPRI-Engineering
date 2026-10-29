"""Prepare actual PM proposal-table records and a conflict-safe SQL transaction.
Local files only. Running this compiler never executes SQL or contacts production.
"""
import json,pathlib,sys,uuid,re
root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);out.mkdir(exist_ok=True)
stored=json.loads((root/'release-inputs/pm-stored-nonroom-source.json').read_text(encoding='utf-8'))[0]
pages={p['page']:p for p in stored['pages']}
manifest=json.loads(pathlib.Path('src/lib/server/pm-recorded-forms.json').read_text(encoding='utf-8'))
forms={p['page']:p['forms'] for p in manifest['pages']}
source_id=stored['source_id'];hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6'
records={};used=set()
def entry(page,period,scope):
 p=pages[page];key=(p['templateId'],period,scope);used.add(page)
 if key not in records:
  records[key]={'id':str(uuid.uuid5(uuid.NAMESPACE_URL,'cmpri:pm-binder-v2:'+hotel+':'+':'.join(key))),'template_id':key[0],'period_start':period,'scope_key':scope,'payload':{'responses':{},'form_data':{},'notes':'','deficiency_notes':'','completed_on':None,'is_complete':False,'completed_by_name':None,'work_order_id':None,'historical_source_import':{'version':2,'source_id':source_id,'pages':[]}}}
 r=records[key];r['payload']['historical_source_import']['pages'].append(page)
 r['payload']['notes']+=f"PM Scan.pdf page {page}; source period: {p['rawDate']}. Completion date not inferred.\n"+'\n'.join(p['unresolved'])+'\n'
 r['payload']['deficiency_notes']+='\n'.join(p['findings'])+'\n'
 return r['payload']
# Source rows are mapped explicitly where printed PDF line wrapping differs.
# Scott confirmed queried years=2026, queried scopes=property-wide, and item N/A.
quarter_pages=[22,23,24,25,26,27,30,31,35,36,37,38,39,40,41,42]
def item_id(page,n,prefix):
 if page==24:return f'{prefix}-item-'+str({1:19,2:20,3:21,4:22,5:23,6:24,7:25,8:26,9:28}[n])
 if page==25:
  return {4:'kitchen-scan-walk-in-cooler',5:'kitchen-scan-dishwasher',6:'kitchen-scan-cooking-equipment'}.get(n,f'{prefix}-item-{n+3 if n<4 else n}')
 if page==26:return 'ice-machine-areas-scan-manufacturer-pm' if n==1 else f'{prefix}-item-{n+5}'
 offset=5 if page==27 else 4 if page in [23,37,38,39] else 3
 return f'{prefix}-item-{n+offset}'
for page in quarter_pages:
 p=pages[page];prefix=p['templateId'].removeprefix('pdf:')
 months=[3,6,9,12] if page in [23,24,25,26] else [2,5,8,11] if page in [35,36,37,38,39,40] else [1,4,7,10]
 for q in [1,2,3]:
  scope='equipment:commercial laundry' if page==40 else 'equipment:property wide' if page in [23,24,26] else 'area:property'
  payload=entry(page,f'2026-{months[q-1]:02d}-01',scope)
  if page==40:payload['form_data']['location']='Commercial laundry'
  if page in [23,24,26,27,37,38,39]:payload['form_data']['location']='Property Wide'
  payload['historical_source_import']['mapping_confirmation']='Scott: queried years 2026; queried locations property-wide; whirlpool jets and walk-in cooler not applicable; disregard Business Center handwritten eighth-row work-order note.'
  for row in forms[page][q-1]['rows']:
   n=int(row['id'].rsplit('r',1)[1]);value=row['value']
   if (page,n) in [(24,6),(25,4)]:value='na'
   if value:
    target=item_id(page,n,prefix)
    if target in payload['responses'] and payload['responses'][target]!=value:raise ValueError('Conflicting source answers')
    payload['responses'][target]=value
# Verified calendar month/year from explicit headers or exact row dates.
monthly={19:'2026-06-01',10:'2026-06-01',11:'2026-06-01',12:'2026-06-01',13:'2026-06-01',14:'2026-06-01',16:'2026-02-01',15:'2026-06-01',17:'2026-06-01',18:'2026-06-01',20:'2026-09-01',21:'2026-09-01',28:'2026-09-01',29:'2026-09-01'}
for page,period in monthly.items():
 payload=entry(page,period,'area:property')
 if page in [10,11,12,13,14,16,19]:payload['historical_source_import']['period_confirmation']='Scott confirmed 06/26 means June 2026; 02/2026 on extinguisher floors 3-4 is the inspection period. Third-floor undated log confirmed same June 2026 period. Exact day not supplied.'
 rows=payload['form_data'].setdefault('logEntries',[])
 for row in forms[page][0]['rows']:
  label=row['label'];device=''
  if ' | ' in label:label,device=label.rsplit(' | ',1)
  rawdate=row['rawDate'];date=rawdate if re.fullmatch(r'20\d{2}-\d{2}-\d{2}',rawdate) else ''
  answer={'location':label,'date':date,'notes':f"PM Scan.pdf p{page}, {row['id']}. "+row['notes']+((' Source date as written: '+rawdate) if rawdate and not date else ''),'dateRepaired':'','initials':''}
  answer['passed' if page in [15,16] else 'functional']=row['value'].title() if row['value'] in ['YES','NO'] else ''
  if device:answer['deviceType']='Exit sign' if device in ['EXIT','EXIT SIGN'] else 'Emergency light' if device in ['EM','EM LIGHT'] else ''
  rows.append(answer)
batch={'source_id':source_id,'expected_pages':[pages[n] for n in sorted(used)],'entries':list(records.values()),'deferred_pages':{str(n):pages[n]['unresolved'] for n in []},'room_supplement':'libfile_b2545c4f8f3c8191b1405e19ad0f9e01; 49 blank quarters, p73 Q2 M21 unreadable; zero additional answers; total uncertainty79'}
(out/'pm-actual-entry-batch.json').write_text(json.dumps(batch,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
batch['expected_entry_count']=len(records)
(out/'pm-actual-entry-batch.json').write_text(json.dumps(batch,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
literal=json.dumps(batch,ensure_ascii=False,separators=(',',':'))
assert '$pm_batch$' not in literal
sql="""-- Prepared only. Requires approved production execution; never run by this compiler.
begin;
-- Short, bounded transaction: serialize writes while checking existing user records.
lock table public.cmpri_pm_proposals in share row exclusive mode;
create temporary table _pm_batch(input jsonb) on commit drop;
insert into _pm_batch values ($pm_batch$"""+literal+"""$pm_batch$::jsonb);
do $pm_apply$
declare b jsonb; p jsonb; r jsonb; existing public.cmpri_pm_proposals; inserted integer:=0;
begin
 select input into b from _pm_batch;
 if jsonb_array_length(b->'entries')<>(b->>'expected_entry_count')::integer then raise exception 'Unexpected batch size';end if;
 for p in select value from jsonb_array_elements(b->'expected_pages') loop
  if not exists(select 1 from public.cmpri_pm_source_evidence s, lateral jsonb_array_elements(s.pages) sp
   where s.hotel_id='c81ad01a-7a9f-4880-ac1c-5e849f30bad6' and s.source_id=b->>'source_id' and sp=p)
  then raise exception 'Source evidence changed; import aborted';end if;
 end loop;
 for r in select value from jsonb_array_elements(b->'entries') loop
  if exists(select 1 from public.cmpri_pm_proposals x where x.hotel_id='c81ad01a-7a9f-4880-ac1c-5e849f30bad6'
   and x.template_id=r->>'template_id' and x.period_start=(r->>'period_start')::date and x.scope_key=r->>'scope_key'
   and (x.id<>(r->>'id')::uuid or x.payload is distinct from r->'payload' or x.status<>'approved'))
  then raise exception 'Existing PM response/proposal conflicts; nothing overwritten';end if;
  select * into existing from public.cmpri_pm_proposals where id=(r->>'id')::uuid;
  if found then
   if existing.hotel_id<>'c81ad01a-7a9f-4880-ac1c-5e849f30bad6' or existing.template_id<>r->>'template_id'
    or existing.period_start<>(r->>'period_start')::date or existing.scope_key<>r->>'scope_key'
    or existing.payload is distinct from r->'payload' or existing.status<>'approved'
   then raise exception 'Import identity conflict';end if;
  else
   insert into public.cmpri_pm_proposals(id,hotel_id,template_id,period_start,scope_key,payload,proposed_cells,status,submitted_by_name,review_note)
   values((r->>'id')::uuid,'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',r->>'template_id',(r->>'period_start')::date,r->>'scope_key',r->'payload','[]','approved','Historical binder import','User-authorized source-answer import. No whole-form completion or repair inferred. Source provenance retained in payload.');
   inserted:=inserted+1;
  end if;
 end loop;
 raise notice 'Inserted % actual PM records; exact replays skipped',inserted;
end $pm_apply$;
commit;
"""
(out/'pm-actual-entry-batch.sql').write_text(sql,encoding='utf-8')
print(json.dumps({'entries':len(records),'checklistSelections':sum(len(r['payload']['responses']) for r in records.values()),'logRows':sum(len(r['payload']['form_data'].get('logEntries',[])) for r in records.values()),'sourcePages':sorted(used),'productionWrites':0}))
