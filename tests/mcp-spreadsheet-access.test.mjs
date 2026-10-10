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
  vm.runInNewContext(source,{exports,URL,Response,TextEncoder,require(name){
    if(Object.hasOwn(overrides,name)) return overrides[name];
    if(name==='server-only')return {};
    if(name==='next/server')return {NextRequest:class NextRequest {}};
    if(name==='@/lib/server/access')return {allows:(principal,capability)=>capability!=='edit_tickets'||['chief engineer','engineering manager','maintenance technician','system administrator'].includes(String(principal.profile.role).trim().toLowerCase())};
    if(name==='@/lib/server/roles')return {roleKey:role=>String(role).trim().toLowerCase()==='system administrator'?'system_admin':String(role).trim().toLowerCase()};
    if(name==='@/lib/server/room-operations-import-schema')return load('lib/server/room-operations-import-schema.ts');
    if(name==='@/lib/room-operations-recovery')return load('lib/room-operations-recovery.ts');
    if(name==='@/lib/room-ranker-access')return load('lib/room-ranker-access.ts', {
      '@/lib/server/roles': load('lib/server/roles.ts'),
    });
    if(name==='@/lib/constants')return {HOTEL_ID:'test-hotel'};
    if(name==='@/lib/ai/mcp-write-input')return {normalizeMcpFeedbackInput:()=>({}),normalizeMcpWorkOrderUpdate:()=>({})};
    if(name==='@/lib/pool-log')return {prepareMcpPoolLogInput:()=>({})};
    throw new Error(`Unexpected import ${name}`);
  }});
  return exports;
}

const reads=load('lib/server/cmpri-mcp-reads.ts');
const writes=load('lib/server/cmpri-mcp-writes.ts');
function identity(role,email=`${role.toLowerCase().replace(/[^a-z]+/g,'-')}@example.invalid`) {
  return {canWrite:true,readAllWorkOrders:true,readAssignedWorkOrders:false,readOwnWorkOrders:false,principal:{identity:{email},profile:{role,email}}};
}

test('MCP exposes Ranker reads to authorized viewers and Scott while preserving room PM reads',()=>{
  const engineerViews=reads.availableMcpReadViews(identity('Chief Engineer'));
  const adminViews=reads.availableMcpReadViews(identity('System Administrator','pickering.scott@gmail.com'));
  const viewerViews=reads.availableMcpReadViews(identity('General Manager'));
  const scottViews=reads.availableMcpReadViews(identity('System Administrator','maint.cmpri@hawkeyehotels.com'));
  assert.equal(engineerViews.includes('room_ranker'),false);
  assert.equal(engineerViews.includes('corporate_pm'),true);
  assert.equal(adminViews.includes('room_ranker'),false);
  assert.equal(viewerViews.includes('room_ranker'),true);
  assert.equal(scottViews.includes('room_ranker'),true);
});

test('MCP exposes Room Ranker writes only to Scott and preserves PM management permissions',()=>{
  const restricted=['integrations.room_ranker.sync','room_ranker.update','corporate_pm.update'];
  const engineerActions=writes.availableMcpWriteActions(identity('Chief Engineer')).map(({action})=>action);
  const adminActions=writes.availableMcpWriteActions(identity('System Administrator','pickering.scott@gmail.com')).map(({action})=>action);
  const scottActions=writes.availableMcpWriteActions(identity('System Administrator','maint.cmpri@hawkeyehotels.com')).map(({action})=>action);
  const technicianActions=writes.availableMcpWriteActions(identity('Maintenance Technician')).map(({action})=>action);
  const frontDeskActions=writes.availableMcpWriteActions(identity('Front Desk')).map(({action})=>action);
  assert.equal(engineerActions.includes('room_operations.import'),true);
  assert.equal(adminActions.includes('room_operations.import'),true);
  assert.equal(technicianActions.includes('room_operations.import'),true);
  assert.equal(frontDeskActions.includes('room_operations.import'),false);
  for(const action of restricted) {
    assert.equal(engineerActions.includes(action),false,action);
    assert.equal(adminActions.includes(action),action==='corporate_pm.update',action);
    assert.equal(scottActions.includes(action),true,action);
  }
});

