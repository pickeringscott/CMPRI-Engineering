import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/app/api/hours-tracker/route.ts',import.meta.url),'utf8');
function route(auth,store={}) {
  const exports={};
  class HoursStoreError extends Error { constructor(message,status){super(message);this.status=status;} }
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Response,Error,require(name){
    if(name==='@/lib/server/auth')return {requireUserAttempt:async()=>auth};
    if(name==='@/lib/server/hours-tracker-store')return {HoursStoreError,...store};
    throw Error(name);
  }});
  return {...exports,HoursStoreError};
}
const request=(body)=>new Request('http://localhost/api/hours-tracker',{method:'PUT',body});
test('Hours API never reads or writes storage without authentication',async()=>{
  let calls=0;const api=route({ok:false},{readHours:()=>calls++,saveHours:()=>calls++});
  assert.equal((await api.GET(new Request('http://localhost/api/hours-tracker'))).status,401);
  assert.equal((await api.PUT(request('{}'))).status,401);assert.equal(calls,0);
});
test('Hours API passes signed-in principal and MCP restriction, returns private uncached data',async()=>{
  const auth={ok:true,admin:{},principal:{identity:{id:'owner'}},mcp:true};let calls=0;
  const api=route(auth,{readHours:async(admin,principal,mcp)=>{assert.equal(admin,auth.admin);assert.equal(principal,auth.principal);assert.equal(mcp,true);calls++;return null;}});
  const response=await api.GET(new Request('http://localhost/api/hours-tracker'));
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{saved:null});assert.equal(calls,1);
});
test('Hours API rejects malformed and oversized requests before persistence',async()=>{
  let calls=0;const api=route({ok:true},{saveHours:()=>calls++});
  assert.equal((await api.PUT(request('{'))).status,400);
  assert.equal((await api.PUT(request(' '.repeat(32001)))).status,413);assert.equal(calls,0);
});
test('Hours API preserves successful save contract and storage error statuses',async()=>{
  const saved={revision:2,document:{periods:[]}};
  const api=route({ok:true,admin:{},principal:{},mcp:false},{saveHours:async(_admin,_principal,body)=>{assert.equal(body.revision,1);return saved;}});
  assert.deepEqual(await (await api.PUT(request('{"revision":1}'))).json(),{saved});
  const failed=route({ok:true},{saveHours:async()=>{throw new Error('private database details');}});
  const response=await failed.PUT(request('{}'));assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Hours storage is unavailable.'});
});
