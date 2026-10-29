import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const json=(data,init={})=>({status:init.status??200,headers:init.headers,json:async()=>data});
function load(path,imports){
  const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{if(!(name in imports))throw Error(name);return imports[name];},console});return exports;
}
test('combined endpoint verifies once per request, preserves resource errors and never caches auth',async()=>{
  let checks=0,allowed=true;const received=[];
  const auth={principal:{identity:{id:'alice'}},admin:{}};
  const route=load('src/app/api/dashboard/refresh/route.ts',{
    'next/server':{NextResponse:{json}},
    '@/lib/server/auth':{requireUser:async()=>{checks++;return allowed?auth:null;}},
    '@/lib/server/dashboard-notifications':{getDashboardNotifications:async(_req,verified)=>{received.push(verified);return json({error:'Dashboard access is required.'},{status:403});}},
    '@/lib/server/pool-status-response':{getPoolStatus:async(_req,verified)=>{received.push(verified);return json({closed:true,manual_closed:true});}},
  });
  const request={nextUrl:new URL('http://localhost/api/dashboard/refresh?resource=notifications&resource=pool&resource=pool')};
  const result=await route.GET(request),body=await result.json();
  assert.equal(checks,1);assert.equal(received.length,2);received.forEach(a=>assert.equal(a,auth));
  assert.equal(body.notifications.status,403);assert.equal(body.pool.data.manual_closed,true);
  assert.equal(result.headers['Cache-Control'],'private, no-store');
  allowed=false;assert.equal((await route.GET(request)).status,401);assert.equal(checks,2);assert.equal(received.length,2);
  assert.equal((await route.GET({nextUrl:new URL('http://localhost/?resource=other')})).status,400);assert.equal(checks,2);
});

test('notification service retains authorization when called with request-local identity',async()=>{
  let checks=0,queries=0;
  const service=load('src/lib/server/dashboard-notifications.ts',{
    'next/server':{NextResponse:{json}},'@/lib/constants':{HOTEL_ID:'hotel'},
    '@/lib/server/auth':{requireUser:async()=>{checks++;return null;}},
    '@/lib/server/access':{allows:()=>false},'@/lib/server/roles':{},
    '@/lib/notifications/web-push':{},'@/lib/notifications/event-eligibility':{},'@/lib/dashboard/work-order-notifications':{},
  });
  assert.equal((await service.getDashboardNotifications({})).status,401);
  assert.equal((await service.getDashboardNotifications({}, {principal:{},admin:{from:()=>queries++}})).status,403);
  assert.equal(checks,1);assert.equal(queries,0);
});

test('pool service retains unknown-role gate before reading or reconciling',async()=>{
  let checks=0,queries=0;
  const service=load('src/lib/server/pool-status-response.ts',{
    'next/server':{NextResponse:{json}},'@/lib/constants':{HOTEL_ID:'hotel'},
    '@/lib/server/auth':{requireUser:async()=>{checks++;return null;}},
    '@/lib/server/roles':{roleKey:()=> 'unknown'},'@/lib/pool-log':{},
  });
  assert.equal((await service.getPoolStatus({})).status,401);
  assert.equal((await service.getPoolStatus({}, {principal:{profile:{role:'unknown'}},admin:{from:()=>queries++}})).status,401);
  assert.equal(checks,1);assert.equal(queries,0);
});