test('MCP grants authorized Ranker reads without widening technician work-order access',()=>{
  const technician={...identity('Maintenance Technician'),readAllWorkOrders:false,readAssignedWorkOrders:true};
  const views=reads.availableMcpReadViews(technician);
  assert.equal(views.includes('room_ranker'),true);
  assert.equal(views.includes('work_orders'),false);
  assert.equal(views.includes('work_order'),true);
  assert.equal(views.includes('corporate_pm'),false);
  const mismatched=identity('System Administrator','maint.cmpri@hawkeyehotels.com');
  mismatched.principal.profile.email='another@example.invalid';
  assert.equal(reads.availableMcpReadViews(mismatched).includes('room_ranker'),false);
  assert.equal(writes.availableMcpWriteActions(mismatched).some(({action})=>action==='room_ranker.update'),false);
});

test('MCP tools/list exposes the complete room-operations import contract for the authorized action',async()=>{
  let calledWrite=null;
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
      callMcpWriteAction:async(_request,_identity,action,input)=>{
        calledWrite={action,input};
        return {status:200,body:{accepted:true}};
      },
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
  const toolSchema=writeTool.inputSchema;
  assert.deepEqual(Array.from(toolSchema.required),['action','input']);
  assert.equal(toolSchema.additionalProperties,false);
  assert.equal(toolSchema.allOf,undefined);
  assert.match(toolSchema.properties.input.description,/room_operations\.import/);
  const allowed=writes.availableMcpWriteActions(identity('Chief Engineer')).map(({action})=>action);
  assert.equal(allowed.includes('room_operations.import'),true);
  const genericActions=Array.from(toolSchema.properties.action.enum).sort();
  assert.equal(genericActions.includes('room_operations.import'),false);
  assert.equal(genericActions.join('|'),allowed.filter((action)=>action!=='room_operations.import').sort().join('|'));
  assert.ok(allowed.includes('work_orders.update'));

  const importTool=payload.result.tools.find(({name})=>name==='room_operations.import');
  assert.ok(importTool);
  assert.equal(importTool.annotations.readOnlyHint,false);
  assert.equal(importTool.inputSchema.type,'object');
  assert.deepEqual(
    Array.from(importTool.inputSchema.oneOf,({required})=>Array.from(required).join(',')),
    ['report_data','status_csv','csv','text','content','file','images'],
  );
  assert.match(importTool.inputSchema.description,/10Oct26 01:17 PM/);
  assert.match(importTool.inputSchema.oneOf[1].properties.status_csv.description,/Printed Date/);
  assert.match(importTool.inputSchema.oneOf[1].properties.status_csv.description,/Room Status/);

  const contractTool=payload.result.tools.find(({name})=>name==='get_room_operations_import_contract');
  assert.ok(contractTool);
  assert.match(contractTool.description,/machine-readable request contract/);
  assert.equal(contractTool.annotations.readOnlyHint,true);
  const contractResponse=await route.POST({
    headers:{get:()=>null},
    json:async()=>({
      jsonrpc:'2.0',
      id:2,
      method:'tools/call',
      params:{name:'get_room_operations_import_contract',arguments:{}},
    }),
  });
  assert.equal(contractResponse.status,200);
  const contractPayload=await contractResponse.json();
  assert.equal(contractPayload.result.isError,undefined);
  const roomOperationsSchema=contractPayload.result.structuredContent.input_schema;
  assert.ok(roomOperationsSchema);
  const returnedSchema=JSON.parse(contractPayload.result.content[0].text).input_schema;
  assert.deepEqual(returnedSchema,roomOperationsSchema);

  const importInput={csv:'Printed Date,2026-10-10\nRoom,Room Status\n101,Vacant Ready'};
  const importResponse=await route.POST({
    headers:{get:()=>null},
    json:async()=>( {
      jsonrpc:'2.0',
      id:3,
      method:'tools/call',
      params:{name:'room_operations.import',arguments:importInput},
    }),
  });
  assert.equal(importResponse.status,200);
  assert.equal(calledWrite.action,'room_operations.import');
  assert.deepEqual(calledWrite.input,importInput);
});

