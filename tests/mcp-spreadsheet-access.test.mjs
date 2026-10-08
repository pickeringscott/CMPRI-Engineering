import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../src/',import.meta.url));

function load(relative, overrides = {}) {
  const exports={};
  const filename=path.join(root,relative);
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports,URL,Response,require(name){
    if(Object.hasOwn(overrides,name)) return overrides[name];
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

test('MCP tools/list preserves the generic nested write input for every advertised action',async()=>{
  const route=load('app/api/mcp/route.ts',{
    'next/server':{NextRequest:class {}},
    '@/lib/constants':{HOTEL_ID:'test-hotel'},
    '@/lib/server/cmpri-mcp-oauth-scope':{CMPRI_MCP_RESOURCE:'https://www.cmpri-engineering.com/api/mcp'},
    '@/lib/server/cmpri-mcp':{mcpIdentity:async()=>identity('Chief Engineer')},
    '@/lib/server/cmpri-mcp-reads':{
      availableMcpReadViews:()=>[],
      callMcpReadView:async()=>({}),
    },
    '@/lib/server/cmpri-mcp-writes':{
      availableMcpWriteActions:(value)=>writes.availableMcpWriteActions(value),
      callMcpWriteAction:async()=>({status:200,body:{}}),
    },
    '@/lib/ai/mcp-work-order-location':{resolveMcpWorkOrderLocation:()=>({status:'not_found'})},
  });
  const response=await route.POST({
    headers:{get:()=>null},
    json:async()=>({jsonrpc:'2.0',id:1,method:'tools/list'}),
  });
  assert.equal(response.status,200);
  const payload=await response.json();
  const writeTool=payload.result.tools.find(({name})=>name==='perform_cmpri_write');
  assert.ok(writeTool);
  const schema=writeTool.inputSchema;
  assert.deepEqual(Array.from(schema.required),['action','input']);
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(Object.keys(schema.properties.input).sort(),['additionalProperties','description','type']);
  assert.equal(schema.properties.input.type,'object');
  assert.equal(schema.properties.input.additionalProperties,true);
  const allowed=writes.availableMcpWriteActions(identity('Chief Engineer')).map(({action})=>action).sort();
  assert.equal(Array.from(schema.properties.action.enum).sort().join('|'),allowed.join('|'));
  assert.ok(allowed.includes('work_orders.update'));
  assert.ok(allowed.includes('room_operations.import'));
});

test('ChatGPT Room Ops image imports use the OCR route before complete-snapshot validation',()=>{
  const writesSource=readFileSync(path.join(root,'lib/server/cmpri-mcp-writes.ts'),'utf8');
  const mcpRoute=readFileSync(path.join(root,'app/api/mcp/route.ts'),'utf8');
  assert.match(writesSource,/case "room_operations\.import":[\s\S]*?const reportImages = images !== undefined[\s\S]*?api\/room-operations\/extract\/route[\s\S]*?images: reportImages/);
  assert.match(writesSource,/delete importInput\.rows/);
  assert.match(writesSource,/The report must include every active room and its reported room_status; occupied rooms must also include current guest_name, guest_code, guest_arrival_date, and checkout_date/);
  assert.match(writesSource,/Nothing was imported/);
  assert.match(mcpRoute,/MAX_MCP_REQUEST_BYTES = 4_500_000/);
  assert.match(mcpRoute,/MAX_MCP_WRITE_INPUT_BYTES = 4_000_000/);
});

test('ChatGPT Room Ops write forwards uploaded images through OCR before importing extracted CSV',async()=>{
  const calls=[];
  const writeRoute=load('lib/server/cmpri-mcp-writes.ts',{
    'next/server':{
      NextRequest:class {
        constructor(url,init) {
          this.url=url;
          this.method=init.method;
          const requestHeaders=init.headers;
          this.headers={get:(name)=>requestHeaders[name]||null};
          this.body=init.body;
          this.nextUrl=new URL(url);
        }
        async json(){return JSON.parse(this.body);}
      },
    },
    '@/app/api/room-operations/extract/route':{
      POST:async(request)=>{
        const body=await request.json();
        calls.push({path:'/extract',body});
        return {status:200,json:async()=>({ok:true,csv:'Room,Room Status\\n101,Vacant Ready'})};
      },
    },
    '@/app/api/room-operations/route':{
      POST:async(request)=>{
        calls.push({path:'/import',body:await request.json()});
        return {status:200,json:async()=>({ok:true,import_id:'import-1'})};
      },
    },
  });
  const incoming={nextUrl:{origin:'https://cmpri.example'},headers:{get:(name)=>name.toLowerCase()==='authorization'?'Bearer cmpri_mcp_test':null}};
  const outcome=await writeRoute.callMcpWriteAction(
    incoming,
    identity('Chief Engineer'),
    'room_operations.import',
    {report_date:'2026-10-06',images:[{data:'aGVsbG8=',mediaType:'image/jpeg'}]},
  );
  assert.equal(outcome.status,200);
  assert.deepEqual(calls,[
    {path:'/extract',body:{images:[{data:'aGVsbG8=',mediaType:'image/jpeg'}]}},
    {path:'/import',body:{report_date:'2026-10-06',source:'file',csv:'Room,Room Status\\n101,Vacant Ready'}},
  ]);
});
