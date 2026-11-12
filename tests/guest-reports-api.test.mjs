import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import * as reports from '../src/lib/room-guest-reports.ts';
import {hotelDateAt} from '../src/lib/room-operations-reports.ts';
const today=new Date().toISOString().slice(0,10);
const guest={name:`In House Guest List Details_CMPRI_${today}_10-00-00.csv`,text:`ROOM NUMBER,GUEST NAME,ARRIVAL,DEPARTURE,NIGHTS,GROUP NAME\n101,Jane Doe,${today},${today},0,Big Ten Team`};
const arrivals={name:`Housekeeping Arrivals_CMPRI_${today}_10-00-00.csv`,text:'ROOM NUMBER,GUEST NAME,GROUP NAME,COMMENTS\n101,Sam Guest,Big Ten Visitors,a\n101,Sam Guest,Big Ten Visitors,b'};
const departures={name:`Housekeeping Departures_CMPRI_${today}_10-00-00.csv`,text:'ROOM #,GUEST NAME,DEPARTURE TIME\n101,Jane Doe,13:00'};
const source=readFileSync(new URL('../src/app/api/room-operations/guest-reports/route.ts',import.meta.url),'utf8');
function harness({allowed=true,history=[]}={}){
 const writes=[];
 const admin={from(table){return {select(){return this},eq(){return this},order(){return this},limit(){return this},then(resolve){resolve({data:table==='locations'?[{room_number:'101'}]:history,error:null})}}},async rpc(name,args){writes.push({name,args});return {data:'saved-id',error:null}}};
 const auth={admin,principal:{hotelId:'test-hotel',identity:{id:'test-user'},profile:{full_name:'Test'}}};
 const routeModule={exports:{}};
 const require=name=>{
  if(name==='@/lib/server/import-response')return {importResponseBody:async(_admin,_hotel,_actor,body)=>body};
  if(name==='@/lib/server/import-upload')return {readImportUpload:async()=>{throw Error('Unexpected staged upload')}};
  if(name==='next/server')return {NextResponse:{json:(body,options={})=>({body,status:options.status||200})}};
  if(name==='node:crypto')return {createHash};
  if(name==='@/lib/server/auth')return {requireCapability:async()=>allowed?auth:null};
  if(name==='@/lib/constants')return {HOTEL_TIME_ZONE:'UTC'};
  if(name==='@/lib/room-operations-reports')return {hotelDateAt};
  if(name==='@/lib/room-guest-reports')return reports;
  throw Error(name);
 };
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:routeModule,exports:routeModule.exports,require,TextEncoder,TextDecoder});
 return {writes,run:body=>routeModule.exports.POST({json:async()=>body})};
}
test('unauthorized import denied without writes',async()=>{const h=harness({allowed:false});assert.equal((await h.run({files:[guest]})).status,403);assert.equal(h.writes.length,0)});
test('three-report preview normalizes departures and arrivals without saving',async()=>{const h=harness();const r=await h.run({files:[guest,arrivals,departures],validateOnly:true});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(h.writes.length,0);assert.equal(r.body.rows[0].checkout_time,'13:00:00');assert.equal(r.body.rows[0].incoming_company,'Big Ten Visitors')});
test('confirmed import uses one atomic RPC; stale review refuses save',async()=>{
 const h=harness();const r=await h.run({files:[guest,arrivals,departures],previousId:null});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(h.writes.length,1);assert.equal(h.writes[0].name,'cmpri_commit_guest_reports');assert.equal(h.writes[0].args.p_rows[0].guest_report_bundle.arrivals.rows.length,2);
 const stale=harness();assert.equal((await stale.run({files:[guest],previousId:'old-id'})).status,409);assert.equal(stale.writes.length,0);
});
test('different incoming guests reject entire batch',async()=>{const h=harness();const r=await h.run({files:[guest,{...arrivals,text:arrivals.text+'\n101,Other Guest,Other,c'}],previousId:null});assert.equal(r.status,422);assert.equal(h.writes.length,0)});
for (const route of ['guest-reports/extract', 'extract']) {
 test(`${route} refuses image extraction without reading or transmitting reports even when a key exists`, async () => {
  const source = readFileSync(new URL(`../src/app/api/room-operations/${route}/route.ts`, import.meta.url), 'utf8');
  for (const allowed of [true, false]) {
   let reads = 0, calls = 0, checks = 0;
   const exports = {};
   const request = { formData: async () => { reads++; throw Error('report body must not be read'); }, json: async () => { reads++; throw Error('report body must not be read'); } };
   vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports,
    process: { env: { OPENAI_API_KEY: 'unused-test-key' } },
    fetch: async () => { calls++; throw Error('disabled extraction must not call a provider'); },
    require(name) {
     if (name === 'next/server') return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) } };
     if (name === '@/lib/server/auth') return { requireCapability: async (actual, capability) => { checks++; assert.equal(actual, request); assert.equal(capability, 'edit_tickets'); return allowed ? {} : null; } };
     throw Error(`Unexpected route dependency: ${name}`);
    },
   });
   const result = await exports.POST(request);
   assert.equal(result.status, allowed ? 410 : 403);
   if (allowed) assert.match(result.body.error, /disabled.*CSV/i);
   assert.equal(checks, 1);
   assert.equal(reads, 0);
   assert.equal(calls, 0);
  }
 });
}
test('unassigned arrival rows and repeated Preferences commit one incoming stay through the real parser',async()=>{
 const file={...arrivals,text:'ROOM NUMBER,GUEST NAME,PREFERENCES\n,Unassigned Guest,High floor\n101,Sam Guest,High floor\n101,Sam Guest,Extra pillows'};
 const h=harness();const r=await h.run({files:[guest,file],previousId:null});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(h.writes.length,1);assert.equal(r.body.rows[0].incoming_name,'Sam Guest');assert.equal(r.body.rows.length,1);
});
