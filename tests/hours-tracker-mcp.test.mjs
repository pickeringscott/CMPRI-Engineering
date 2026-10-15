import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/lib/hours-tracker.ts';
const owner='750f77bf-7d5d-4ca6-8421-e025edea87ba';
function load(file,deps={}) {const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,structuredClone,Response,URL,require:n=>{if(n in deps)return deps[n];throw Error(n);}});return exports;}
const roles=load('lib/server/roles.ts');
const store=load('lib/server/hours-tracker-store.ts',{'./roles':roles,'../hours-tracker':core});
const adapter=load('lib/server/hours-tracker-mcp.ts',{'./hours-tracker-store':store});
const period=start=>({start,days:core.emptyPeriod(start),rateCents:2229,deductionPercent:22});
function fixture(id=owner) {
 let saved=null,calls=0;
 const admin={from(){calls++;let data,revision;const q={select(){return q;},eq(k,v){if(k==='owner_id')assert.equal(v,owner);else revision=v;return q;},insert(v){data=v;return q;},update(v){data=v;return q;},async maybeSingle(){if(data){if(revision!==undefined&&revision!==saved.revision)return {data:null,error:null};saved=structuredClone({document:data.document,revision:data.revision});}return {data:structuredClone(saved),error:null};}};return q;}};
 const principal={identity:{id,email:'maint.cmpri@hawkeyehotels.com'},profile:{id,email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:['engineer'],active:true},membership:{user_id:id,hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',role:'admin',active:true},hotelId:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'};
 return {identity:{admin,principal,canWrite:true},calls:()=>calls,seed:v=>{saved=structuredClone(v);}};
}
test('owner-only read and save; read-only scope, selector and configuration rejection before storage',async()=>{
 const f=fixture();assert.equal((await adapter.readHoursMcp(f.identity,{})).saved,null);
 for(const input of [{owner_id:owner},{date:'2026-10-02'}])await assert.rejects(()=>adapter.readHoursMcp(f.identity,input),e=>e.status===400);
 for(const input of [{configuration:{}},{period:period('2026-10-02'),revision:0,owner_id:owner}])await assert.rejects(()=>adapter.saveHoursMcp(f.identity,input),e=>e.status===400);
 await assert.rejects(()=>adapter.saveHoursMcp({...f.identity,canWrite:false},{period:period('2026-10-02'),revision:0}),e=>e.status===403);
 const other=fixture('00000000-0000-0000-0000-000000000002');await assert.rejects(()=>adapter.readHoursMcp(other.identity,{}),e=>e.status===403);await assert.rejects(()=>adapter.saveHoursMcp(other.identity,{period:period('2026-10-02'),revision:0}),e=>e.status===403);assert.equal(other.calls(),0);
 const inactive=fixture();inactive.identity.principal.membership.active=false;assert.equal(adapter.canUseHoursMcp(inactive.identity),false);
});
test('real store through MCP preserves periods, baselines, clock state and enforces revision/rate/open-shift guards',async()=>{
 const f=fixture();const first=period('2026-09-18'),second=period('2026-10-02');
 f.seed({revision:7,document:{version:1,anchor:core.PAYROLL_ANCHOR,periods:[first,second],leaveConfigurations:[{kind:'company-pto',date:'2026-10-02',minutes:120,policy:'unconfigured'}],clock:{open:{date:'2026-10-02'},events:[]}}});
 const before=(await adapter.readHoursMcp(f.identity,{})).saved;
 first.days[0].attendance={...core.NEW_WORK};first.days[0].leave=[{kind:'company-pto',minutes:30}];
 await assert.rejects(()=>adapter.saveHoursMcp(f.identity,{period:first,revision:6}),e=>e.status===409);
 first.rateCents=2300;await assert.rejects(()=>adapter.saveHoursMcp(f.identity,{period:first,revision:7}),e=>e.status===409);
 const after=(await adapter.saveHoursMcp(f.identity,{period:first,revision:7,confirmRateChange:true})).saved;
 assert.equal(after.revision,8);assert.equal(JSON.stringify(after.document.periods[1]),JSON.stringify(before.document.periods[1]));assert.equal(JSON.stringify(after.document.leaveConfigurations),JSON.stringify(before.document.leaveConfigurations));assert.equal(JSON.stringify(after.document.clock),JSON.stringify(before.document.clock));
 await assert.rejects(()=>adapter.saveHoursMcp(f.identity,{period:first,revision:7,confirmRateChange:true}),e=>e.status===409);
 second.days[0].attendance={...core.NEW_WORK};await assert.rejects(()=>adapter.saveHoursMcp(f.identity,{period:second,revision:8}),e=>e.status===409);
});
test('discovery exposes manual read/save with clocks disabled; dispatch uses strict adapter',async()=>{
 const deps={'server-only':{},'next/server':{},'@/lib/constants':{},'@/lib/server/access':{allows:()=>false},'@/lib/server/roles':{roleKey:r=>r},'@/lib/room-ranker-access':{canViewRoomRanker:()=>false,canEditRoomRanker:()=>false},'@/lib/ai/mcp-write-input':{},'@/lib/pool-log':{},'@/lib/server/hours-clock-policy':{hoursClockEnabled:()=>false},'@/lib/server/room-operations-import-schema':{},'./hours-tracker-mcp':adapter};
 const reads=load('lib/server/cmpri-mcp-reads.ts',deps),writes=load('lib/server/cmpri-mcp-writes.ts',deps),f=fixture();
 assert.ok(reads.availableMcpReadViews(f.identity).includes('hours_tracker'));const actions=writes.availableMcpWriteActions(f.identity).map(a=>a.action);assert.ok(actions.includes('hours_tracker.save_period'));assert.ok(!actions.includes('hours_tracker.clock_in'));assert.ok(!actions.includes('hours_tracker.clock_out'));assert.equal(writes.availableMcpWriteActions({...f.identity,canWrite:false}).length,0);
 const incoming={headers:{get:n=>n==='authorization'?'Bearer synthetic-test-only':null}};assert.equal((await reads.callMcpReadView(incoming,f.identity,'hours_tracker',{view:'hours_tracker'})).saved,null);
 const result=await writes.callMcpWriteAction(incoming,f.identity,'hours_tracker.save_period',{period:period('2026-10-02'),revision:0});assert.equal(result.body.saved.revision,1);
});

test('actual MCP tools/list publishes period schema and owner read view with clocks disabled',async()=>{
 const f=fixture();
 const route=load('app/api/mcp/route.ts',{'@/lib/work-order-read-policy':{},'@/lib/server/work-order-reader':{},'next/server':{},'@/lib/constants':{},'@/lib/server/cmpri-mcp':{mcpIdentity:async()=>f.identity},'@/lib/server/cmpri-mcp-oauth-scope':{},'@/lib/server/cmpri-mcp-reads':{availableMcpReadViews:()=>['hours_tracker']},'@/lib/server/cmpri-mcp-writes':{availableMcpWriteActions:()=>[{action:'hours_tracker.save_period',description:'Save own period'}]},'@/lib/server/room-operations-import-schema':{},'@/lib/ai/mcp-work-order-location':{}});
 const response=await route.POST({headers:{get:n=>n==='authorization'?'Bearer synthetic-test-only':null},json:async()=>({jsonrpc:'2.0',id:1,method:'tools/list'})});
 const tools=(await response.json()).result.tools;
 assert.ok(tools.find(t=>t.name==='read_cmpri_data').inputSchema.properties.view.enum.includes('hours_tracker'));
 const schema=tools.find(t=>t.name==='perform_cmpri_write').inputSchema;
 const branch=schema.oneOf.find(b=>b.properties.action.const==='hours_tracker.save_period');assert.ok(branch);assert.equal(branch.properties.input.additionalProperties,false);assert.equal(branch.properties.input.properties.period.properties.days.minItems,14);assert.ok(!('configuration' in branch.properties.input.properties));assert.ok(!JSON.stringify(schema).includes('hours_tracker.clock_in'));
});
