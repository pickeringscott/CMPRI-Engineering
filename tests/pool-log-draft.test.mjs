import test from 'node:test';
import assert from 'node:assert/strict';
import { readPoolDraft, savePoolDraft, clearPoolDraft, poolDraftKey, poolDraftMatchesSaved, poolRemarksForSave, readPoolSelection, savePoolSelection } from '../src/lib/pool-log-draft.ts';

const scope={hotelId:'hotel',userId:'one',facilityId:'00000000-0000-4000-8000-000000000002',date:'2026-11-20'};
function storage(){const rows=new Map();return{rows,getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};}
const form={ph_am:'7.4',ph_pm:'',sanitizer_band_am:'3-6',sanitizer_band_pm:'',sample_location_am:'',sample_location_pm:'',temperature_f:'84',flow_rate_gpm:'60',main_drain_visible:'true',filter_backwashed:'false',remarks:'Check completed',closure_reason:'',requires_attention:false,closure_condition:false,manual_closure:false,retest_id:'',retest_ph:'',retest_band:''};
const draft=()=>({version:1,baseRevision:2,savedRemarks:'Earlier test',form:{...form},chemicalUses:[],editingSavedLog:false,uncertainSave:false});

test('unacknowledged pool readings and notes survive complete reload in the exact owner, property, facility and date scope',()=>{
 const disk=storage();savePoolDraft(disk,scope,draft());
 assert.deepEqual(readPoolDraft(disk,scope),draft());
 for(const changed of [{userId:'other'},{hotelId:'other'},{facilityId:'other'},{date:'2026-11-19'}])assert.equal(readPoolDraft(disk,{...scope,...changed}),null);
 assert.equal(readPoolDraft(disk,{...scope,date:'2026-02-30'}),null);
 clearPoolDraft(disk,scope);assert.equal(readPoolDraft(disk,scope),null);
});
test('retained pool data is bounded and sanitized rather than storing arbitrary account data',()=>{
 const disk=storage();const source={...draft(),access_token:'secret',form:{...form,unknown:'discard'}};
 savePoolDraft(disk,scope,source);const saved=readPoolDraft(disk,scope);
 assert.equal(saved.form.unknown,undefined);assert.equal(saved.access_token,undefined);
 for(const value of [{...draft(),baseRevision:-1},{...draft(),form:{...form,remarks:'x'.repeat(20001)}},{...draft(),form:{...form,main_drain_visible:{x:true}}},{...draft(),chemicalUses:[{id:'bad'}]}]){
  assert.throws(()=>savePoolDraft(disk,scope,value));
 }
 disk.setItem(poolDraftKey(scope),'{invalid');assert.equal(readPoolDraft(disk,scope),null);
 disk.setItem(poolDraftKey(scope),'x'.repeat(80001));assert.equal(readPoolDraft(disk,scope),null);
});
test('storage failure remains visible to the caller; work is never claimed durable after quota failure',()=>{
 assert.throws(()=>savePoolDraft({...storage(),setItem(){throw Error('quota');}},scope,draft()),/quota/);
});
test('each new test appends its own notes including identical text, while a cleared editor preserves existing history',()=>{
 assert.equal(poolRemarksForSave('Checked','Checked'),'Checked\nChecked');
 assert.equal(poolRemarksForSave('Checked',''),'Checked');
 assert.equal(poolRemarksForSave('',' New test '),'New test');
});
test('lost acknowledgment is reconciled only for matching readings, notes, actor and retest operation',()=>{
 const data=draft();data.form.retest_id='00000000-0000-4000-8000-000000000099';data.form.retest_ph='7.6';data.form.retest_band='3-6';
 const log={updated_by:'one',ph_am:7.4,sanitizer_band_am:'3-6',flow_rate_gpm:60,temperature_f:84,main_drain_visible:true,filter_backwashed:false,requires_attention:false,remarks:'Earlier test\nCheck completed',retest_submission:{id:data.form.retest_id,ph:7.6,sanitizer_band:'3-6'}};
 assert.equal(poolDraftMatchesSaved(data,log,'one'),true);
 for(const changed of [{updated_by:'other'},{remarks:'Different notes'},{ph_am:7.8},{temperature_f:85},{retest_submission:{...log.retest_submission,id:'different'}}])assert.equal(poolDraftMatchesSaved(data,{...log,...changed},'one'),false);
 data.chemicalUses=[{id:'00000000-0000-4000-8000-000000000003',item:'00000000-0000-4000-8000-000000000004',quantity:2,unit:'OZ'}];
 assert.equal(poolDraftMatchesSaved(data,log,'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,chemical_uses:[{...data.chemicalUses[0],actor:'one'}]},'one'),true);
});
test('a missing saved reading can never acknowledge a measured zero',()=>{
 const data=draft();data.form.flow_rate_gpm='0';
 const log={updated_by:'one',ph_am:7.4,sanitizer_band_am:'3-6',flow_rate_gpm:null,temperature_f:84,main_drain_visible:true,filter_backwashed:false,requires_attention:false,remarks:'Earlier test\nCheck completed'};
 assert.equal(poolDraftMatchesSaved(data,log,'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,flow_rate_gpm:0},'one'),true);
});
test('only valid same-account navigation metadata restores the last pool and local date',()=>{
 const disk=storage();savePoolSelection(disk,scope);
 assert.deepEqual(readPoolSelection(disk,scope,'2026-11-20'),{date:scope.date,facilityId:scope.facilityId});
 assert.equal(readPoolSelection(disk,{...scope,userId:'other'},'2026-11-20'),null);
 assert.equal(readPoolSelection(disk,scope,'2026-11-19'),null);
});
