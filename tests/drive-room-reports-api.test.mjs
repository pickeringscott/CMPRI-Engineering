import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync('src/app/api/room-operations/guest-reports/drive/route.ts','utf8');
function fixture({allowed=true,hotel='cmpri',safe=false,historyError=false,rows=[],failure}={}){
 const calls=[];const exports={};
 class DriveAccessError extends Error{};class DriveRoomReportError extends Error{};
 const admin={from(table){calls.push({table});return {select(){return this},eq(key,value){calls.push({key,value});return this},order(){return this},limit(){return Promise.resolve({data:[{source_rows:rows}],error:historyError?{}:null})}}}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Array,Error,require(name){
  if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,status:options.status||200,headers:options.headers})}};
  if(name==='@/lib/server/auth')return {requireCapability:async(_req,cap)=>{assert.equal(cap,'edit_tickets');return allowed?{admin,principal:{hotelId:hotel}}:null}};
  if(name==='@/lib/constants')return {HOTEL_ID:'cmpri',HOTEL_TIME_ZONE:'America/Chicago'};
  if(name==='@/lib/room-operations-reports')return {hotelDateAt:()=> '2026-11-08'};
  if(name==='@/lib/server/integrations-safe-mode')return {isIntegrationsSafeMode:()=>safe};
  if(name==='@/lib/room-report-drive')return {DriveRoomReportError};
  if(name==='@/lib/server/drive-po-api')return {DriveAccessError};
  if(name==='@/lib/server/drive-room-reports')return {fetchNewerDriveRoomReports:async(previous,today)=>{calls.push({previous,today});if(failure)throw Error('secret detail');return [{name:'fixture.csv',text:'a,b'}]}};
  throw Error(name);
 }});
 return {calls,run:()=>exports.GET({})};
}
for(const config of [{allowed:false},{hotel:'foreign'},{safe:true}])test(`denies unauthorized, foreign-hotel or safe-mode Drive acquisition ${JSON.stringify(config)}`,async()=>{
 const f=fixture(config);const result=await f.run();assert.ok([403,503].includes(result.status));assert.deepEqual(f.calls,[]);
});
test('server derives per-type accepted baselines from property history and performs no writes',async()=>{
 const previous={guests:{name:'accepted'},arrivals:{name:'accepted-arrival'}};
 const f=fixture({rows:[{guest_report_bundle:previous}]});const r=await f.run();assert.equal(r.status,200);assert.match(r.headers['Cache-Control'],/no-store/);assert.equal(r.body.files.length,1);assert.deepEqual(f.calls.at(-1),{previous,today:'2026-11-08'});assert.deepEqual(f.calls[1],{key:'hotel_id',value:'cmpri'});
});
test('unavailable history prevents Drive reads',async()=>{const f=fixture({historyError:true});assert.equal((await f.run()).status,502);assert.equal(f.calls.some(c=>c.today),false)});
test('unexpected provider failure is redacted',async()=>{const f=fixture({failure:true});const r=await f.run();assert.equal(r.status,502);assert.equal(JSON.stringify(r).includes('secret detail'),false)});
