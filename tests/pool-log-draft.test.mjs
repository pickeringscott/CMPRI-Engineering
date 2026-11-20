import test from 'node:test';
import assert from 'node:assert/strict';
import { readPoolDraft, savePoolDraft, clearPoolDraft, poolDraftKey, poolDraftMatchesSaved, poolRemarksForSave, readPoolSelection, savePoolSelection } from '../src/lib/pool-log-draft.ts';

const scope={hotelId:'hotel',userId:'one',facilityId:'00000000-0000-4000-8000-000000000002',date:'2026-11-20'};
function storage(){const rows=new Map();return{rows,getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};}
const form={ph_am:'7.4',ph_pm:'',sanitizer_band_am:'3-6',sanitizer_band_pm:'',sample_location_am:'',sample_location_pm:'',temperature_f:'84',flow_rate_gpm:'60',main_drain_visible:'true',filter_backwashed:'false',remarks:'Check completed',closure_reason:'',requires_attention:false,closure_condition:false,manual_closure:false,retest_id:'',retest_ph:'',retest_band:''};
const draft=()=>({version:1,baseRevision:2,savedRemarks:'Earlier test',form:{...form},chemicalUses:[],editingSavedLog:false,uncertainSave:false});
const savedLog=()=>({revision:3,updated_by:'one',ph_am:7.4,ph_pm:null,sanitizer_am:null,sanitizer_pm:null,sanitizer_band_am:'3-6',sanitizer_band_pm:null,sample_location_am:'shared',sample_location_pm:null,flow_rate_gpm:60,temperature_f:84,main_drain_visible:true,filter_backwashed:false,requires_attention:false,manual_closure:false,closure_condition:false,remarks:'Earlier test\nCheck completed'});

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
 const data=draft();data.uncertainSave=true;data.form.retest_id='00000000-0000-4000-8000-000000000099';data.form.retest_ph='7.6';data.form.retest_band='3-6';
 const log={...savedLog(),retest_submission:{id:data.form.retest_id,ph:7.6,sanitizer_band:'3-6'}};
 assert.equal(poolDraftMatchesSaved(data,log,'one'),true);
 for(const changed of [{updated_by:'other'},{remarks:'Different notes'},{ph_am:7.8},{temperature_f:85},{retest_submission:{...log.retest_submission,id:'different'}}])assert.equal(poolDraftMatchesSaved(data,{...log,...changed},'one'),false);
 data.chemicalUses=[{id:'00000000-0000-4000-8000-000000000003',item:'00000000-0000-4000-8000-000000000004',quantity:2,unit:'OZ'}];
 assert.equal(poolDraftMatchesSaved(data,log,'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,chemical_uses:[{...data.chemicalUses[0],actor:'one'}]},'one'),true);
});
test('a missing saved reading can never acknowledge a measured zero',()=>{
 const data=draft();data.uncertainSave=true;data.form.flow_rate_gpm='0';
 const log={...savedLog(),flow_rate_gpm:null};
 assert.equal(poolDraftMatchesSaved(data,log,'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,flow_rate_gpm:0},'one'),true);
});
test('cleared saved AM readings survive restart while PM remains complete',()=>{
 const disk=storage();const data=draft();
 data.editingSavedLog=true;data.savedRemarks='Earlier test';
 data.form={...data.form,ph_am:'',sanitizer_band_am:'',sample_location_am:'shared',ph_pm:'7.6',sanitizer_band_pm:'3-6',sample_location_pm:'shared',remarks:''};
 const current={...savedLog(),revision:2,ph_pm:7.6,sanitizer_band_pm:'3-6',sample_location_pm:'shared',remarks:'Earlier test'};
 savePoolDraft(disk,scope,data);
 const retained=readPoolDraft(disk,scope);
 if(poolDraftMatchesSaved(retained,current,'one'))clearPoolDraft(disk,scope);
 assert.deepEqual(readPoolDraft(disk,scope),data,'A pre-existing saved AM sample cannot acknowledge the explicit clear intent');
 data.uncertainSave=true;
 assert.equal(poolDraftMatchesSaved(data,{...current,revision:3,ph_am:null,sanitizer_band_am:null,sample_location_am:null},'one'),true);
});
test('every cleared reading and daily check requires saved null, including legacy bromine',()=>{
 for(const key of ['ph_am','flow_rate_gpm','temperature_f','main_drain_visible','filter_backwashed']){
  const data=draft();data.uncertainSave=true;data.editingSavedLog=true;data.form[key]='';
  assert.equal(poolDraftMatchesSaved(data,savedLog(),'one'),false,key);
 }
 const data=draft();data.uncertainSave=true;data.form.sanitizer_band_am='';
 assert.equal(poolDraftMatchesSaved(data,savedLog(),'one'),false,'Cleared selected band');
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),sanitizer_band_am:null,sanitizer_am:0},'one'),false,'Cleared historical numeric bromine');
 data.form.sanitizer_band_am='legacy:0';
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),sanitizer_band_am:null,sanitizer_am:0},'one'),true);
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),sanitizer_am:0},'one'),false,'Both bromine representations cannot acknowledge one intent');
});
test('new saves and lost responses require the expected revision and attempted-save evidence',()=>{
 const data=draft();const log=savedLog();
 assert.equal(poolDraftMatchesSaved(data,log,'one'),false,'Unsubmitted edits cannot be acknowledged by another save');
 data.uncertainSave=true;
 assert.equal(poolDraftMatchesSaved(data,log,'one'),true);
 for(const revision of [1,4,undefined])assert.equal(poolDraftMatchesSaved(data,{...log,revision},'one'),false);
 data.baseRevision=null;
 assert.equal(poolDraftMatchesSaved(data,{...log,revision:1},'one'),true);
 assert.equal(poolDraftMatchesSaved(data,{...log,revision:2},'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,revision:1,updated_by:'other'},'one'),false);
});
test('exact unchanged retries can be acknowledged without overwriting another actors unchanged log',()=>{
 const data=draft();
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),revision:2,updated_by:'other'},'one'),true);
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),revision:2,updated_by:'other',ph_am:7.8},'one'),false);
});
test('sample attribution confirms explicit intent and normalizes blank new versus historical locations',()=>{
 const data=draft();data.uncertainSave=true;data.baseRevision=null;
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),revision:1},'one'),true);
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),revision:1,sample_location_am:null},'one'),false);
 data.baseRevision=2;
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),sample_location_am:null},'one'),true);
 for(const sample_location_am of ['shallow','deep','middle'])assert.equal(poolDraftMatchesSaved(data,{...savedLog(),sample_location_am},'one'),false);
 data.form.sample_location_am='shallow';
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),sample_location_am:'shallow'},'one'),true);
 assert.equal(poolDraftMatchesSaved(data,savedLog(),'one'),false);
});
test('manual closure and whole closure notes must match while chemistry still derives status',()=>{
 const data=draft();data.uncertainSave=true;data.form.manual_closure=true;data.form.closure_reason='Pump repair';
 const log={...savedLog(),manual_closure:true,closure_condition:true,closure_reason:'Pump repair'};
 assert.equal(poolDraftMatchesSaved(data,log,'one'),true);
 for(const changed of [{manual_closure:false},{manual_closure:null},{closure_reason:'Pump repair elsewhere'},{closure_reason:'Earlier\nPump repair'}])assert.equal(poolDraftMatchesSaved(data,{...log,...changed},'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,closure_reason:'Pump repair\nAM pH 8.0 is outside 7.2–7.8'},'one'),true);
 data.form.manual_closure=null;
 assert.equal(poolDraftMatchesSaved(data,{...log,manual_closure:null},'one'),true);
 data.form.manual_closure=false;data.form.closure_reason='';
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),manual_closure:undefined},'one'),true);
 data.form.ph_am='8.0';data.form.sanitizer_band_am='0';
 assert.equal(poolDraftMatchesSaved(data,{...savedLog(),ph_am:8,sanitizer_band_am:'0',closure_condition:true,closure_reason:'AM pH 8.0 is outside 7.2–7.8'},'one'),true,'Unsafe readings automatically close despite the unsubmitted status flag');
});
test('a passing retest acknowledgment preserves operation identity and per-test notes as status reopens',()=>{
 const data=draft();data.uncertainSave=true;data.form.closure_condition=true;data.form.retest_id='00000000-0000-4000-8000-000000000099';data.form.retest_ph='7.6';data.form.retest_band='3-6';
 const log={...savedLog(),closure_condition:false,retest_submission:{id:data.form.retest_id,ph:7.6,sanitizer_band:'3-6'}};
 assert.equal(poolDraftMatchesSaved(data,log,'one'),true);
 assert.equal(poolDraftMatchesSaved(data,{...log,remarks:'Earlier test'},'one'),false);
 assert.equal(poolDraftMatchesSaved(data,{...log,retest_submission:{...log.retest_submission,ph:7.4}},'one'),false);
});
test('only valid same-account navigation metadata restores the last pool and local date',()=>{
 const disk=storage();savePoolSelection(disk,scope);
 assert.deepEqual(readPoolSelection(disk,scope,'2026-11-20'),{date:scope.date,facilityId:scope.facilityId});
 assert.equal(readPoolSelection(disk,{...scope,userId:'other'},'2026-11-20'),null);
 assert.equal(readPoolSelection(disk,scope,'2026-11-19'),null);
});