test('Room Ops import contract discovery returns all modes and source-backed validation fields',async()=>{
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
    json:async()=>({
      jsonrpc:'2.0',
      id:1,
      method:'tools/call',
      params:{name:'get_room_operations_import_contract',arguments:{}},
    }),
  });
  assert.equal(response.status,200);
  const payload=await response.json();
  const roomOperationsSchema=payload.result.structuredContent.input_schema;
  assert.ok(roomOperationsSchema);
  const inputModes=roomOperationsSchema.oneOf.map(({required})=>Array.from(required).join(','));
  assert.deepEqual(inputModes,['report_data','status_csv','csv','text','content','file','images']);
  const structured=roomOperationsSchema.oneOf[0].properties.report_data;
  assert.deepEqual(Array.from(structured.required),['room_status']);
  assert.deepEqual(Array.from(structured.properties.room_status.required),['printed_date','pages','rows']);
  assert.deepEqual(Array.from(structured.properties.expected_departures.anyOf[0].required),['printed_date','pages','rows']);
  const rowFields=structured.properties.room_status.properties.rows.items.properties;
  for(const field of [
    'room','room_status','room_type','guest_name','guest_code','guest_arrival_date','checkout_date',
    'checkout_time','stay_nights','reserved','arrival_date','arrival_time','incoming_arrival_date',
    'incoming_arrival_time','incoming_name','incoming_type','incoming_code','incoming_block_indicator',
    'incoming_reserved','move_from','move_to','source_page',
  ]) assert.ok(rowFields[field],`missing documented room-operation input field ${field}`);
  assert.deepEqual(
    Array.from(structured.properties.room_status.properties.rows.items.allOf[0].then.required),
    ['guest_name','guest_code','room_type','guest_arrival_date','checkout_date','stay_nights'],
  );
  assert.deepEqual(
    Array.from(structured.properties.room_status.properties.rows.items.allOf[1].then.required),
    ['incoming_name'],
  );

  const contract=roomOperationsSchema.description;
  assert.match(contract,/Expected Departures is joined to Current Room Status by room/);
  assert.match(contract,/11:00 AM/);
  assert.match(contract,/source_import_id/);
  assert.match(contract,/checkout_source_report_date/);
  assert.match(contract,/10Oct26 01:17 PM/);
  assert.match(roomOperationsSchema.oneOf[1].properties.status_csv.description,/Printed Date/);
  assert.match(roomOperationsSchema.oneOf[1].properties.status_csv.description,/Room Status/);
  assert.match(roomOperationsSchema.oneOf[1].properties.departures_csv.description,/Expected Departures/);
  for(const alias of ['RM #','HK STATUS','BLK’D','DPLM','ARV DATE','BLOCK NAME','INCOMING BLOCKED','MOVED FROM']) {
    assert.ok(roomOperationsSchema.oneOf[1].properties.status_csv.description.includes(alias),`missing CSV alias ${alias}`);
  }
  assert.equal(roomOperationsSchema.oneOf[6].properties.images.items.oneOf[1].properties.data.type,'string');
});

