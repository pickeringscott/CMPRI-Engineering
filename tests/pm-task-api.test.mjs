import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as rules from '../src/lib/pm/task-review.ts';
function fixture({role='technician', rows=[], logs=[], conflict=false, canEdit=true}={}) {
 const writes=[];
 const template={id:'workbook:daily',kind:'routine',cadence:'daily',checklist:[{id:'fire',label:'Check Fire Panel'},{id:'pool',label:'Log Pool Readings'}]};
 const admin={from(){
  let values;
  const q={select:()=>q,match:()=>q,in:()=>q,order:()=>q,limit:async()=>({data:rows,error:null}),eq:()=>q,
   then:(resolve)=>resolve({data:logs,error:null}),
   update:v=>{values=v;writes.push(v);return q},insert:v=>{values=v;writes.push(v);return q},
   maybeSingle:async()=>({data:conflict?null:{id:'id',...values,payload:values.payload,template_id:template.id,period_start:'2026-11-02',scope_key:'property',status:'pending',revision:2},error:null})};return q;
 }};
 const auth={admin,principal:{identity:{id:'alex'},profile:{role,full_name:'Alex'}}};
 const exports={};
 const source=ts.transpileModule(readFileSync(new URL('../src/app/api/preventive-maintenance/task/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require(name){
  if(name==='next/server')return {NextResponse:{json:(data,options)=>({data,status:options?.status||200})}};
  if(name.endsWith('/auth'))return {requireUser:async()=>auth};
  if(name.endsWith('/roles'))return {profileHasRole:(profile,r)=>profile.role===r};
  if(name.endsWith('/access'))return {allows:(_principal,capability)=>capability!=='edit_tickets'||canEdit};
  if(name.endsWith('/constants'))return {HOTEL_ID:'hotel'};
  if(name.endsWith('/catalog'))return {findPmTemplate:()=>template,validPmPeriod:()=>true};
  if(name.endsWith('/task-review'))return rules;
  throw new Error(name);
 }});
 return {writes,run:(body={})=>exports.PATCH({json:async()=>({templateId:template.id,periodStart:'2026-11-02',itemId:'fire',expectedRevision:0,...body})})};
}
test('manager cannot write even with generic edit capabilities',async()=>{
 const f=fixture({role:'manager'});assert.equal((await f.run()).status,403);assert.equal(f.writes.length,0);
});
test('new technician action preserves submitter and only checks selected task',async()=>{
 const f=fixture();const r=await f.run();assert.equal(r.status,200);assert.equal(f.writes[0].payload.task_states.fire.workerId,'alex');assert.equal(f.writes[0].payload.responses.pool,false);
});
test('stale revision cannot overwrite an existing ledger',async()=>{
 const f=fixture({rows:[{status:'pending',revision:4,payload:{}}]});assert.equal((await f.run()).status,409);assert.equal(f.writes.length,0);
});
test('chief approves legacy task without replacing worker or sibling responses',async()=>{
 const f=fixture({role:'engineer',rows:[{id:'id',status:'pending',revision:4,submitted_by:'sam',submitted_by_name:'Sam',payload:{responses:{fire:true,pool:true},notes:'preserve me'}}]});
 assert.equal((await f.run({expectedRevision:4})).status,200);
 assert.equal(f.writes[0].payload.task_states.fire.workerId,'sam');assert.equal(f.writes[0].payload.task_states.fire.status,'approved');assert.equal(f.writes[0].payload.responses.pool,true);assert.equal(f.writes[0].payload.notes,'preserve me');
});
test('missing Pool Log produces prompt response and no mutation',async()=>{
 const f=fixture();const r=await f.run({itemId:'pool'});assert.equal(r.status,409);assert.equal(r.data.poolRequired,true);assert.equal(f.writes.length,0);
});
test('completed Pool Log permits locked, attributed completion',async()=>{
 const f=fixture({logs:[{ph_am:7.4,sanitizer_band_am:'3-5',main_drain_visible:true,filter_backwashed:false}]});
 assert.equal((await f.run({itemId:'pool'})).status,200);assert.equal(f.writes[0].payload.task_states.pool.poolSubmitted,true);
});
test('lost compare-and-swap reports conflict rather than success',async()=>{
 const f=fixture({conflict:true});assert.equal((await f.run()).status,409);
});

test('membership capability restrictions still deny technician mutation',async()=>{
 const f=fixture({canEdit:false});assert.equal((await f.run()).status,403);assert.equal(f.writes.length,0);
});
