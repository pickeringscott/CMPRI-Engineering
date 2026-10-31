import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {cleanScanPayload,cleanScanHistory,operationalPayload,withoutScanCitations} from '../src/lib/pm/scan-cleanup.ts';
import {pmEntryForm} from '../src/lib/pm/entry-form.ts';
import {roomCompletion} from '../src/lib/pm/history.ts';
const read=p=>JSON.parse(fs.readFileSync(p));
const hash=x=>createHash('sha256').update(x).digest('hex');
const original=read('src/lib/server/pm-source-completion-review.json');
const operational=read('src/lib/server/pm-operational-completion-review.json');
const snapshot=read('../pm-corporate-review/scoped-snapshot-20261030.json');
test('all 61 verdicts retain identity, completion and uncertainty before/after citation cleanup',()=>{
 assert.equal(operational.rows.length,61);
 for(const old of original.rows){
  const row=snapshot.proposals.find(r=>r.id===old.id);
  assert.equal(hash(JSON.stringify(row.payload)),old.payload_sha256);
  const next=operational.rows.find(r=>r.id===old.id);
  assert.deepEqual({...next,payload_sha256:old.payload_sha256},old);
  const cleaned=cleanScanPayload(row.payload);
  assert.equal(hash(operationalPayload(row.payload)),next.payload_sha256);
  assert.equal(hash(operationalPayload(cleaned)),next.payload_sha256);
  for(const key of ['responses','is_complete','completed_on','deficiency_notes','historical_completion_links']) assert.deepEqual(cleaned[key],row.payload[key]);
  const expectedData=structuredClone(row.payload.form_data);
  for(const log of expectedData?.logEntries||[]) if(typeof log.notes==='string') log.notes=log.notes.replace(/PM Scan\.pdf p\d+, pm-source-p\d+-r\d+\. /g,'').replace(/PM Scan\.pdf p\d+ /g,'');
  assert.deepEqual(cleaned.form_data,expectedData);
  const edited=structuredClone(cleaned);edited.responses={...edited.responses,'manual-change':'follow-up'};
  assert.notEqual(hash(operationalPayload(edited)),next.payload_sha256);
  const noted=structuredClone(cleaned);noted.notes+=' New unresolved defect';
  assert.notEqual(hash(operationalPayload(noted)),next.payload_sha256);
  assert.deepEqual(cleanScanPayload(cleaned),cleaned);
 }
});
test('80 recorded form projections retain every answer, label, raw date and maintenance note',()=>{
 const old=read('src/lib/server/pm-recorded-forms.json');
 const next=read('src/lib/pm/retained-maintenance-history.json');
 assert.equal(next.groups.reduce((n,g)=>n+g.forms.length,0),80);
 old.pages.forEach((page,i)=>{
  assert.equal(next.groups[i].templateId,page.templateId);
  page.forms.forEach((form,j)=>{
   const replacement=next.groups[i].forms[j];
   assert.equal(replacement.period,form.period);assert.equal(replacement.kind,form.kind);
   assert.deepEqual(replacement.rows.map(({id,...r})=>r),form.rows.map(({id,...r})=>r));
  });
 });
});
test('cleanup leaves manual notes and operational uncertainty intact',()=>{
 const p={notes:'PM Scan.pdf page 19; source period: . Completion date not inferred.\nTwo entries have different results; do not merge.',historical_source_import:{source_id:'scan',pages:[19],mapping_confirmation:'Year confirmed'},responses:{a:'follow-up'}};
 const c=cleanScanPayload(p);
 assert.equal(c.notes,'Recorded period: . Completion date not inferred.\nTwo entries have different results; do not merge.');
 assert.deepEqual(c.historical_source_import,{mapping_confirmation:'Year confirmed'});
 assert.equal(p.historical_source_import.source_id,'scan');
 assert.equal(cleanScanPayload({notes:p.notes}).notes,p.notes);
});
test('all local historical rooms preserve hydrated values and historical completion',()=>{
 let answers=0;
 for(const row of read('../pm-modal-preview/pm-preview-values.json').room_history){
  const cleaned=cleanScanHistory(row);
  assert.deepEqual(pmEntryForm(undefined,cleaned),pmEntryForm(undefined,row));
  assert.deepEqual(roomCompletion(cleaned),roomCompletion(row));
  assert.equal(cleaned.completed_on,row.completed_on);
  for(const [id,answer] of Object.entries(row.item_answers||{})){
   answers++;assert.equal(cleaned.item_answers[id].value,answer.value);
   assert.equal(cleaned.item_answers[id].evidence,answer.evidence.replace(/PM Scan\.pdf p\d+ /g,''));
  }
 }
 assert.ok(answers>0);
 const other={source_name:'Workbook',source_reference:'JAN!A1'};
 assert.equal(cleanScanHistory(other),other);
});
test('known citation stripping retains exact maintenance facts and uncertainty',()=>{
 for(const [input,expected] of [
  ['PM Scan.pdf p20, pm-source-p20-r2. Broken cover','Broken cover'],
  ['PM Scan.pdf p20, pm-source-p20-r1.  Source date as written: 9-16-26 [day handwriting could be10]',' Source date as written: 9-16-26 [day handwriting could be10]'],
  ['PM Scan.pdf p50 Q4 R01: X (acceptable condition or complete)','Q4 R01: X (acceptable condition or complete)'],
  ['NO. Needs repair; date unknown.','NO. Needs repair; date unknown.']
 ]) assert.equal(withoutScanCitations(input),expected);
});
