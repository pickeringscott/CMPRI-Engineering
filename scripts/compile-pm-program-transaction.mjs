/** Compile only a reconciled local plan. No network, execution, or approval bypass. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [input,output,actor,actorName]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: reviewed-plan.json output.sql actor-uuid actor-name');
const plan=JSON.parse(readFileSync(input,'utf8'));
const reasons=[];
if(plan.canRelease!==true)reasons.push('Plan is not release ready.');
for(const field of ['conflicts','room_conflicts','unresolved_source']) {
 if(!Array.isArray(plan[field])) {reasons.push(`${field} missing.`);continue;}
 for(const issue of plan[field]) {
  const digest=createHash('sha256').update(JSON.stringify(issue)).digest('hex');
  const retained=plan.retained_evidence?.find(r=>r.field===field&&r.sha256===digest&&r.action==='preserve_without_import');
  if(!retained)reasons.push(`${field}: missing exact preservation disposition ${digest}.`);
 }
}
// Retention documents excluded facts; it never licenses writing those facts.
for(const conflict of plan.conflicts||[]) {
 const c=conflict.check;
 if(plan.routine_records.some(r=>r.template_id===c.template_id&&r.period_start===c.period_start&&r.scope_key===c.scope_key&&Object.hasOwn(r.payload.responses,c.item_id))) reasons.push('Preserved conflict appears in additions.');
}
for(const conflict of plan.room_conflicts||[])if(plan.room_import.rows.some(r=>r.room===conflict.row.room&&r.periodStart===conflict.row.periodStart))reasons.push('Preserved room conflict appears in additions.');
if(plan.completion_reconciliation?.verified!==true)reasons.push('Whole-inspection completion reconciliation is not verified.');
if(plan.outcome_verification?.complete!==true)reasons.push('Full requirement outcome verification is not complete.');
if(reasons.length){
 writeFileSync(output+'.blocked.json',JSON.stringify({status:'NOT COMPILED',reasons,productionAction:'None'},null,2)+'\n');
 console.log(JSON.stringify({status:'NOT COMPILED',reasons}));process.exitCode=2;
}else{
 if(!/^[a-f0-9-]{36}$/i.test(actor||'')||!actorName?.trim())throw new Error('Exact approved actor and name required.');
 const hotel=plan.hotel_id;
 if(hotel!=='c81ad01a-7a9f-4880-ac1c-5e849f30bad6')throw new Error('Wrong property.');
 const quote=value=>`'${String(value).replaceAll("'","''")}'`;
 const json=value=>`${quote(JSON.stringify(value))}::jsonb`;
 const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
 const records=plan.routine_records.map(r=>{
  if(!r.template_id.startsWith('workbook:')||!/^20\d\d-\d\d-\d\d$/.test(r.period_start)||r.scope_key!=='property')throw new Error('Unsupported routine scope.');
  if(Object.values(r.payload.responses).some(v=>v!==true)||!r.payload.source_cells?.length)throw new Error('Only source-supported positive additions allowed.');
  const id=createHash('sha256').update([hotel,plan.source_sha256,r.template_id,r.period_start,r.scope_key].join('|')).digest('hex').slice(0,32);
  return {...r,id:`${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`};
 });
 // Existing records are never updated. Revision+payload guards protect manual
 // changes. Table locks serialize the preview and both sets of inserts.
 const expected=plan.expected_snapshot.proposals.map(p=>({id:p.id,revision:p.revision,status:p.status,payload:p.payload}));
 const sql=`BEGIN;
LOCK TABLE public.cmpri_pm_proposals, public.cmpri_room_pm_history IN SHARE ROW EXCLUSIVE MODE;
DO $pm_program$
DECLARE expected jsonb := ${json(expected)}; additions jsonb := ${json(records)};
 r jsonb; old_record public.cmpri_pm_proposals%rowtype; preview jsonb; applied jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expected) e
   LEFT JOIN public.cmpri_pm_proposals p ON p.id=(e->>'id')::uuid AND p.hotel_id=${quote(hotel)}::uuid
   WHERE p.id IS NULL OR p.revision IS DISTINCT FROM (e->>'revision')::int
   OR p.status IS DISTINCT FROM e->>'status' OR p.payload IS DISTINCT FROM e->'payload') THEN
  RAISE EXCEPTION 'Existing PM snapshot changed; nothing applied';
 END IF;
 IF EXISTS(SELECT 1 FROM public.cmpri_pm_proposals p WHERE p.hotel_id=${quote(hotel)}::uuid
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected) e WHERE e->>'id'=p.id::text)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(additions) a WHERE a->>'id'=p.id::text)) THEN
  RAISE EXCEPTION 'New PM records require reconciliation; nothing applied';
 END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(additions) LOOP
  SELECT * INTO old_record FROM public.cmpri_pm_proposals WHERE id=(r->>'id')::uuid;
  IF FOUND THEN
   IF old_record.hotel_id IS DISTINCT FROM ${quote(hotel)}::uuid OR old_record.payload IS DISTINCT FROM r->'payload'
    OR old_record.template_id IS DISTINCT FROM r->>'template_id' OR old_record.scope_key IS DISTINCT FROM r->>'scope_key'
    OR old_record.period_start IS DISTINCT FROM (r->>'period_start')::date OR old_record.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Retry differs from stored PM record';
   END IF;
  ELSE
   INSERT INTO public.cmpri_pm_proposals(id,hotel_id,template_id,period_start,scope_key,payload,proposed_cells,status,submitted_by,submitted_by_name,reviewed_by,reviewed_at,review_note)
   VALUES((r->>'id')::uuid,${quote(hotel)}::uuid,r->>'template_id',(r->>'period_start')::date,r->>'scope_key',r->'payload','[]','approved',${quote(actor)}::uuid,${quote(actorName)},${quote(actor)}::uuid,now(),${quote('Approved corporate source import '+digest)});
  END IF;
 END LOOP;
 preview := public.cmpri_import_room_pm_history(${quote(hotel)}::uuid,${quote(actor)}::uuid,${quote(actorName)},${json(plan.room_import)},${quote(digest)},false,null);
 IF (preview->>'conflicts')::int<>0 THEN RAISE EXCEPTION 'Room history changed; nothing applied'; END IF;
 applied := public.cmpri_import_room_pm_history(${quote(hotel)}::uuid,${quote(actor)}::uuid,${quote(actorName)},${json(plan.room_import)},${quote(digest)},true,preview->>'previewDigest');
 RAISE NOTICE 'PM source transaction: %',applied;
END $pm_program$;
COMMIT;
`;
 writeFileSync(output,sql);
 console.log(JSON.stringify({status:'LOCAL SQL ONLY - NOT EXECUTED',digest,routineRecords:records.length,roomRows:plan.room_import.rows.length}));
}
