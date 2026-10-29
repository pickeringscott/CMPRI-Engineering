"""Local-only compiler: confirm imported inspections and link exact workbook tasks."""
import json,pathlib,sys,re,uuid,copy
base=pathlib.Path(sys.argv[1])
batch=json.loads((base/'pm-before-completion-batch.json').read_text(encoding='utf-8'))
catalog=json.loads(pathlib.Path('src/lib/pm/source-catalog.json').read_text(encoding='utf-8'))
def normalized(s):return re.sub(r'[^a-z0-9]','',s.lower())
def slug(s):return re.sub(r'[^a-z0-9]+','-',re.sub(r'\.pdf$','',s.lower())).strip('-')
pdfs={'pdf:'+slug(p['file']):p['file'] for p in catalog['pdfs']}
months={m['month']:i+1 for i,m in enumerate(catalog['months'])}
groups={};links=[]
supported=[e for e in batch['entries'] if e['payload']['form_data'].get('logEntries') or any(v in ['complete','follow-up'] for v in e['payload']['responses'].values())]
for entry in supported:
 year=entry['period_start'][:4];month=int(entry['period_start'][5:7]);quarter=(month-1)//3
 monthly=entry['template_id'] in {'pdf:emergency-lighting-exit-sign-log-master','pdf:monthly-fire-extinguisher-log','pdf:monthly-fire-door-log','pdf:monthly-laundry-chute-log'}
 candidates=[]
 for m in catalog['months']:
  n=months[m['month']]
  if (n!=month if monthly else (n-1)//3!=quarter):continue
  for task in m['tasks']:
   if any(normalized(ref)==normalized(pdfs[entry['template_id']]) for ref in task['references']):candidates.append((m,task))
 if len(candidates)!=1:raise ValueError(f'Expected one exact period/task match: {entry["template_id"]}: {candidates}')
 m,task=candidates[0];period=f'{year}-{months[m["month"]]:02d}-01';template='workbook:monthly:'+m['month'].lower()
 key=(template,period)
 if key not in groups:
  groups[key]={'id':str(uuid.uuid5(uuid.NAMESPACE_URL,'cmpri:pm-binder-completion:'+':'.join(key))),'template_id':template,'period_start':period,'scope_key':'property','payload':{'responses':{},'form_data':{},'notes':'Historical inspection completion; equipment failures remain recorded separately.','is_complete':False,'completed_on':None,'historical_completion_links':[]}}
 g=groups[key];g['payload']['responses'][task['id']]=True
 link={'inspection_id':entry['id'],'inspection_template':entry['template_id'],'inspection_period':entry['period_start'],'workbook_template':template,'workbook_period':period,'item_id':task['id'],'label':task['label']}
 links.append(link);g['payload']['historical_completion_links'].append(link)
plan={'inspections':supported,'workbooks':list(groups.values()),'links':links}
(base/'pm-completion-links.json').write_text(json.dumps(plan,indent=2)+'\n',encoding='utf-8')
literal=json.dumps(plan,separators=(',',':'));assert '$completion$' not in literal
sql="""begin;
lock table public.cmpri_pm_proposals in share row exclusive mode;
do $apply$
declare b jsonb := $completion$"""+literal+"""$completion$::jsonb; r jsonb; p public.cmpri_pm_proposals; expected jsonb;
begin
 for r in select value from jsonb_array_elements(b->'inspections') loop
  select * into p from public.cmpri_pm_proposals where id=(r->>'id')::uuid;
  expected:=jsonb_set(r->'payload','{is_complete}','true');
  if not found or p.hotel_id<>'c81ad01a-7a9f-4880-ac1c-5e849f30bad6' or p.status<>'approved' or p.template_id<>r->>'template_id' or p.period_start<>(r->>'period_start')::date or p.scope_key<>r->>'scope_key' or (p.payload is distinct from r->'payload' and p.payload is distinct from expected) then raise exception 'Inspection changed; no data overwritten';end if;
 end loop;
 for r in select value from jsonb_array_elements(b->'workbooks') loop
  select * into p from public.cmpri_pm_proposals where id=(r->>'id')::uuid;
  if found and (p.hotel_id<>'c81ad01a-7a9f-4880-ac1c-5e849f30bad6' or p.template_id<>r->>'template_id' or p.period_start<>(r->>'period_start')::date or p.scope_key<>r->>'scope_key' or p.payload is distinct from r->'payload' or p.status<>'approved') then raise exception 'Workbook identity changed';end if;
  if exists(select 1 from public.cmpri_pm_proposals existing where existing.hotel_id='c81ad01a-7a9f-4880-ac1c-5e849f30bad6' and existing.template_id=r->>'template_id' and existing.period_start=(r->>'period_start')::date and existing.scope_key=r->>'scope_key' and (existing.id<>(r->>'id')::uuid or existing.payload is distinct from r->'payload' or existing.status<>'approved')) then raise exception 'Workbook edited; nothing overwritten';end if;
 end loop;
 for r in select value from jsonb_array_elements(b->'inspections') loop
  update public.cmpri_pm_proposals set payload=jsonb_set(payload,'{is_complete}','true') where id=(r->>'id')::uuid and payload is distinct from jsonb_set(payload,'{is_complete}','true');
 end loop;
 for r in select value from jsonb_array_elements(b->'workbooks') loop
  insert into public.cmpri_pm_proposals(id,hotel_id,template_id,period_start,scope_key,payload,proposed_cells,status,submitted_by_name,review_note)
  values((r->>'id')::uuid,'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',r->>'template_id',(r->>'period_start')::date,r->>'scope_key',r->'payload','[]','approved','Historical binder completion','Approved inspection-to-workbook completion link. No device condition or exact completion date inferred.') on conflict(id) do nothing;
 end loop;
end $apply$;
commit;
"""
(base/'pm-completion-links.sql').write_text(sql,encoding='utf-8')
print(json.dumps({'inspections':len(links),'workbookMonths':len(groups),'counts':{period:len(g['payload']['responses']) for (_,period),g in groups.items()}}))
