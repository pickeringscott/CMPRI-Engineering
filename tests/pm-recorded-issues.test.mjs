import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recordedProposal,recordedRoom,recordedFingerprint,reviewedRecordedIssue,guardRecordedOverlaps} from '../src/lib/pm/recorded-issues.ts';
const catalog=JSON.parse(readFileSync(new URL('../../pm-work-order-plan/catalog-inventory.json',import.meta.url),'utf8'));
const templates=Array.isArray(catalog)?catalog:catalog.templates;
const locationId='11111111-1111-4111-8111-111111111111';
const template={id:'test',title:'Inspection',checklist:[{id:'a',label:'Test item'}],fields:[],repeatableFields:[{id:'functional',label:'Functional'}]};
const record={id:'p',template_id:'test',period_start:'2025-01-01',scope_key:'property',status:'approved',submitted_by:'other',revision:1,payload:{responses:{a:'follow-up'},notes:'Original fact',completed_on:'2025-01-02',is_complete:true}};
test('approved earlier inspection can supply ticket-only details without changing original values',()=>{
 const before=structuredClone(record),source=recordedProposal(template,record,'me');
 assert.equal(source.hold,'');assert.equal(source.issues.length,1);
 const issue=reviewedRecordedIssue(source,{fingerprint:source.fingerprint,issueKey:'item:a',detail:'Reviewed original defect',locationId});
 assert.equal(issue.detail,'Reviewed original defect');assert.deepEqual(record,before);
});
test('fingerprint rejects changed history and missing details/location; no invented descriptions',()=>{
 const source=recordedProposal(template,record,'me');
 assert.equal(source.issues[0].detail,'');
 const input={fingerprint:source.fingerprint,issueKey:'item:a',detail:'Issue',locationId};
 for(const patch of [{fingerprint:'stale'},{detail:''},{locationId:''},{issueKey:'not-recorded'}]) assert.throws(()=>reviewedRecordedIssue(source,{...input,...patch}));
 assert.equal(recordedFingerprint({b:2,a:1}),recordedFingerprint({a:1,b:2}));
});
test('pending ownership, processing and legacy links remain restricted',()=>{
 for(const patch of [{status:'pending'},{status:'processing'},{payload:{...record.payload,work_order_id:'legacy'}}]) assert.ok(recordedProposal(template,{...record,...patch},'me').hold);
 assert.equal(recordedProposal(template,{...record,status:'pending',submitted_by:'me'},'me').hold,'');
});
test('room follow-up is eligible without changing historical completion or treating blank/NA as failure',()=>{
 const row={room:'231',period_start:'2025-01-01',completed_on:null,item_answers:{a:{value:'follow-up'},b:{value:'na'}}};
 const before=structuredClone(row),source=recordedRoom(template,row);
 assert.equal(source.scope,'room:231');assert.deepEqual(source.issues.map(i=>i.key),['item:a']);assert.deepEqual(row,before);
});
test('legacy log identity survives repeated review; NO semantics stay field-specific',()=>{
 const r={...record,payload:{form_data:{logEntries:[{functional:'NO',ordinary:'NO'},{functional:'YES'}]}}};
 const a=recordedProposal(template,r,'me'),b=recordedProposal(template,r,'me');
 assert.deepEqual(a.issues,b.issues);assert.deepEqual(a.issues.map(i=>i.key),['row:legacy-0:functional']);
});
test('overlapping proposal/room issues are held instead of duplicate historical processing',()=>{
 const a=recordedProposal(template,record,'me'),b={...a,id:'other'};
 assert.ok(guardRecordedOverlaps([a,b]).every(s=>s.hold));
});
test('entire 55-definition catalog and all seven repeatable definitions use the recorded path without mutation',()=>{
 assert.equal(templates.length,55);let repeatables=0;
 for(const t of templates){
  if(t.repeatableFields?.length)repeatables++;
  const payload={responses:Object.fromEntries(t.checklist.map(item=>[item.id,'follow-up'])),form_data:{}};
  const before=JSON.stringify(payload),source=recordedProposal(t,{...record,payload},'me');
  assert.equal(source.issues.length,t.checklist.length,t.id);assert.equal(JSON.stringify(payload),before);
 }
 assert.equal(repeatables,7);
});
for(const t of templates.filter(t=>t.repeatableFields?.length)) test(`recorded flagged log fields retain identity: ${t.title}`,()=>{
 const row={_pmRowId:'existing-row'},metadata={};
 for(const field of t.repeatableFields){row[field.id]='Original recorded value';metadata[`row:existing-row:${field.id}`]={flagged:true,detail:'Existing issue fact',locationId};}
 const payload={form_data:{logEntries:[row],pmIssueDetails:metadata}},before=JSON.stringify(payload);
 const source=recordedProposal(t,{...record,template_id:t.id,payload},'me');
 assert.equal(source.issues.length,t.repeatableFields.length);
 assert.ok(source.issues.every(issue=>issue.key.startsWith('row:existing-row:')&&issue.detail==='Existing issue fact'));
 assert.equal(JSON.stringify(payload),before);
});
