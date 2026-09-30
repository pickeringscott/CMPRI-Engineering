import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../src/',import.meta.url));

function load(relative) {
  const exports={};
  const filename=path.join(root,relative);
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports,require(name){
    if(name==='server-only')return {};
    if(name==='next/server')return {NextRequest:class NextRequest {}};
    if(name==='@/lib/server/access')return {allows:(principal,capability)=>capability!=='edit_tickets'||['chief engineer','engineering manager','maintenance technician','system administrator'].includes(String(principal.profile.role).trim().toLowerCase())};
    if(name==='@/lib/server/roles')return {roleKey:role=>String(role).trim().toLowerCase()==='system administrator'?'system_admin':String(role).trim().toLowerCase()};
    if(name==='@/lib/constants')return {HOTEL_ID:'test-hotel'};
    if(name==='@/lib/ai/mcp-write-input')return {normalizeMcpFeedbackInput:()=>({}),normalizeMcpWorkOrderUpdate:()=>({})};
    if(name==='@/lib/pool-log')return {prepareMcpPoolLogInput:()=>({})};
    throw new Error(`Unexpected import ${name}`);
  }});
  return exports;
}

const reads=load('lib/server/cmpri-mcp-reads.ts');
const writes=load('lib/server/cmpri-mcp-writes.ts');
function identity(role) {
  return {canWrite:true,readAllWorkOrders:true,readAssignedWorkOrders:false,readOwnWorkOrders:false,principal:{profile:{role}}};
}

test('MCP exposes Ranker reads only to system administrators while preserving room PM reads',()=>{
  const engineerViews=reads.availableMcpReadViews(identity('Chief Engineer'));
  const adminViews=reads.availableMcpReadViews(identity('System Administrator'));
  assert.equal(engineerViews.includes('room_ranker'),false);
  assert.equal(engineerViews.includes('corporate_pm'),true);
  assert.equal(adminViews.includes('room_ranker'),true);
});

test('MCP exposes Ranker and PM management writes only to system administrators',()=>{
  const restricted=['integrations.room_ranker.sync','room_ranker.update','corporate_pm.update'];
  const engineerActions=writes.availableMcpWriteActions(identity('Chief Engineer')).map(({action})=>action);
  const adminActions=writes.availableMcpWriteActions(identity('System Administrator')).map(({action})=>action);
  const technicianActions=writes.availableMcpWriteActions(identity('Maintenance Technician')).map(({action})=>action);
  const frontDeskActions=writes.availableMcpWriteActions(identity('Front Desk')).map(({action})=>action);
  assert.equal(engineerActions.includes('room_operations.import'),true);
  assert.equal(adminActions.includes('room_operations.import'),true);
  assert.equal(technicianActions.includes('room_operations.import'),true);
  assert.equal(frontDeskActions.includes('room_operations.import'),false);
  for(const action of restricted) {
    assert.equal(engineerActions.includes(action),false,action);
    assert.equal(adminActions.includes(action),true,action);
  }
});
