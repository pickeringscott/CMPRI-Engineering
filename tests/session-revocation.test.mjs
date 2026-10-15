import * as commonAreas from "../src/lib/cmpri-location-groups.ts";
// Actual modules and route handlers; external auth, database and network are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const AUTH_TABLES=new Set(['profiles','hotel_members','role_permissions']);
function fixture(config={}) {
  const state={active:true,role:'Chief Engineer',email:'same-user@example.invalid',permissions:[],...config}, calls=[];
  const db={auth:{getUser:async()=>({data:{user:state.noUser?null:{id:'same-user',email:state.email}},error:state.authError?{message:'Unavailable'}:null})},from(table){
    calls.push(table);
    const q={
      select(){
        if(table==='role_permissions') return Promise.resolve({data:state.permissions,error:state.permissionError?{message:'Unavailable'}:null});
        return q;
      },
      eq(){return q;},
      async maybeSingle(){
        if(table==='hotel_members') {
          return {data:state.noMembership?null:{user_id:'same-user',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',role:'admin',active:state.membershipActive??true},error:state.membershipError?{message:'Unavailable'}:null};
        }
        return {data:state.missingProfile?null:{id:'same-user',email:state.email,role:state.role,active:state.active},error:state.profileError?{message:'Unavailable'}:null};
      },
    };
    return q;
  }};
  const cache=new Map();
  function load(filename) {
    if(cache.has(filename))return cache.get(filename);
    const exports={};cache.set(filename,exports);
    const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    vm.runInNewContext(source,{exports,URL,Headers,AbortSignal,console,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake',CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON:'{}',CMPRI_CORPORATE_PM_SPREADSHEET_ID:'test-sheet',CMPRI_ROOM_RANKER_SPREADSHEET_ID:'test-sheet',CMPRI_ROOM_RANKER_SHEET_NAME:'ROOM RANKER'}},
      fetch:async()=>{calls.push('network');return {ok:true,status:200,text:async()=>'{"ok":true}'};},
      require(name) {if(name === "@/lib/cmpri-location-groups") return commonAreas;
        if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
        if(name==='@supabase/supabase-js')return {createClient:()=>db};
        if(name==='openai')return {default:class {constructor(){throw new Error('Unexpected AI provider access');}}};
        if(name==='server-only')return {};
        if(name==='@/lib/server/room-ranker')return {callRoomRanker:async()=>({ok:true,rooms:[]})};
        if(name==='@/lib/server/integrations-safe-mode')return {isIntegrationsSafeMode:()=>config.safeMode!==false};
        if(name==='@/lib/integrations/email-provider')return {fetchOperationalMessages:async()=>{calls.push('email-provider');return {provider:null,messages:[],truncated:false};}};
        if(name==='@/lib/integrations/email-parser')return {parseOperationalEmail:()=>({})};
        if(name==='@/lib/integrations/operations')return {mergedPurchaseStatus:()=>'',parentStatusFromShipments:()=>'',matchEnseoWorkOrder:()=>null};
        if(name==='@/lib/server/corporate-pm')return {
          CORPORATE_PM_MONTHS:['JAN','FEB','MAR','APR','MAY','JUNE','JULY','AUG','SEPT','OCT','NOV','DEC'],
          readCorporatePmSheet:async sheet=>({ok:true,sheet,values:[],formulas:[],lastRow:0,lastColumn:0,timestamp:new Date().toISOString()}),
          readCorporatePmRoom:async room=>({ok:true,room,tasks:[]}),
          setCorporatePmCheckbox:async()=>({ok:true}),
        };
        if(name.startsWith('@/')||name.startsWith('.')) {
          let file=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(filename),name);
          if(!existsSync(file))file=file.replace(/\.ts$/,'')+'.ts';
          return load(file);
        }
        throw new Error(`Unexpected external module ${name}`);
      },
    });return exports;
  }
  return {state,calls,load:relative=>load(path.join(root,relative.startsWith('api/')?'app/'+relative:relative)),request:{url:'https://test.invalid/api/test',headers:new Headers({authorization:'Bearer same-token'}),json:async()=>({action:'refresh-engineering-dashboard',id:'test',status:'Received'})}};
}
const invalid=[{active:false},{active:null},{missingProfile:true},{authError:true},{profileError:true},{noUser:true}];
for(const config of invalid)test(`shared authentication rejects ${JSON.stringify(config)}`,async()=>{
  const f=fixture(config);assert.equal(await f.load('lib/server/request-auth.ts').authenticatedUser(f.request),null);
  assert.equal(f.calls.includes('network'),false);
});
test('same bearer token is rechecked and denied immediately after profile deactivation',async()=>{
  const f=fixture(),auth=f.load('lib/server/request-auth.ts');
  assert.ok(await auth.authenticatedUser(f.request));
  f.state.active=false;
  assert.equal(await auth.authenticatedUser(f.request),null);
  assert.equal(f.calls.filter(v=>v==='profiles').length,2);
});
test('safe-mode email scan is blocked before invoking the mailbox provider',async()=>{
  const f=fixture({role:'Chief Engineer',permissions:[{role:'Chief Engineer',permission:'manage_integrations',allowed:true}]});
  const response=await f.load('api/integrations/email/scan/route.ts').POST(f.request);
  assert.equal(response.status,503);
  assert.equal(response.body.safeMode,true);
  assert.equal(response.body.blocked,true);
  assert.match(response.body.error,/NOT sent to an external provider/);
  assert.equal(f.calls.includes('email-provider'),false);
});
const routes=[['api/room-ranker/route.ts','GET'],['api/room-ranker/route.ts','PATCH'],['api/corporate-pm/route.ts','GET'],['api/corporate-pm/route.ts','PATCH'],['api/work-orders/[id]/preventive-maintenance/route.ts','PATCH'],['api/engineering/operations/route.ts','GET'],['api/engineering/operations/route.ts','PATCH'],['api/work-orders/[id]/activity/route.ts','GET'],['api/integrations/email/scan/route.ts','POST'],['api/work-orders/route.ts','POST']];
for(const [route,method] of routes)for(const config of [{active:false},{profileError:true}])test(`${route} ${method} blocks revoked/unverifiable session ${JSON.stringify(config)}`,async()=>{
  const f=fixture(config);const r=await f.load(route)[method](f.request,{params:Promise.resolve({id:'test'})});
  assert.equal(r.status,401);assert.ok(f.calls.every(v=>v==='profiles'),'No downstream data, network or provider access');
});
for(const route of ['api/room-ranker/route.ts','api/corporate-pm/route.ts'])test(`${route} active read succeeds, same token is denied after deactivation`,async()=>{
  const f=fixture({role:'System Administrator',email:route.includes('room-ranker')?'maint.cmpri@hawkeyehotels.com':'same-user@example.invalid',permissions:[{role:'Chief Engineer',permission:'manage_integrations',allowed:true}]}),handlers=f.load(route);const first=await handlers.GET(f.request);assert.equal(first.status,200);assert.equal(first.body.can_edit,route.includes('corporate-pm')?false:true);
  f.state.active=false;f.calls.length=0;
  assert.equal((await handlers.GET(f.request)).status,401);assert.equal(f.calls.includes('network'),false);
});
for(const [route,method] of routes.filter(([route,method])=>method==='PATCH'||route.includes('/email/')))for(const role of ['Front Desk','Housekeeping','unknown-admin'])test(`${route} denies integration writes by ${role}`,async()=>{
  const f=fixture({role}),r=await f.load(route)[method](f.request,{params:Promise.resolve({id:'test'})});
  assert.equal(r.status,403);assert.ok(f.calls.every(v=>AUTH_TABLES.has(v)));
});
for(const route of ['api/room-ranker/route.ts','api/corporate-pm/route.ts'])test(`${route} denies housekeeping read access (dashboard required)`,async()=>{
  const f=fixture({role:'Housekeeping'});const r=await f.load(route).GET(f.request);assert.equal(r.status,403);assert.ok(f.calls.every(v=>AUTH_TABLES.has(v)));
});

for(const config of [{noMembership:true},{membershipActive:false},{membershipError:true}])test(`active profile cannot use CMPRI without active property membership: ${JSON.stringify(config)}`,async()=>{
 const f=fixture(config);assert.equal(await f.load('lib/server/request-auth.ts').authenticatedUser(f.request),null);assert.equal(f.calls.includes('network'),false);
});
test('the same token is rejected after property membership revocation',async()=>{
 const f=fixture(),auth=f.load('lib/server/request-auth.ts');assert.ok(await auth.authenticatedUser(f.request));f.state.membershipActive=false;assert.equal(await auth.authenticatedUser(f.request),null);
});
test('Room Ranker is available to the requested viewers and Scott, but not other engineer/admin accounts',async()=>{
 for (const role of ['Front Desk Manager','Assistant General Manager','Maintenance Technician','General Manager']) {
   const f=fixture({role});
   const response=await f.load('api/room-ranker/route.ts').GET(f.request);
   assert.equal(response.status,200,role);
   assert.equal(response.body.can_edit,false,role);
   assert.equal(f.calls.includes('network'),false,role);
 }
 for (const role of ['Chief Engineer','System Administrator']) {
   const f=fixture({role,email:role==='System Administrator'?'pickering.scott@gmail.com':'same-user@example.invalid'});
   assert.equal((await f.load('api/room-ranker/route.ts').GET(f.request)).status,403,role);
   assert.equal(f.calls.includes('network'),false,role);
 }
 const scott=fixture({role:'System Administrator',email:'maint.cmpri@hawkeyehotels.com'});
 const scottResponse=await scott.load('api/room-ranker/route.ts').GET(scott.request);
 assert.equal(scottResponse.status,200);
 assert.equal(scottResponse.body.can_edit,true);
});
