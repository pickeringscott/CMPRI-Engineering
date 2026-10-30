/** Local fixture verification using the same catalog and selector as the PM UI. No network. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(file,overrides={}){
 file=path.resolve(file);const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {exports,require(name){if(name in overrides)return overrides[name];if(name==='server-only')return {};if(name.startsWith('.')||name.startsWith('@/')){let target=name.startsWith('@/')?path.resolve('src',name.slice(2)):path.resolve(path.dirname(file),name);if(target.endsWith('.json'))return JSON.parse(fs.readFileSync(target,'utf8'));if(!path.extname(target))target+='.ts';return load(target,overrides);}return require(name);},console,process,Buffer});return exports;
}
const dir=path.resolve(process.argv[2]||'../pm-corporate-review');
const facts=JSON.parse(fs.readFileSync(path.join(dir,'verified-cell-facts.json'),'utf8'));
const plan=JSON.parse(fs.readFileSync(path.join(dir,'full-program-plan/full-program-plan.json'),'utf8'));
const snapshot=plan.expected_snapshot;
const before=JSON.stringify(snapshot);
const catalog=load('src/lib/pm/catalog.ts');
// Coverage is evidence for review, not permission to infer completion from counts.
const inspectionCoverage=snapshot.proposals.filter(p=>p.template_id.startsWith('pdf:')).map(p=>{
 const form=catalog.findPmTemplate(p.template_id);
 assert.ok(form,p.template_id);
 const payload=p.payload;
 const responses=payload.responses||{};
 const rows=payload.form_data?.logEntries||[];
 return {id:p.id,template_id:p.template_id,period_start:p.period_start,scope_key:p.scope_key,
  pages:payload.historical_source_import?.pages||[],stored_complete:payload.is_complete,
  selected_items:Object.keys(responses),
  unanswered_items:form.checklist.filter(i=>!Object.hasOwn(responses,i.id)).map(i=>({id:i.id,label:i.label})),
  unmatched_items:Object.keys(responses).filter(id=>!form.checklist.some(i=>i.id===id)),
  missing_required_fields:form.fields.filter(f=>f.required&&!String(payload.form_data?.[f.id]??'').trim()).map(f=>f.id),
  log_rows:rows.length,
  incomplete_log_rows:rows.flatMap((row,index)=>{const missing=(form.repeatableFields||[]).filter(f=>f.required&&!String(row[f.id]??'').trim()).map(f=>f.id);return missing.length?[{index,missing}]:[];}),
  source_notes:payload.notes,
  conclusion:'Preserve recorded conditions; coverage alone does not certify that the whole scope was inspected.'};
});
fs.writeFileSync(path.join(dir,'inspection-control-coverage.json'),JSON.stringify(inspectionCoverage,null,2)+'\n');
const {approvedRoutineResponses}=load('src/lib/pm/proposal-projection.ts');
const {pmRoutineChecked,isPmRoutineSummary}=load('src/lib/pm/routine-responses.ts');
const {planSourceRoutineChecks}=load('src/lib/pm/source-import-plan.ts');
assert.equal(facts.sheets,17);assert.equal(facts.meaningful_cells,9086);
assert.equal(facts.source_documents.length,6);
for(const document of facts.source_documents){
 const form=catalog.PM_TEMPLATES.find(t=>t.sourceFile===document.title);
 assert.ok(form,document.title);assert.ok(form.checklist.length||form.repeatableFields.length,document.title);
}
assert.equal(catalog.findPmTemplate('workbook:daily').checklist.filter(i=>!isPmRoutineSummary(i.id)).length,11);
assert.equal(catalog.corporateWeeklyTemplate.checklist.length,20);
for(const fact of facts.facts){
 const template=catalog.findPmTemplate(fact.template_id);
 assert.ok(template,JSON.stringify(fact));
 assert.ok(template.checklist.some(i=>i.id===fact.item_id),JSON.stringify(fact));
 assert.equal(catalog.validPmPeriod(template,fact.period_start),true,JSON.stringify(fact));
}
const simulated=plan.routine_records.map((r,i)=>({...r,id:`local-${i}`,status:'approved',updated_at:'2026-10-30T00:00:00Z'}));
const merged=approvedRoutineResponses([...snapshot.proposals,...simulated]);
let verified=0;
for(const record of plan.routine_records){
 const key=[record.template_id,record.period_start,record.scope_key].join('|');
 const projected={status:'approved',responses:merged.get(key)};
 const template=catalog.findPmTemplate(record.template_id);
 for(const id of Object.keys(record.payload.responses)){assert.ok(pmRoutineChecked(projected,id,false,false));verified++;}
 const checked=template.checklist.filter(i=>pmRoutineChecked(projected,i.id,false,false));
 assert.equal(checked.length,Object.values(projected.responses).filter(v=>v===true).length);
}
const replay=planSourceRoutineChecks(facts.facts,[...snapshot.proposals,...simulated]);
assert.equal(replay.additions.length,0);
assert.equal(replay.conflicts.length,plan.conflicts.length);
assert.equal(JSON.stringify(snapshot),before);
const roomAnswers=snapshot.room_history.reduce((n,r)=>n+r.item_answer_count,0);
assert.equal(snapshot.room_history.length,245);assert.equal(roomAnswers,15800);
const lighting=snapshot.proposals.filter(p=>p.template_id==='pdf:emergency-lighting-exit-sign-log-master'&&p.period_start==='2026-06-01');
const rows=lighting.flatMap(p=>p.payload.form_data.logEntries||[]).filter(r=>r.notes?.startsWith('PM Scan.pdf p13,')&&r.deviceType==='Emergency light');
assert.equal(rows.filter(r=>r.functional==='Yes').length,4);assert.equal(rows.filter(r=>r.functional==='No').length,5);
// Exercise the actual authenticated GET projection against the complete local
// snapshot plus proposed additions. This is a simulation, not a live API claim.
const store=[...snapshot.proposals,...simulated.map(r=>({...r,hotel_id:plan.hotel_id}))];
const admin={from(table){let filters=[],low=0,high=Infinity;const result=()=>({data:(table==='cmpri_pm_proposals'?store:[]).filter(r=>filters.every(f=>f(r))).slice(low,high+1),error:null});const chain={
 select:()=>chain,eq:(k,v)=>(filters.push(r=>r[k]===v),chain),gte:(k,v)=>(filters.push(r=>r[k]>=v),chain),lte:(k,v)=>(filters.push(r=>r[k]<=v),chain),
 in:(k,vs)=>(filters.push(r=>vs.includes(r[k])),chain),order:()=>chain,range:(a,b)=>(low=a,high=b,Promise.resolve(result())),limit:n=>(high=n-1,Promise.resolve(result()))};return chain;}};
const overrides={'@/lib/server/auth':{requireUser:async()=>({admin,principal:{identity:{id:'local-verification'},profile:{role:'engineer'}}})},
 '@/lib/server/access':{allows:()=>true},'@/lib/server/roles':{profileHasRole:()=>false},'@/lib/constants':{HOTEL_ID:plan.hotel_id}};
const api=load('src/app/api/preventive-maintenance/route.ts',overrides);
let apiSelected=0;
for(const year of [2022,2023,2024,2025,2026]){
 const week=catalog.pmWeekStart(`${year}-12-31`);
 const response=await api.GET({nextUrl:new URL(`https://local.invalid/api/preventive-maintenance?week=${week}`)});
 assert.equal(response.status,200);const body=await response.json();
 for(const entry of body.entries.filter(e=>e.historical_source_import)) {
  const review=JSON.parse(fs.readFileSync('src/lib/server/pm-source-completion-review.json','utf8')).rows.find(r=>r.id===entry.id);
  assert.equal(entry.is_complete,review.inspection_complete);
  assert.equal(entry.completion_review_required,!review.inspection_complete);
  const original=snapshot.proposals.find(p=>p.id===entry.id);
  assert.deepEqual(entry.responses,original.payload.responses);
 }
 for(const record of plan.routine_records.filter(r=>r.period_start.startsWith(String(year)))){
  const entry=body.entries.find(e=>e.template_id===record.template_id&&e.period_start===record.period_start&&e.scope_key===record.scope_key);
  assert.ok(entry,JSON.stringify(record));
  for(const id of Object.keys(record.payload.responses)){assert.ok(pmRoutineChecked(entry,id,body.spreadsheet_sync_enabled,false));apiSelected++;}
 }
}
assert.equal(apiSelected,verified);
assert.equal(JSON.stringify(snapshot),before);
const report={status:'LOCAL SIMULATION ONLY; NOT A PRODUCTION IMPORT',sourceTabs:17,sourceDocuments:6,
 proposedRecords:plan.routine_records.length,verifiedSelectedControls:verified,actualApiProjectionSelected:apiSelected,roomAdditions:plan.room_import.rows.length,
 pendingConflicts:plan.conflicts.length,dateConflicts:plan.room_conflicts.length,sourceExceptions:plan.unresolved_source.length,
 replayAdds:0,preservedRoomRecords:245,preservedRoomAnswers:15800,lighting:{yes:4,no:5},releaseReady:false};
fs.writeFileSync(path.join(dir,'local-outcome-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
