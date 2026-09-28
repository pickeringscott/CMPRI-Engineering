import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root=fileURLToPath(new URL('../src/',import.meta.url));
function fixture(route,body,config={}) {
  const calls=[];
  function load(filename) {
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
      exports,URL,AbortSignal,process:{env:{CMPRI_INTEGRATIONS_SAFE_MODE:'false',CMPRI_ROOM_RANKER_API_KEY:'fake',CMPRI_ROOM_RANKER_API_URL:'https://test.invalid/api',CMPRI_CORPORATE_PM_API_KEY:'fake',CMPRI_CORPORATE_PM_API_URL:'https://test.invalid/api',...(config.env||{})}},
      fetch:async(url,init={})=>{calls.push({url:String(url),...init});return {ok:true,status:200,text:async()=>JSON.stringify(config.upstream || {ok:true,sheet:'JAN',values:[['Header'],['Task','FALSE']],formulas:[[''],['','']]})};},
      require(name){
        if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
        if(name==='@/lib/server/request-auth')return {authenticatedUser:async()=>({profile:{active:true,role:'Chief Engineer'}})};
        if(name==='server-only')return {};
        if(name==='@supabase/supabase-js')return {createClient:()=>({})};
        if(name==='@/lib/server/auth'){const p={principal:{identity:{id:'actor'},profile:{active:true,role:'Chief Engineer'},membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:{}};return {requireUser:async()=>p,requireCapability:async()=>p}}
        if(name==='@/lib/server/access')return {allows:()=>true};
        let file=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(filename),name);
        if(!existsSync(file))file+='.ts';return load(file);
      },
    });return exports;
  }
  return {calls,handler:load(path.join(root,'app/api',route,'route.ts')).PATCH,request:{json:async()=>{if(config.badJson)throw new SyntaxError('Invalid JSON');return body;}}};
}
const ranker={rowNumber:2,expectedRoom:'409',rank:'A',notes:'Reviewed'};
const checkbox={action:'setcheckbox',sheet:'JAN',row:2,column:2,checked:true};
for(const route of ['room-ranker','corporate-pm'])for(const body of [null,[],{},42])test(`${route} rejects malformed body ${JSON.stringify(body)} before upstream access`,async()=>{
  const f=fixture(route,body);assert.equal((await f.handler(f.request)).status,400);assert.equal(f.calls.length,0);
});
for(const route of ['room-ranker','corporate-pm'])test(`${route} rejects broken JSON`,async()=>{
  const f=fixture(route,null,{badJson:true});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.calls.length,0);
});
for(const [route,env,body,setting] of [
  ['room-ranker',{CMPRI_ROOM_RANKER_API_URL:undefined,CMPRI_ROOM_RANKER_API_KEY:undefined}, {rowNumber:2,expectedRoom:'409',rank:'A'}, 'CMPRI_ROOM_RANKER_API_URL'],
  ['corporate-pm',{CMPRI_CORPORATE_PM_API_URL:undefined,CMPRI_CORPORATE_PM_API_KEY:undefined}, {action:'setcheckbox',sheet:'JAN',row:2,column:2,checked:true}, 'CMPRI_CORPORATE_PM_API_URL'],
])test(`${route} reports missing deployment settings without contacting a placeholder`,async()=>{
  const f=fixture(route,body,{env});const response=await f.handler(f.request);
  assert.equal(response.status,503);assert.match(response.body.error,new RegExp(setting));assert.equal(f.calls.length,0);
});
for(const patch of [{rowNumber:0},{rowNumber:2.5},{rowNumber:'2'},{expectedRoom:''},{rank:'Z'},{notes:{text:'x'}},{notes:'=IMPORTXML("https://example.invalid","x")'}])test(`ranker validates target/text ${JSON.stringify(patch)}`,async()=>{
  const f=fixture('room-ranker',{...ranker,...patch});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.calls.length,0);
});
for(const patch of [{row:0},{column:-1},{row:1.5},{checked:'false'},{checked:null},{sheet:''},{action:'unsupported'}])test(`PM validates target/checkbox ${JSON.stringify(patch)}`,async()=>{
  const f=fixture('corporate-pm',{...checkbox,...patch});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.calls.length,0);
});
test('ranker forwards only editable fields and the expected room',async()=>{
  const f=fixture('room-ranker',{...ranker,apiKey:'attacker',action:'delete',room:'999'});
  assert.equal((await f.handler(f.request)).status,200);const sent=JSON.parse(f.calls[0].body);
  assert.equal(sent.apiKey,'fake');assert.equal(sent.action,'update');assert.equal(sent.expectedRoom,'409');assert.equal('room' in sent,false);
});
test('PM verifies the current cell before a boolean write',async()=>{
  const f=fixture('corporate-pm',checkbox);assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].method,undefined);assert.equal(JSON.parse(f.calls[1].body).checked,true);
});
for(const upstream of [
  {ok:true,sheet:'JAN',values:[['Header'],['Task','FALSE']],formulas:[[''],['','=A1']]},
  {ok:true,sheet:'JAN',values:[['Header'],['Task','Text']],formulas:[[''],['','']]},
  {ok:true,sheet:'FEB',values:[['Header'],['Task','FALSE']],formulas:[[''],['','']]},
  {ok:true,sheet:'JAN',values:[['Header'],['Task','FALSE']]},
])test(`PM refuses non-checkbox/formula/wrong-sheet snapshot ${JSON.stringify(upstream)}`,async()=>{
  const f=fixture('corporate-pm',checkbox,{upstream});assert.equal((await f.handler(f.request)).status,409);assert.equal(f.calls.length,1);
});
test('PM preserves an explicit false checkbox value',async()=>{
  const f=fixture('corporate-pm',{...checkbox,checked:false});assert.equal((await f.handler(f.request)).status,200);
  assert.equal(JSON.parse(f.calls[1].body).checked,false);
});
for(const completedDate of ['2026-02-30','2026-13-01','yesterday'])test(`PM rejects invalid completion date ${completedDate}`,async()=>{
  const f=fixture('corporate-pm',{action:'completeroompm',room:'409',quarter:'Q1',completedDate});
  assert.equal((await f.handler(f.request)).status,400);assert.equal(f.calls.length,0);
});
