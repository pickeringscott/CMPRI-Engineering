import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadTs } from './helpers/load-ts.mjs';
const roles=loadTs('src/lib/server/roles.ts');
const access=loadTs('src/lib/server/access.ts');
const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
class NextRequest extends Request {get nextUrl(){return new URL(this.url)}}
function fixture({role='Maintenance Technician',secondary=[],write=true,active=true,memberActive=true,membership='technician',readAll=false,apiStatus=200}={}){
 const principal={identity:{id:'mock-user',email:'mock@example.invalid'},profile:{id:'mock-user',email:'mock@example.invalid',full_name:'Sample User',role,secondary_roles:secondary,active},hotelId:hotel,membership:{user_id:'mock-user',hotel_id:hotel,active:memberActive,role:membership},permissions:[]};
 const calls=[],filters=[];
 const admin={from(table){assert.equal(table,'pool_facilities');const query={select(){return query},eq(k,v){filters.push([k,v]);return query},then(resolve,reject){return Promise.resolve({data:[{id:'facility',pool_name:'Indoor Pool'}],error:null}).then(resolve,reject)}};return query}};
 const identity={principal,admin,canWrite:write,readAllWorkOrders:readAll,readAssignedWorkOrders:false,readOwnWorkOrders:false};
 const handler=async request=>{calls.push({method:request.method,url:request.url,authorization:request.headers.get('authorization'),body:request.method==='POST'?await request.json():null});return Response.json(apiStatus===200?{ok:true}:{error:'Current pool authorization rejected'},{status:apiStatus})};
 const deps={'server-only':{},'next/server':{NextRequest},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/access':access,'@/lib/server/roles':roles,'@/lib/room-ranker-access':{canViewRoomRanker:()=>false,canEditRoomRanker:()=>false},'@/lib/server/room-operations-import-schema':{},'./hours-tracker-mcp':{canUseHoursMcp:()=>false},'@/lib/server/hours-clock-policy':{hoursClockEnabled:()=>false},'@/lib/ai/mcp-write-input':{},'@/lib/pool-log':{prepareMcpPoolLogInput:(input,facilities)=>({...input,pool_facility_id:facilities[0].id})},'@/app/api/pool-log/route':{GET:handler,POST:handler}};
 function load(file){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/server/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,URL,URLSearchParams,Request,Response,require(name){assert.ok(name in deps,name);return deps[name]}});return exports;}
 const reads=load('cmpri-mcp-reads.ts'),writes=load('cmpri-mcp-writes.ts');
 const incoming=new NextRequest('https://local.invalid/api/mcp',{headers:{Authorization:'Bearer synthetic-mcp-token'}});
 return {identity,calls,filters,views:()=>reads.availableMcpReadViews(identity),actions:()=>writes.availableMcpWriteActions(identity).map(a=>a.action),read:()=>reads.callMcpReadView(incoming,identity,'pool_log',{date:'2026-10-15'}),save:()=>writes.callMcpWriteAction(incoming,identity,'pool_log.save',{date:'2026-10-15',pool:'Indoor Pool'})};
}
for(const config of [{role:'Maintenance Technician'},{role:'Front Desk Manager'},{role:'Assistant General Manager'},{role:'General Manager',membership:'manager'},{role:'Chief Engineer',membership:'admin'},{role:'system_admin',secondary:['Engineer'],membership:'admin'},{role:'Maintenance Technician',secondary:['Chief Engineer']}]){
 test(`${config.role} ${config.secondary||''}: pool discovery and execution use existing pool capabilities`,async()=>{
  const f=fixture(config);assert.equal(access.allows(f.identity.principal,'operate_pool_log'),true);assert.equal(f.identity.readAllWorkOrders,false);
  assert.equal(f.views().filter(v=>v==='pool_log').length,1);assert.ok(f.actions().includes('pool_log.save'));
  if(config.role!=='system_admin')assert.equal(access.allows(f.identity.principal,'operate_integrations'),false);
  assert.deepEqual(await f.read(),{ok:true});assert.equal((await f.save()).status,200);
  assert.deepEqual(f.calls.map(c=>c.method),['GET','POST']);assert.ok(f.calls.every(c=>c.authorization==='Bearer synthetic-mcp-token'));
  assert.deepEqual(f.filters,[['hotel_id',hotel],['active',true]]);assert.equal(f.calls[1].body.pool_facility_id,'facility');
 });
 test(`${config.role}: read-only token advertises no writes and rejects execution before storage`,async()=>{
  const f=fixture({...config,write:false});assert.ok(f.views().includes('pool_log'));assert.deepEqual(Array.from(f.actions()),[]);await f.read();await assert.rejects(f.save,/read-only/);assert.equal(f.filters.length,0);assert.equal(f.calls.length,1);
 });
}
for(const config of [{role:'Front Desk'},{role:'Lead Housekeeper'},{role:'unknown'},{active:false},{memberActive:false},{role:'Front Desk Manager',membership:'viewer'}])test(`unauthorized pool identity fails closed ${JSON.stringify(config)}`,async()=>{
 const f=fixture({...config,readAll:true});assert.ok(!f.views().includes('pool_log'));assert.ok(!f.actions().includes('pool_log.save'));await assert.rejects(f.read,/not permitted/);await assert.rejects(f.save,/not permitted/);assert.equal(f.calls.length,0);assert.equal(f.filters.length,0);
});
test('dashboard oversight may read pool but does not acquire pool write permission',async()=>{
 const f=fixture({role:'Senior Management',membership:'viewer'});assert.ok(f.views().includes('pool_log'));assert.ok(!f.actions().includes('pool_log.save'));await f.read();await assert.rejects(f.save,/not permitted/);
});
test('permissions are evaluated again at execution; downstream API revocation stays authoritative',async()=>{
 const f=fixture();assert.ok(f.actions().includes('pool_log.save'));f.identity.principal.profile.active=false;await assert.rejects(f.save,/not permitted/);assert.equal(f.filters.length,0);
 const denied=fixture({apiStatus:403});await assert.rejects(denied.read,/Current pool authorization rejected/);const result=await denied.save();assert.equal(result.status,403);assert.equal(result.body.error,'Current pool authorization rejected');
});