test('MCP exposes contract discovery to read-only sessions without exposing a write tool',async()=>{
  const readOnlyIdentity={...identity('General Manager'),canWrite:false};
  const route=load('app/api/mcp/route.ts',{
    'next/server':{NextRequest:class {}},
    '@/lib/constants':{HOTEL_ID:'test-hotel'},
    '@/lib/server/cmpri-mcp-oauth-scope':{CMPRI_MCP_RESOURCE:'https://www.cmpri-engineering.com/api/mcp'},
    '@/lib/server/cmpri-mcp':{mcpIdentity:async()=>readOnlyIdentity},
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
  const listResponse=await route.POST({
    headers:{get:()=>null},
    json:async()=>({jsonrpc:'2.0',id:1,method:'tools/list'}),
  });
  const listedTools=(await listResponse.json()).result.tools;
  assert.equal(listedTools.some(({name})=>name==='perform_cmpri_write'),false);
  assert.equal(listedTools.some(({name})=>name==='room_operations.import'),false);
  assert.equal(listedTools.some(({name})=>name==='get_room_operations_import_contract'),true);

  const contractResponse=await route.POST({
    headers:{get:()=>null},
    json:async()=>({
      jsonrpc:'2.0',
      id:2,
      method:'tools/call',
      params:{name:'get_room_operations_import_contract',arguments:{}},
    }),
  });
  assert.equal(contractResponse.status,200);
  assert.ok((await contractResponse.json()).result.structuredContent.input_schema);
});

test('Room Ops validates the full snapshot before its single database replacement',()=>{
  const route=readFileSync(path.join(root,'app/api/room-operations/route.ts'),'utf8');
  const completenessCheck=route.indexOf('const missingRooms =');
  const guestCheck=route.indexOf('const missingGuestFields =');
  const validateOnly=route.indexOf('if (body.validate_only === true)');
  const replacement=route.indexOf('auth.admin.rpc("cmpri_replace_room_operations"');
  assert.ok(completenessCheck>=0&&guestCheck>completenessCheck);
  assert.ok(validateOnly>guestCheck);
  assert.ok(replacement>validateOnly);
});

test('ChatGPT Room Ops image imports use the OCR route before complete-snapshot validation',()=>{
  const writesSource=readFileSync(path.join(root,'lib/server/cmpri-mcp-writes.ts'),'utf8');
  const mcpRoute=readFileSync(path.join(root,'app/api/mcp/route.ts'),'utf8');
  assert.match(writesSource,/case "room_operations\.import":[\s\S]*?const reportImages = images !== undefined[\s\S]*?api\/room-operations\/extract\/route[\s\S]*?images: reportImages/);
  assert.match(writesSource,/delete importInput\.rows/);
  assert.match(writesSource,/Include every active room with its exact room_status[\s\S]*Occupied rows require guest name, code, room type, arrival date, departure date, and length of stay/);
  assert.match(writesSource,/Nothing was imported/);
  assert.match(mcpRoute,/MAX_MCP_REQUEST_BYTES = 4_500_000/);
  assert.match(mcpRoute,/MAX_MCP_WRITE_INPUT_BYTES = 4_000_000/);
});

test('ChatGPT Room Ops write forwards uploaded images through OCR before importing extracted CSV',async()=>{
  const calls=[];
  const reportData={
    room_status:{printed_date:'2026-10-06',printed_time:'08:15 AM',pages:[1],rows:[{room:'101',room_status:'Vacant Ready'}]},
    expected_departures:null,
  };
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
        return {status:200,json:async()=>({ok:true,report_data:reportData})};
      },
    },
    '@/app/api/room-operations/route':{
      POST:async(request)=>{
        const body=await request.json();
        calls.push({path:body.validate_only?'/validate':'/import',body});
        return body.validate_only
          ? {status:200,json:async()=>({ok:true,rows:reportData.room_status.rows})}
          : {status:200,json:async()=>({ok:true,import_id:'import-1'})};
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
    {path:'/validate',body:{source:'file',report_data:reportData,validate_only:true}},
    {path:'/import',body:{report_date:'2026-10-06',source:'file',report_data:reportData}},
  ]);
});
