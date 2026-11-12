import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync('src/app/api/room-operations/guest-reports/drive/route.ts','utf8');
function fixture({allowed=true,hotel='cmpri',safe=false,historyError=false,rows=[],failure,noFiles=false,validationError=false,commitError=false}={}){
 const calls=[];const exports={};
 const json=(body,options={})=>({body,status:options.status||200,ok:!options.status||options.status<400,headers:new Headers(options.headers),json:async()=>body});
 class DriveAccessError extends Error{};class DriveRoomReportError extends Error{};
 const admin={from(table){calls.push({table});return {select(){return this},eq(key,value){calls.push({key,value});return this},order(){return this},limit(){return Promise.resolve({data:[{source_rows:rows}],error:historyError?{}:null})}}}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Array,Error,URL,require(name){
  if(name==='@/lib/server/import-response')return {importResponseBody:async(_admin,_hotel,_actor,body)=>body};
  if(name==='next/server')return {NextRequest:Request,NextResponse:{json}};
  if(name==='../route')return {POST:async request=>{const body=await request.json();calls.push({importBody:body});if(body.validateOnly&&validationError)return json({error:'Invalid CSV columns'},{status:422});if(!body.validateOnly&&commitError)return json({error:'Report changed'},{status:409});return json(body.validateOnly?{previousId:'accepted'}:{ok:true,import_id:'saved',date:'2026-11-08',rows:[]})}};
  if(name==='@/lib/server/auth')return {requireCapability:async(_req,cap)=>{assert.equal(cap,'edit_tickets');return allowed?{admin,principal:{hotelId:hotel,identity:{id:"actor"}}}:null}};
  if(name==='@/lib/constants')return {HOTEL_ID:'cmpri',HOTEL_TIME_ZONE:'America/Chicago'};
  if(name==='@/lib/room-operations-reports')return {hotelDateAt:()=> '2026-11-08'};
  if(name==='@/lib/server/integrations-safe-mode')return {isIntegrationsSafeMode:()=>safe};
  if(name==='@/lib/room-report-drive')return {DriveRoomReportError};
  if(name==='@/lib/server/drive-po-api')return {DriveAccessError};
  if(name==='@/lib/server/drive-room-reports')return {fetchNewerDriveRoomReports:async(previous,today)=>{calls.push({previous,today});if(failure)throw Error('secret detail');return noFiles?[]:[{name:'fixture.csv',text:'a,b'}]}};
  throw Error(name);
 }});
 return {calls,run:()=>exports.GET({}),post:()=>exports.POST(new Request("https://cmpri.test/api/room-operations/guest-reports/drive",{method:"POST",headers:{Authorization:"Bearer fixture"}}))};
}
for(const config of [{allowed:false},{hotel:'foreign'},{safe:true}])test(`denies unauthorized, foreign-hotel or safe-mode Drive acquisition ${JSON.stringify(config)}`,async()=>{
 const f=fixture(config);const result=await f.run();assert.ok([403,503].includes(result.status));assert.deepEqual(f.calls,[]);
});
test('server derives per-type accepted baselines from property history and performs no writes',async()=>{
 const previous={guests:{name:'accepted'},arrivals:{name:'accepted-arrival'}};
 const f=fixture({rows:[{guest_report_bundle:previous}]});const r=await f.run();assert.equal(r.status,200);assert.match(r.headers.get('Cache-Control'),/no-store/);assert.equal(r.body.files.length,1);assert.deepEqual(f.calls.at(-1),{previous,today:'2026-11-08'});assert.deepEqual(f.calls[1],{key:'hotel_id',value:'cmpri'});
});
test('unavailable history prevents Drive reads',async()=>{const f=fixture({historyError:true});assert.equal((await f.run()).status,502);assert.equal(f.calls.some(c=>c.today),false)});
test('unexpected provider failure is redacted',async()=>{const f=fixture({failure:true});const r=await f.run();assert.equal(r.status,502);assert.equal(JSON.stringify(r).includes('secret detail'),false)});

test('Drive POST validates then commits immediately with the returned previous id and timing headers',async()=>{
 const f=fixture();const result=await f.post();assert.equal(result.status,200);assert.equal(result.body.import_id,'saved');
 const imports=f.calls.filter(c=>c.importBody).map(c=>c.importBody);
 assert.equal(imports.length,2);assert.equal(imports[0].validateOnly,true);assert.equal(imports[1].validateOnly,false);assert.equal(imports[1].previousId,'accepted');
 assert.match(result.headers.get('Server-Timing'),/drive_fetch;dur=.*validation;dur=.*save;dur=/);
 assert.ok(Number(result.headers.get('X-CMPRI-Import-Duration-Ms'))>=0);
});
test('Drive POST returns validation or concurrency reasons without another save attempt',async()=>{
 const invalid=fixture({validationError:true});const result=await invalid.post();assert.equal(result.status,422);assert.match(result.body.error,/CSV columns/);assert.equal(invalid.calls.filter(c=>c.importBody).length,1);
 const changed=fixture({commitError:true});assert.equal((await changed.post()).status,409);assert.equal(changed.calls.filter(c=>c.importBody).length,2);
 const empty=fixture({noFiles:true});assert.equal((await empty.post()).body.imported,false);assert.equal(empty.calls.filter(c=>c.importBody).length,0);
});
