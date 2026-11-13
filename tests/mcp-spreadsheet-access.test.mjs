import { ticketReadDependency } from "./helpers/load-ts.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../src/',import.meta.url));

function load(relative, overrides = {}, globals = {}) {
  const exports={};
  const filename=path.join(root,relative);
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports,URL,URLSearchParams,Response,TextEncoder,...globals,require(name){
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name);
    if(Object.hasOwn(overrides,name)) return overrides[name];
    if(name==='server-only')return {};
    if(name==='./hours-tracker-mcp')return {canUseHoursMcp:()=>false};
    if(name==='@/lib/server/hours-clock-policy')return {hoursClockEnabled:()=>false};
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
  return {canWrite:true,readAllWorkOrders:true,readAssignedWorkOrders:false,readOwnWorkOrders:false,principal:{identity:{email},profile:{role,email,secondary_roles:email==='maint.cmpri@hawkeyehotels.com'?['engineer']:[]}}};
}

test('MCP removes legacy Ranker reads while preserving room PM reads',()=>{
  const engineerViews=reads.availableMcpReadViews(identity('Chief Engineer'));
  const adminViews=reads.availableMcpReadViews(identity('System Administrator','pickering.scott@gmail.com'));
  const viewerViews=reads.availableMcpReadViews(identity('General Manager'));
  const scottViews=reads.availableMcpReadViews(identity('System Administrator','maint.cmpri@hawkeyehotels.com'));
  assert.equal(engineerViews.includes('room_ranker'),false);
  assert.equal(engineerViews.includes('corporate_pm'),true);
  assert.equal(adminViews.includes('room_ranker'),false);
  assert.equal(viewerViews.includes('room_ranker'),false);
  assert.equal(scottViews.includes('room_ranker'),false);
});

test('MCP removes legacy Ranker writes and preserves PM management permissions',()=>{
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
    assert.equal(scottActions.includes(action),action==='corporate_pm.update',action);
  }
});

