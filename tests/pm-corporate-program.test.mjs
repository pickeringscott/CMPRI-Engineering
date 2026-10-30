import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findReferencedPmTemplate} from '../src/lib/pm/references.ts';
import {linkedRoutineCompletion} from '../src/lib/pm/completion-links.ts';
import {pmRoutineChecked} from '../src/lib/pm/routine-responses.ts';
import {approvedRoutineResponses} from '../src/lib/pm/proposal-projection.ts';
import {planSourceRoutineChecks} from '../src/lib/pm/source-import-plan.ts';
const source=JSON.parse(readFileSync(new URL('../src/lib/pm/source-catalog.json',import.meta.url),'utf8'));
const templates=source.pdfs.filter(p=>p.file!=='Fitness Center (1).pdf').map(p=>({id:'pdf:'+p.file.toLowerCase().replace(/\.pdf$/,'').replace(/[^a-z0-9]+/g,'-'),sourceFile:p.file,kind:'inspection',cadence:'quarterly'}));

test('sparse approved routine actions preserve other answers, explicit false, and exact period/scope isolation',()=>{
 const base={template_id:'workbook:monthly:jan',period_start:'2026-01-01',scope_key:'property',status:'approved'};
 const proposal=(id,updated_at,responses,patch={})=>({...base,id,updated_at,payload:{responses},...patch});
 const merged=approvedRoutineResponses([
  proposal('c','2026-01-03',{a:false}), proposal('a','2026-01-01',{a:true}),
  proposal('b','2026-01-02',{b:true}),proposal('d','2026-01-04',{b:false},{status:'rejected'}),
  proposal('e','2026-01-05',{b:false},{status:'pending'}),
  proposal('f','2026-01-06',{c:true},{scope_key:'area:other'}),
  proposal('g','2026-01-07',{d:true},{period_start:'2025-01-01'}),
 ]);
 assert.deepEqual(merged.get('workbook:monthly:jan|2026-01-01|property'),{a:false,b:true});
 assert.equal(merged.size,3);
});

test('source history preview preserves manual responses and pending review instead of auto approving them',()=>{
 const check={template_id:'workbook:daily',period_start:'2026-01-01',scope_key:'property',item_id:'daily-7',checked:true,source:{library_id:'source',sheet:'JAN',cell:'M7'}};
 const record={id:'existing',template_id:check.template_id,period_start:check.period_start,scope_key:check.scope_key,status:'approved',revision:1,updated_at:'2026-01-02',payload:{responses:{'daily-7':false}}};
 assert.equal(planSourceRoutineChecks([check],[record]).conflicts.length,1);
 const approved={...record,payload:{responses:{'daily-7':true}}};
 assert.equal(planSourceRoutineChecks([check],[approved]).alreadyRecorded.length,1);
 assert.equal(planSourceRoutineChecks([check],[{...approved,status:'pending'}]).conflicts.length,1);
 assert.equal(planSourceRoutineChecks([check],[{...record,scope_key:'area:other'}]).additions.length,1);
 assert.equal(planSourceRoutineChecks([{...check,checked:false}],[approved]).additions.length,0);
 assert.equal(planSourceRoutineChecks([check,{...check,checked:false}],[]).canApply,false);
});
test('all existing corporate references resolve across filename punctuation',()=>{
 let aliases=0;
 for(const month of source.months)for(const task of month.tasks)for(const ref of task.references){
  const expected=templates.find(t=>t.sourceFile.toLowerCase().replace(/[^a-z0-9]/g,'')===ref.toLowerCase().replace(/[^a-z0-9]/g,''));
  if(!expected)continue;
  assert.equal(findReferencedPmTemplate(ref,templates)?.id,expected.id);
  if(!ref.toLowerCase().includes(expected.sourceFile.toLowerCase()))aliases++;
 }
 assert.equal(aliases,20);
 assert.equal(findReferencedPmTemplate('Tool Inventory.pdf',templates),null);
});
test('ongoing task linkage requires explicit approved property-wide completion; conditions and old imports do not suffice',()=>{
 const form=templates.find(t=>t.sourceFile==='Pool.pdf');
 const entry={template_id:form.id,period_start:'2026-03-01',scope_key:'equipment:property wide',status:'approved',is_complete:true};
 assert.equal(linkedRoutineCompletion('Pool.pdf','2026-03-01',templates,[entry]),true);
 for(const patch of [{status:'pending'},{is_complete:false},{scope_key:'equipment:one pump'},{historical_source_import:{version:2}}])assert.equal(linkedRoutineCompletion('Pool.pdf','2026-03-01',templates,[{...entry,...patch}]),false);
 assert.equal(linkedRoutineCompletion('Pool.pdf','2026-06-01',templates,[entry]),false);
 assert.equal(linkedRoutineCompletion('Pool.pdf, Kitchen.pdf','2026-03-01',templates,[entry]),false);
 assert.equal(pmRoutineChecked({status:'approved',responses:{task:false}},'task',false,true),false);
});

test('legacy unverified completion is excluded from the counter without clearing stored history',()=>{
 const p={status:'approved',responses:{task:true},unverified_completion_items:['task']};
 assert.equal(pmRoutineChecked(p,'task',false,false),false);
 assert.equal(p.responses.task,true);
 assert.equal(pmRoutineChecked(p,'task',false,true),true);
 assert.equal(pmRoutineChecked({...p,unverified_completion_items:[]},'task',false,false),true);
});