test('MCP grants authorized Ranker reads with shared work-order reads and unchanged PM limits',()=>{
  const technician={...identity('Maintenance Technician'),readAllWorkOrders:false,readAssignedWorkOrders:true};
  const views=reads.availableMcpReadViews(technician);
  assert.equal(views.includes('room_ranker'),false);
  assert.equal(views.includes('work_orders'),true);
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
  assert.equal(toolSchema.type,'object');
  assert.equal(toolSchema.properties,undefined);
  assert.deepEqual(
    Array.from(toolSchema.oneOf,({properties})=>properties.action.const || 'other'),
    ['room_operations.import','other'],
  );
  const allowed=writes.availableMcpWriteActions(identity('Chief Engineer')).map(({action})=>action);
  assert.equal(allowed.includes('room_operations.import'),true);
  const importBranch=toolSchema.oneOf[0];
  const otherBranch=toolSchema.oneOf[1];
  assert.deepEqual(Array.from(importBranch.required),['action','input']);
  assert.equal(importBranch.properties.action.const,'room_operations.import');
  assert.deepEqual(
    Array.from(importBranch.properties.input.oneOf,({required})=>Array.from(required).join(',')),
    ['report_data','status_csv','csv','text','content','file','source,validate_only'],
  );
  assert.match(importBranch.properties.input.description,/10Oct26 01:17 PM/);
  assert.match(importBranch.properties.input.oneOf[1].properties.status_csv.description,/Printed Date/);
  assert.match(importBranch.properties.input.oneOf[1].properties.status_csv.description,/Room Status/);
  const genericActions=Array.from(otherBranch.properties.action.enum).sort();
  assert.equal(genericActions.includes('room_operations.import'),false);
  assert.equal(genericActions.join('|'),allowed.filter((action)=>action!=='room_operations.import').sort().join('|'));
  assert.ok(allowed.includes('work_orders.update'));

  assert.equal(payload.result.tools.some(({name})=>name==='room_operations.import'),false);

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
      params:{
        name:'perform_cmpri_write',
        arguments:{action:'room_operations.import',input:importInput},
      },
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
  assert.deepEqual(inputModes,['report_data','status_csv','csv','text','content','file','source,validate_only']);
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
  assert.equal(roomOperationsSchema.oneOf.some(mode=>mode.properties.images),false);
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


test('existing room_operations read returns the full contract even without refreshed tool discovery',async()=>{
  const readRoute=load('lib/server/cmpri-mcp-reads.ts',{
    'next/server':{NextRequest:Request},
    '@/app/api/room-operations/route':{GET:async()=>Response.json({source_date:'2026-10-09',carried_over:true,rows:[]})},
  });
  const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer fixture'})};
  const result=await readRoute.callMcpReadView(incoming,identity('Chief Engineer'),'room_operations',{});
  assert.equal(result.source_date,'2026-10-09');
  assert.equal(result.import_contract.action,'room_operations.import');
  assert.match(result.import_contract.instructions,/Read all supplied report photos in ChatGPT/);
  assert.match(result.import_contract.instructions,/validate_only/);
  assert.ok(result.import_contract.input_schema.oneOf[0].properties.report_data);
});
test('connected import forwards structured data and dry-run unchanged, rejects images before any route call',async()=>{
  const calls=[];
  const writeRoute=load('lib/server/cmpri-mcp-writes.ts',{
    'next/server':{NextRequest:Request},
    '@/app/api/room-operations/route':{POST:async request=>{calls.push(await request.json());return Response.json({ok:true});}},
    '@/app/api/room-operations/extract/route':{POST:async()=>{assert.fail('Connected imports must never call website OCR');}},
  });
  const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer fixture'})};
  const input={report_data:{room_status:{printed_date:'2026-10-10',pages:[1],rows:[{room:'101',room_status:'OOO'}]}},validate_only:true};
  await writeRoute.callMcpWriteAction(incoming,identity('Chief Engineer'),'room_operations.import',input);
  assert.deepEqual(calls,[input]);
  for(const images of [[],['fixture'],null]) {
    await assert.rejects(()=>writeRoute.callMcpWriteAction(incoming,identity('Chief Engineer'),'room_operations.import',{images}),/submit verified report_data/);
  }
  assert.equal(calls.length,1);
});

function mcpRoute(principal, onWrite = async () => ({ status: 200, body: {} }), writeModule = writes) {
  return load('app/api/mcp/route.ts', {
    '@/lib/server/cmpri-mcp-oauth-scope': { CMPRI_MCP_RESOURCE: 'https://www.cmpri-engineering.com/api/mcp' },
    '@/lib/server/cmpri-mcp': { mcpIdentity: async () => principal },
    '@/lib/server/cmpri-mcp-reads': { availableMcpReadViews: () => [], callMcpReadView: async () => ({}) },
    '@/lib/server/cmpri-mcp-writes': {
      availableMcpWriteActions: value => writeModule.availableMcpWriteActions(value), callMcpWriteAction: onWrite,
    },
    '@/lib/ai/mcp-work-order-location': { resolveMcpWorkOrderLocation: () => ({ status: 'not_found' }) },
  });
}

async function rpc(route, method, params) {
  const response = await route.POST({
    headers: { get: () => null }, json: async () => ({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}


test('clock actions remain hidden by default and expose strict schemas only behind activation',async()=>{
 const who=identity('Chief Engineer');
 assert.ok(!writes.availableMcpWriteActions(who).some(x=>x.action.startsWith('hours_tracker.')));
 const enabled=load('lib/server/cmpri-mcp-writes.ts',{'@/lib/server/hours-clock-policy':{hoursClockEnabled:()=>true}});
 assert.equal(enabled.availableMcpWriteActions({...who,canWrite:false}).length,0);
 const response=await rpc(mcpRoute(who,undefined,enabled),'tools/list',{});
 const tool=response.result.tools.find(t=>t.name==='perform_cmpri_write');
 for(const action of ['hours_tracker.clock_in','hours_tracker.clock_out']){
  const branch=tool.inputSchema.oneOf.find(b=>b.properties.action.const===action);
  assert.ok(branch);assert.equal(branch.properties.input.additionalProperties,false);
  assert.ok(branch.properties.input.required.includes('request_id'));
  assert.ok(!('owner_id' in branch.properties.input.properties));
 }
});
test('clock dispatch fixes action and forwards bearer without granting generic hours writes',async()=>{
 let saved;
 const enabled=load('lib/server/cmpri-mcp-writes.ts',{
  '@/lib/server/hours-clock-policy':{hoursClockEnabled:()=>true},
  'next/server':{NextRequest:class{constructor(url,init){this.nextUrl=new URL(url);this.body=init.body;this.headers=init.headers;}async json(){return JSON.parse(this.body);}}},
  '@/app/api/hours-tracker/clock/route':{POST:async req=>{saved={body:await req.json(),authorization:req.headers.Authorization,path:req.nextUrl.pathname};return Response.json({ok:true});}}
 });
 const req={nextUrl:{origin:'http://localhost'},headers:{get:()=> 'Bearer synthetic-clock-token'}};
 await enabled.callMcpWriteAction(req,identity('Chief Engineer'),'hours_tracker.clock_in',{request_id:'synthetic-request-001'});
 assert.deepEqual(saved,{body:{request_id:'synthetic-request-001',action:'clock_in'},authorization:'Bearer synthetic-clock-token',path:'/api/hours-tracker/clock'});
 await assert.rejects(()=>enabled.callMcpWriteAction(req,identity('Chief Engineer'),'hours_tracker.clock_in',{request_id:'synthetic-request-001',action:'clock_out'}));
});

test('PM modal discovery follows view_pm even without broad work-order access',()=>{
 const pmReads=load('lib/server/cmpri-mcp-reads.ts',{
  '@/lib/server/access':{allows:(principal,capability)=>capability==='view_pm'&&principal.pmAccess},
 });
 const reader={...identity('Maintenance Technician'),canWrite:false,readAllWorkOrders:false,principal:{pmAccess:true}};
 assert.ok(pmReads.availableMcpReadViews(reader).includes('preventive_maintenance'));
 assert.ok(!pmReads.availableMcpReadViews(reader).includes('corporate_pm'));
 assert.ok(!pmReads.availableMcpReadViews({...reader,readAllWorkOrders:true,principal:{pmAccess:false}}).includes('preventive_maintenance'));
});

test('PM modal read forwards the connected bearer, week and linked work order to the current API',async()=>{
 const calls=[];
 const templates=[{id:'daily',checklist:[{id:'task',label:'Check lights'}],fields:[]}];
 const snapshot={week:'2026-11-09',entries:[{task_states:{task:{status:'needs',workerChecked:true}},revision:4}],review_queue:[{id:'pending',revision:2}],can_edit:false,can_review:false,spreadsheet_sync_enabled:false};
 const pmReads=load('lib/server/cmpri-mcp-reads.ts',{
  'next/server':{NextRequest:Request},
  '@/app/api/preventive-maintenance/route':{GET:async request=>{calls.push({url:new URL(request.url),authorization:request.headers.get('authorization'),method:request.method});return Response.json(snapshot);}},
  '@/app/api/corporate-pm/route':{GET:()=>assert.fail('PM modal must not use the legacy spreadsheet')},
  '@/lib/pm/catalog':{PM_TEMPLATES:templates},
 });
 const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic-pm-token'})};
 const result=await pmReads.callMcpReadView(incoming,{...identity('Chief Engineer'),canWrite:false},'preventive_maintenance',{week:'2026-11-09',id:'123e4567-e89b-42d3-a456-426614174000'});
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{...snapshot,templates});
 assert.equal(calls.length,1);
 assert.equal(calls[0].authorization,'Bearer synthetic-pm-token');
 assert.equal(calls[0].method,'GET');
 assert.equal(calls[0].url.pathname,'/api/preventive-maintenance');
 assert.equal(calls[0].url.searchParams.get('week'),'2026-11-09');
 assert.equal(calls[0].url.searchParams.get('workOrder'),'123e4567-e89b-42d3-a456-426614174000');
 await assert.rejects(()=>pmReads.callMcpReadView(incoming,identity('Chief Engineer'),'preventive_maintenance',{}),/week beginning on Monday/);
 await assert.rejects(()=>pmReads.callMcpReadView(incoming,identity('Chief Engineer'),'preventive_maintenance',{week:'2026-11-09',id:'../elsewhere'}),/valid CMPRI record id/);
 assert.equal(calls.length,1);
});

test('PM modal read preserves API validation and authorization errors',async()=>{
 let calls=0;
 const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic-pm-token'})};
 for(const [status,error] of [[400,'Select a week beginning on Monday.'],[403,'Preventive Maintenance access is required.'],[503,'PM review records could not be loaded.']]){
  const pmReads=load('lib/server/cmpri-mcp-reads.ts',{
   'next/server':{NextRequest:Request},
   '@/app/api/preventive-maintenance/route':{GET:async()=>{calls++;return Response.json({error},{status});}},
  });
  await assert.rejects(()=>pmReads.callMcpReadView(incoming,identity('Chief Engineer'),'preventive_maintenance',{week:'2026-11-09'}),e=>e.message===error);
 }
 assert.equal(calls,3);
 const denied=load('lib/server/cmpri-mcp-reads.ts',{'@/lib/server/access':{allows:()=>false}});
 await assert.rejects(()=>denied.callMcpReadView(incoming,identity('Chief Engineer'),'preventive_maintenance',{week:'2026-11-09'}),/not permitted/);
});

test('ChatGPT discovers and calls the PM modal through read_cmpri_data with read-only scope',async()=>{
 const who={...identity('Chief Engineer'),canWrite:false};
 let received;
 const route=load('app/api/mcp/route.ts',{
  '@/lib/server/cmpri-mcp-oauth-scope':{CMPRI_MCP_RESOURCE:'https://fixture.invalid/api/mcp'},
  '@/lib/server/cmpri-mcp':{mcpIdentity:async()=>who},
  '@/lib/server/cmpri-mcp-reads':{
   availableMcpReadViews:value=>reads.availableMcpReadViews(value),
   callMcpReadView:async(_request,actor,view,args)=>{received={actor,view,args};return {entries:[],can_edit:false,can_review:false};},
  },
  '@/lib/server/cmpri-mcp-writes':{availableMcpWriteActions:()=>[],callMcpWriteAction:()=>assert.fail('Read must not write')},
  '@/lib/ai/mcp-work-order-location':{resolveMcpWorkOrderLocation:()=>({status:'not_found'})},
 });
 const listed=await rpc(route,'tools/list',{});
 const tool=listed.result.tools.find(t=>t.name==='read_cmpri_data');
 assert.ok(tool.inputSchema.properties.view.enum.includes('preventive_maintenance'));
 assert.ok(tool.inputSchema.properties.week);
 assert.match(tool.description,/corporate_pm without sheet also reads the PM modal/);
 assert.equal(listed.result.tools.some(t=>t.name==='perform_cmpri_write'),false);
 const called=await rpc(route,'tools/call',{name:'read_cmpri_data',arguments:{view:'preventive_maintenance',week:'2026-11-09'}});
 assert.equal(called.result.isError,undefined);
 assert.equal(received.actor,who);
 assert.equal(received.view,'preventive_maintenance');
 assert.equal(received.args.week,'2026-11-09');
 assert.deepEqual(called.result.structuredContent,{entries:[],can_edit:false,can_review:false});
});

test('cached corporate_pm room calls read the modal without touching Google Sheets',async()=>{
 const requests=[];
 const snapshot={entries:[{id:'101',scope_key:'room:101'},{id:'102',scope_key:'room:102'},{id:'daily',scope_key:'property'}],review_queue:[{id:'review',scope_key:'room:101'},{id:'other',scope_key:'room:102'}],can_review:false};
 const pmReads=load('lib/server/cmpri-mcp-reads.ts',{
  'next/server':{NextRequest:Request},
  '@/lib/pm/catalog':{PM_TEMPLATES:[],pmWeekStart:date=>{assert.equal(date,'2026-11-12');return '2026-11-09';}},
  '@/app/api/preventive-maintenance/route':{GET:async request=>{requests.push(new URL(request.url));assert.equal(request.headers.get('authorization'),'Bearer synthetic');return Response.json(snapshot);}},
  '@/app/api/corporate-pm/route':{GET:()=>assert.fail('Legacy cached calls must not use Google Sheets')},
 });
 const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic'})};
 const result=await pmReads.callMcpReadView(incoming,{...identity('Chief Engineer'),canWrite:false},'corporate_pm',{room:'Room 101',date:'2026-11-12'});
 assert.equal(requests[0].pathname,'/api/preventive-maintenance');
 assert.equal(requests[0].searchParams.get('week'),'2026-11-09');
 assert.equal(result.requested_room,'101');
 assert.deepEqual(result.entries,snapshot.entries.slice(0,1));
 assert.deepEqual(result.review_queue,snapshot.review_queue.slice(0,1));
 assert.equal(result.can_review,false);
});

test('cached PM calls default to the hotel week across the UTC Monday boundary',async()=>{
 class FixedDate extends Date { constructor(value){super(value===undefined?'2026-11-16T02:30:00Z':value);} }
 const pmReads=load('lib/server/cmpri-mcp-reads.ts',{
  'next/server':{NextRequest:Request},
  '@/lib/pm/catalog':{PM_TEMPLATES:[],pmWeekStart:date=>{assert.equal(date,'2026-11-15');return '2026-11-09';}},
  '@/app/api/preventive-maintenance/route':{GET:async request=>Response.json({week:new URL(request.url).searchParams.get('week'),entries:[],review_queue:[]})},
 },{Date:FixedDate});
 const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic'})};
 const result=await pmReads.callMcpReadView(incoming,identity('Chief Engineer'),'corporate_pm',{});
 assert.equal(result.week,'2026-11-09');
});

test('cached PM route preserves PM permission checks and rejects invalid dates',async()=>{
 let apiCalls=0;
 const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic'})};
 const denied=load('lib/server/cmpri-mcp-reads.ts',{
  '@/lib/server/access':{allows:(_principal,capability)=>capability!=='view_pm'},
  '@/lib/pm/catalog':{pmWeekStart:()=> '2026-11-09'},
  '@/app/api/preventive-maintenance/route':{GET:()=>{apiCalls++;assert.fail('PM access must be checked again');}},
 });
 await assert.rejects(()=>denied.callMcpReadView(incoming,identity('General Manager'),'corporate_pm',{date:'2026-11-12'}),/not permitted/);
 for(const date of ['2026-02-30','2026-13-01','bad']){
  await assert.rejects(()=>reads.callMcpReadView(incoming,identity('Chief Engineer'),'corporate_pm',{date}),/valid date/);
 }
 assert.equal(apiCalls,0);
});

test('explicit legacy sheet reads retain their existing administrator restriction',async()=>{
 let requested;
 const pmReads=load('lib/server/cmpri-mcp-reads.ts',{
  'next/server':{NextRequest:Request},
  '@/app/api/corporate-pm/route':{GET:async request=>{requested=new URL(request.url);return Response.json({sheet:'NOV'});}},
  '@/app/api/preventive-maintenance/route':{GET:()=>assert.fail('An explicit spreadsheet request is distinct')},
 });
 const incoming={nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic'})};
 await assert.rejects(()=>pmReads.callMcpReadView(incoming,identity('Chief Engineer'),'corporate_pm',{sheet:'NOV'}),/System Administrators/);
 await pmReads.callMcpReadView(incoming,identity('System Administrator'),'corporate_pm',{sheet:'NOV'});
 assert.equal(requested.pathname,'/api/corporate-pm');
 assert.equal(requested.searchParams.get('sheet'),'NOV');
 await assert.rejects(()=>pmReads.callMcpReadView(incoming,identity('System Administrator'),'corporate_pm',{room:'101',sheet:'NOV'}),/not both/);
});

test('the exact cached ChatGPT tool call works without a week field or new tool discovery',async()=>{
 const who={...identity('Chief Engineer'),canWrite:false};
 let path;
 const modalReads=load('lib/server/cmpri-mcp-reads.ts',{
  'next/server':{NextRequest:Request},
  '@/lib/pm/catalog':{PM_TEMPLATES:[],pmWeekStart:()=> '2026-11-09'},
  '@/app/api/preventive-maintenance/route':{GET:async request=>{path=new URL(request.url).pathname;return Response.json({entries:[{scope_key:'room:101',responses:{lights:'complete'}}],review_queue:[]});}},
  '@/app/api/corporate-pm/route':{GET:()=>assert.fail('Cached tool call must not reach Google Sheets')},
 });
 const route=load('app/api/mcp/route.ts',{
  '@/lib/server/cmpri-mcp-oauth-scope':{CMPRI_MCP_RESOURCE:'https://fixture.invalid/api/mcp'},
  '@/lib/server/cmpri-mcp':{mcpIdentity:async()=>who},
  '@/lib/server/cmpri-mcp-reads':modalReads,
  '@/lib/server/cmpri-mcp-writes':{availableMcpWriteActions:()=>[],callMcpWriteAction:()=>assert.fail('Read must not write')},
  '@/lib/ai/mcp-work-order-location':{resolveMcpWorkOrderLocation:()=>({status:'not_found'})},
 });
 const response=await route.POST({nextUrl:{origin:'https://fixture.invalid'},headers:new Headers({authorization:'Bearer synthetic'}),json:async()=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_cmpri_data',arguments:{view:'corporate_pm',room:'101'}}})});
 const payload=await response.json();
 assert.equal(payload.result.isError,undefined);
 assert.equal(path,'/api/preventive-maintenance');
 assert.equal(payload.result.structuredContent.requested_room,'101');
 assert.equal(payload.result.structuredContent.entries[0].responses.lights,'complete');
});
