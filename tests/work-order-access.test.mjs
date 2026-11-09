import {partsStatusDependency} from "./helpers/load-ts.mjs";
import * as commonAreas from "../src/lib/cmpri-location-groups.ts";
import { ticketReadDependency } from "./helpers/load-ts.mjs";
import * as accountDisplay from "../src/lib/account-display.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const roleExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/server/roles.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:roleExports});
const editPolicyExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/work-order-edit-policy.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:editPolicyExports,require(name) { if(name === "@/lib/server/work-order-parts-status") return partsStatusDependency;if(name==='@/lib/server/work-order-mentions')return {persistMentionedWorkOrder:async()=>null};if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name === "@/lib/account-display") return accountDisplay;if(name==='./work-order-read-policy')return ticketReadDependency('@/lib/work-order-read-policy');if(name==='./server/roles')return roleExports;throw new Error(name);}});
const { canSubmitWorkOrderNote, workOrderEditableFields }=editPolicyExports;
const assignmentExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/server/work-order-assignment.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:assignmentExports,require(name) { if(name === "@/lib/server/work-order-parts-status") return partsStatusDependency;if(name==='@/lib/server/work-order-mentions')return {persistMentionedWorkOrder:async()=>null};if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name === "@/lib/account-display") return accountDisplay;if(name==='./roles')return roleExports;throw new Error(name);}});
const { canAccessWorkOrderByAssignment }=assignmentExports;
const activitySource=readFileSync(new URL('../src/app/api/work-orders/[id]/activity/route.ts',import.meta.url),'utf8');
const activityCode=ts.transpileModule(activitySource,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;

test('work-order reviewers can stage notes only while a request is pending review',()=>{
  assert.equal(canSubmitWorkOrderNote({canEdit:false,canReview:true,status:'Pending Verification'}),true);
  for(const status of ['Open','In Progress','Completed','Closed','Will Not Do']){
    assert.equal(canSubmitWorkOrderNote({canEdit:false,canReview:true,status}),false,status);
  }
  assert.equal(canSubmitWorkOrderNote({canEdit:true,canReview:false,status:'Open'}),true);
  assert.equal(canSubmitWorkOrderNote({canEdit:false,canReview:false,status:'Pending Verification'}),false);
  assert.match(detailPage,/canSubmitWorkOrderNote\(\{[\s\S]*role: chief \? "Chief Engineer" : cmpriSession\?\.user\.role,[\s\S]*canEdit: canEditTicket,[\s\S]*canReview: canReviewCurrentTicket,[\s\S]*status: order\.status/);
  assert.match(detailPage,/disabled=\{saving \|\| !canSubmitTicketNote\}/);
  assert.match(detailPage,/<WorkOrderMediaComposer[^>]*hasNote=\{!!noteDraft\.trim\(\)\}/);
});

test('technicians can stage notes only when their work-order edit policy permits notes',()=>{
  const common={role:'Maintenance Technician',canEdit:true,canReview:false,canAddNotes:false};
  assert.equal(canSubmitWorkOrderNote({...common,status:'Open',unassigned:false}),true);
  assert.equal(canSubmitWorkOrderNote({...common,status:'Pending Verification',unassigned:true}),false);
  assert.equal(canSubmitWorkOrderNote({...common,status:'Open',unassigned:true,canClaimUnassigned:true}),false);
  assert.equal(canSubmitWorkOrderNote({...common,canAddNotes:true,status:'Open',unassigned:true}),true);
  assert.deepEqual(Array.from(workOrderEditableFields({...common,canAddNotes:true,status:'Open',unassigned:true,canClaimUnassigned:false})),['notes']);
});

test('note-only roles can comment on every accessible ticket status',()=>{
  for(const status of ['Open','In Progress']){
    assert.equal(canSubmitWorkOrderNote({canEdit:false,canReview:false,canAddNotes:true,status}),true,status);
  }
  for(const status of ['Pending Verification','Completed','Closed','Will Not Do']){
    assert.equal(canSubmitWorkOrderNote({canEdit:false,canReview:false,canAddNotes:true,status}),true,status);
  }
});

test('every active role can stage open-ticket notes without receiving technical edit fields',()=>{
  const noteRoles=['Front Desk','Housekeeping','Front Desk Manager','Assistant General Manager','Assistant Manager','General Manager','Senior Management'];
  for(const role of noteRoles){
    assert.equal(roleExports.roleAllows(role,'add_work_order_notes'),true,role);
    assert.deepEqual(Array.from(workOrderEditableFields({
      role,canEdit:false,canReview:false,canAddNotes:true,unassigned:false,canClaimUnassigned:false,
    })),['notes'],role);
  }
  for(const role of ['Engineer','Maintenance Technician','System Administrator']){
    assert.equal(roleExports.roleAllows(role,'add_work_order_notes'),true,role);
  }
});

const code=ts.transpileModule(readFileSync(new URL('../src/app/api/work-orders/[id]/route.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const detailPage=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');

function fixture(config={}){
  let writes=0;let saved;
  const calls=[];
  const profile=config.profile===undefined?{id:'actor',active:true,role:'Engineer'}:config.profile;
  const existingStatus=config.existingStatus??(config.closed?'Closed':'Open');
  const existingTechnician=config.existingTechnician===undefined?'Scott':config.existingTechnician;

  const db={auth:{getUser:async()=>({data:{user:{id:'actor'}},error:null})},from(table){
    const filters=[];
    const q={
      select(){return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},in(){return q;},limit(){return q;},order(){return q;},neq(){return q;},
      async maybeSingle(){
        calls.push({table,filters});
        if(table==='work_orders')return {data:config.missing?null:{id:'order',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',created_by:config.createdBy,submitted_by_name:config.staffName,issue:"Fan noisy",room:"409",creator_name:'Historical recorded name',location_id:'room-409',asset_id:'old-asset',asset_name:'Original equipment',revision:config.currentRevision??1,status:existingStatus,technician_name:existingTechnician,last_assigned_technician_name:'Scott'},error:config.lookupError?{message:'failed'}:null};
        if(table==='locations')return {data:config.locationMissing?null:{id:'00000000-0000-0000-0000-000000000020',name:'Room 410',active:!config.locationInactive},error:config.locationError?{message:'failed'}:null};
        if(table==='profiles')return {data:config.creatorProfile || null,error:null};
        if(table==='assets')return {data:config.assetMissing?null:{id:'new-asset',location_id:config.template?null:config.wrongRoom?'room-410':'room-409',active:!config.retired,name:'Verified equipment'},error:config.assetError?{message:'failed'}:null};
        return {data:null,error:null};
      },
      update(value){writes++;saved=value;return q;},
      delete(){writes++;return q;},
      then(onFulfilled,onRejected){return Promise.resolve({error:config.deleteError?{message:'delete failed'}:null}).then(onFulfilled,onRejected);},
      single:async()=>(config.concurrentStatus || config.concurrentRevision) && filters.some(([key,value])=>key==='revision'&&value!==(config.concurrentRevision??2))
        ? {data:null,error:{code:'PGRST116',message:'No matching row'}}
        : {data:{id:'order',status:String(saved?.status??existingStatus)},error:null},
    };
    return q;
  }};

  const principal=profile&&profile.active===true?{
    identity:{id:'actor',email:config.email || 'actor@example.invalid'},
    profile,
    hotelId:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',
    membership:{user_id:'actor',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',role:null,active:true},
    permissions:config.denied?[{role:profile.role,permission:'manage_work_orders',allowed:false}]:[{role:profile.role,permission:'manage_work_orders',allowed:true}],
  }:null;

  const allows=(p,c)=>{
    if(!p||p.profile?.active!==true||config.permissionError||config.denied)return false;
    const role=p.profile.role;
    if(c==='submit')return roleExports.roleAllows(role,'submit');
    if(c==='view_dashboard')return ['Engineer','Chief Engineer','General Manager','Senior Management','system_admin'].includes(role);
    if(c==='view_work_orders')return !!principal;
    if(c==='add_work_order_notes')return ['Front Desk','Housekeeping','General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager','Senior Management','Engineer','Chief Engineer','Maintenance Technician','system_admin'].includes(role);
    if(c==='view_pm')return ['Engineer','Chief Engineer','General Manager','Maintenance Technician','Senior Management','system_admin'].includes(role);
    if(c==='edit_tickets')return ['Engineer','Chief Engineer','Maintenance Technician','system_admin'].includes(role);
    if(c==='review_tickets')return ['Engineer','Chief Engineer','system_admin'].includes(role);
    if(c==='reopen'||c==='close_tickets')return ['Engineer','Chief Engineer','system_admin'].includes(role);
    if(c==='manage_users')return ['General Manager','Chief Engineer','system_admin'].includes(role);
    return false;
  };

  const authModule={
    requireUser:async()=>{
      if(config.profileError||config.permissionError||!principal)return null;
      return {principal,admin:db};
    },
    requireCapability:async(_request,capability)=>{
      if(config.profileError||config.permissionError||!principal||!allows(principal,capability))return null;
      return {principal,admin:db};
    },
  };

  const exports={};
  vm.runInNewContext(code,{
    exports,
    process:{env:{SUPABASE_SERVICE_ROLE_KEY:'fake'}},
    require(name) { if(name === "@/lib/server/work-order-parts-status") return partsStatusDependency;if(name==='@/lib/server/work-order-mentions')return {persistMentionedWorkOrder:async()=>{if(config.mentionFailure)throw Error("directory offline");return config.mentionResult||null;}};if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name, allows);
      if (name === "@/lib/account-display") return accountDisplay;
      if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
      if(name==='@supabase/supabase-js')return {createClient:()=>db};
      if(name==='server-only')return {};
      if(name==='@/lib/constants')return {HOTEL_ID:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'};
      if(name==='@/lib/supabase/config')return {SUPABASE_URL:'https://test.invalid',SUPABASE_PUBLISHABLE_KEY:'fake'};
      if(name==='@/lib/server/access')return {allows};
      if(name==='@/lib/server/auth')return authModule;
      if(name==='@/lib/server/roles')return {
        profileIsChiefEngineer:roleExports.profileIsChiefEngineer, profileIsEstablishedHoursChief:roleExports.profileIsEstablishedHoursChief,
        roleKey:value=>{
          const key=typeof value==='string'?value.trim().toLowerCase().replace(/[\s_-]+/g,''):'unknown';
          return key==='maintenancetechnician'?'technician':key;
        },
        roleAllows:(role,capability)=>capability==='edit_tickets'&&['Engineer','Chief Engineer','Maintenance Technician','system_admin'].includes(role),
      };
      if(name==='@/lib/server/work-order-notification-resolution')return {
        isEngineeringWorkOrderActor:profile=>['Engineer','Chief Engineer','system_admin'].includes(profile?.role),
        recordEngineeringWorkOrderView:async()=>{},
      };
      if(name==='@/lib/server/work-order-assignment')return {canAccessWorkOrderByAssignment};
      if(name==='@/lib/work-order-edit-policy')return editPolicyExports;
      if(name==='@/lib/uuid')return {isUuid:value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)};
      if(name==='@/lib/work-order-categories')return {normalizeWorkOrderCategory:(value)=>typeof value==='string'&&value.trim()?value.trim():null};
      if(name==='@/lib/server/room-ranker')return {processRoomRankerSyncForWorkOrder:async()=>{}};
      if(name==='@/lib/server/room-availability')return {
        loadCurrentRoomStatuses:async()=>({date:'2026-10-01',statuses:new Map(),error:null}),
        currentRoomOperation:()=>null,currentRoomStatus:()=>null,
      };
      throw new Error(name);
    },
  });

  const req={headers:new Headers({authorization:'Bearer fake'}),json:async()=>{
    if(config.badJson)throw Error('bad json');
    return config.nullBody?null:{expected_revision:1,...(config.body??{status:config.status||'In Progress'})};
  }};
  req.nextUrl={searchParams:new URLSearchParams()};
  return {
    run:(method='PATCH')=>exports[method](req,{params:Promise.resolve({id:config.id??'00000000-0000-0000-0000-000000000018'})}),
    get:()=>exports.GET(req,{params:Promise.resolve({id:config.id??'00000000-0000-0000-0000-000000000018'})}),
    writes:()=>writes,saved:()=>saved,calls,
  };
}

for(const config of [{profile:null},{profile:{active:false,role:'Engineer'}},{profile:{active:null,role:'Engineer'}},{profileError:true},{permissionError:true},{denied:true},{profile:{active:true,role:'Front Desk'}},{profile:{active:true,role:'Housekeeping'}}])test(`rejects unauthorized edit ${JSON.stringify(config)}`,async()=>{
  const f=fixture(config);assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);
});

for(const config of [{badJson:true},{nullBody:true},{status:'Duplicate'},{status:'invented'}])test(`rejects invalid edit ${JSON.stringify(config)}`,async()=>{
  const f=fixture(config);assert.equal((await f.run()).status,400);assert.equal(f.writes(),0);
});

test('front desk cannot reopen a closed ticket',async()=>{const f=fixture({closed:true,profile:{active:true,role:'Front Desk'}});assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);});
test('Engineer with edit permission can reopen',async()=>{const f=fixture({closed:true,profile:{active:true,role:'Engineer'}});assert.equal((await f.run()).status,200);assert.equal(f.writes(),1);});
test('permitted engineer can update an active ticket with hotel scope',async()=>{const f=fixture();assert.equal((await f.run()).status,200);assert.equal(f.writes(),1);assert.ok(f.calls.find(c=>c.table==='work_orders').filters.some(([k,v])=>k==='hotel_id'&&v==='c81ad01a-7a9f-4880-ac1c-5e849f30bad6'));});

test('shared work-order field policy matches role-specific API and UI permissions',()=>{
  const fields=(input)=>workOrderEditableFields(input);
  assert.deepEqual(Array.from(fields({role:'Maintenance Technician',canEdit:true,canReview:false,unassigned:false,canClaimUnassigned:false})),['asset_id','category','status','notes']);
  assert.deepEqual(Array.from(fields({role:'Maintenance Technician',canEdit:true,canReview:false,unassigned:true,canClaimUnassigned:true})),['technician_name']);
  assert.deepEqual(Array.from(fields({role:'Maintenance Technician',canEdit:true,canReview:false,unassigned:true,canClaimUnassigned:false})),[]);
  assert.deepEqual(Array.from(fields({role:'Maintenance Technician',canEdit:false,canReview:false,unassigned:false,canClaimUnassigned:false})),[]);
  assert.deepEqual(Array.from(fields({role:'Engineer',canEdit:true,canReview:false,unassigned:false,canClaimUnassigned:false})),Array.from(editPolicyExports.TECHNICAL_WORK_ORDER_FIELDS));
  assert.deepEqual(Array.from(fields({role:'General Manager',canEdit:false,canReview:true,unassigned:false,canClaimUnassigned:false})),['status','notes']);
  assert.deepEqual(Array.from(fields({role:'General Manager',canEdit:false,canReview:false,canAddNotes:true,unassigned:false,canClaimUnassigned:false})),['notes']);
  assert.deepEqual(Array.from(fields({role:'Assistant General Manager',canEdit:false,canReview:false,canAddNotes:true,unassigned:false,canClaimUnassigned:false})),['notes']);
  assert.deepEqual(Array.from(fields({role:'Senior Management',canEdit:false,canReview:false,unassigned:false,canClaimUnassigned:false})),[]);
  assert.match(detailPage,/canSubmitWorkOrderNote\(\{[\s\S]*role: chief \? "Chief Engineer" : cmpriSession\?\.user\.role,[\s\S]*unassigned: !String\(order\.technician_name \|\| ""\)\.trim\(\),[\s\S]*canClaimUnassigned: canClaimWorkOrder/);
});

test('note-only roles cannot replace history through the general ticket endpoint',async()=>{
  for(const role of ['Front Desk','Housekeeping','General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager','Senior Management']){
    const f=fixture({profile:{id:'actor',active:true,role},body:{notes:'A permitted operational note'}});
    assert.equal((await f.run()).status,403,role);
    assert.equal(f.saved(),undefined,role);
  }
});

test('all note-only roles cannot change status, assignments, or engineering-owned fields',async()=>{
  for(const role of ['Front Desk','Housekeeping','General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager','Senior Management']){
    const profile={id:'actor',active:true,role};
    for(const field of ['status','technician_name','issue','asset_id','asset_name','category','priority','action_root_cause','parts','cost','hours','due_by']){
      if(field==='issue'&&['General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager'].includes(role)) continue;
      const f=fixture({profile,body:{[field]:field==='cost'||field==='hours'?1:'unauthorized'}});
      assert.equal((await f.run()).status,403,`${role}/${field}`);
      assert.equal(f.writes(),0,`${role}/${field}`);
    }
    const combined=fixture({profile,body:{notes:'Must not partially save',status:'Completed'}});
    assert.equal((await combined.run()).status,403,`${role}/combined`);
    assert.equal(combined.writes(),0,`${role}/combined`);
  }
});

test('note-only roles can read every same-hotel ticket state',async()=>{
  for(const role of ['Front Desk','Housekeeping','General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager','Senior Management']){
    const active=fixture({profile:{id:'actor',active:true,role},existingStatus:'Open'});
    assert.equal((await active.get()).status,200,`${role}/open`);
    for(const existingStatus of ['Completed','Closed','Will Not Do','Pending Verification']){
      const blocked=fixture({profile:{id:'actor',active:true,role},existingStatus});
      assert.equal((await blocked.get()).status,200,`${role}/${existingStatus}`);
    }
  }
});

test('note-only roles cannot add notes to pending, completed, or closed work orders',async()=>{
  for(const role of ['Front Desk','Housekeeping','General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager','Senior Management']){
    const profile={id:'actor',active:true,role};
    for(const status of ['Pending Verification','Completed','Closed','Will Not Do']){
      const f=fixture({profile,existingStatus:status,body:{notes:'Should not be saved'}});
      assert.equal((await f.run()).status,403,`${role}/${status}`);
      assert.equal(f.writes(),0,`${role}/${status}`);
    }
  }
});

test('limited work-order readers receive ticket history but not purchasing or Enseo activity',async()=>{
  const tables=[];
  const admin={from(table){
    tables.push(table);
    const query={
      select(){return query;},
      eq(){return query;},
      order(){return query;},
      limit(){return query;},
      maybeSingle:async()=>({data:{id:'order',hotel_id:'hotel',status:'Open',technician_name:null},error:null}),
      then(resolve,reject){return Promise.resolve({data:[{id:'history-entry'}],error:null}).then(resolve,reject);},
    };
    return query;
  }};
  const principal={hotelId:'hotel',identity:{id:'manager'},profile:{id:'manager',role:'General Manager',full_name:'Audit Manager',active:true}};
  const exports={};
  vm.runInNewContext(activityCode,{
    exports,
    require(name) { if(name === "@/lib/server/work-order-parts-status") return partsStatusDependency;if(name==='@/lib/server/work-order-mentions')return {persistMentionedWorkOrder:async()=>null};if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name, (_p,c)=>c === "add_work_order_notes" || c === "view_work_orders");
      if (name === "@/lib/account-display") return accountDisplay;
      if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
      if(name==='@/lib/constants')return {HOTEL_ID:'hotel'};
      if(name==='@/lib/server/access')return {allows:(_principal,capability)=>capability==='view_work_orders'};
      if(name==='@/lib/server/auth')return {requireUser:async()=>({principal,admin})};
      if(name==='@/lib/server/work-order-assignment')return {canAccessWorkOrderByAssignment:()=>true};
      if(name==='@/lib/uuid')return {isUuid:()=>true};
      throw new Error(name);
    },
  });
  const response=await exports.GET({}, {params:Promise.resolve({id:'order'})});
  assert.equal(response.status,200);
  assert.deepEqual(Array.from(tables),['work_orders','cmpri_work_order_history']);
  assert.equal(response.body.purchases.length,0);
  assert.equal(response.body.enseo.length,0);
  assert.equal(response.body.history[0].id,'history-entry');

  assert.match(detailPage,/cmpriSession\?\.capabilities\.includes\("view_dashboard"\) && \(roomOperationalContext\.loading/);
  assert.match(detailPage,/editableFields\.length > 0 \|\| canReviewCurrentTicket/);
});

test('assigned technician can save allowed fields but cannot send technical-only fields',async()=>{
  const profile={id:'actor',active:true,role:'Maintenance Technician',full_name:'Morgan Lee'};
  const allowed=fixture({profile,existingTechnician:'Morgan Lee',body:{expected_revision:1,asset_id:'new-asset',category:'HVAC',status:'In Progress',notes:'Diagnosed locally'}});
  assert.equal((await allowed.run()).status,200);
  assert.equal(allowed.writes(),1);
  assert.equal(allowed.saved().category,'HVAC');
  for(const field of ['asset_name','priority','technician_name','action_root_cause','parts','cost','hours','due_by']){
    const denied=fixture({profile,existingTechnician:'Morgan Lee',body:{expected_revision:1,[field]:field==='cost'||field==='hours'?1:'unauthorized'}});
    assert.equal((await denied.run()).status,403,field);
    assert.equal(denied.writes(),0,field);
  }
});

for(const [config,status]of [[{lookupError:true},503],[{missing:true},404]])test(`lookup failure returns ${status} without writes`,async()=>{const f=fixture(config);assert.equal((await f.run()).status,status);assert.equal(f.writes(),0);});

for(const body of [{},{issue:'  '},{issue:null},{notes:{text:'bad'}},{priority:'invented'},{cost:-1},{cost:'5'},{hours:-1},{hours:Infinity},{due_by:'not a date'},{technician_name:42}])test(`invalid ticket fields rejected: ${JSON.stringify(body)}`,async()=>{
  const f=fixture({body});assert.equal((await f.run()).status,400);assert.equal(f.writes(),0);
});

test('valid amounts and optional clearing are retained',async()=>{
  const f=fixture({body:{cost:0,hours:1.5,notes:'',due_by:null}});
  assert.equal((await f.run()).status,200);assert.equal(f.saved().cost,0);assert.equal(f.saved().hours,1.5);assert.equal(f.saved().due_by,null);assert.equal('created_by' in f.saved(),false);
});

for(const body of [{priority:['High']},{due_by:'2026-02-30T10:00'}])test(`strict priority/date validation ${JSON.stringify(body)}`,async()=>{
  const f=fixture({body});assert.equal((await f.run()).status,400);assert.equal(f.writes(),0);
});

test('valid local due time is accepted',async()=>{
  const f=fixture({body:{due_by:'2026-09-16T10:30'}});assert.equal((await f.run()).status,200);assert.equal(f.saved().due_by,'2026-09-16T10:30');
});

for(const [config,status] of [[{wrongRoom:true},400],[{assetMissing:true},400],[{retired:true},400],[{assetError:true},503]])test(`equipment change rejects unavailable target ${JSON.stringify(config)}`,async()=>{
  const f=fixture({...config,body:{asset_id:'new-asset',asset_name:'Submitted name'}});assert.equal((await f.run()).status,status);assert.equal(f.writes(),0);
});

test('equipment change uses verified name and scopes lookup to this hotel',async()=>{
  const f=fixture({body:{asset_id:'new-asset',asset_name:'Spoof'}});assert.equal((await f.run()).status,200);assert.equal(f.saved().asset_name,'Verified equipment');
  assert.ok(f.calls.find(c=>c.table==='assets').filters.some(([k,v])=>k==='hotel_id'&&v==='c81ad01a-7a9f-4880-ac1c-5e849f30bad6'));
});

test('explicit template selection preserves the unassigned asset and validates active status',async()=>{
  const f=fixture({template:true,body:{asset_id:'new-asset',asset_name:'Spoof'}});
  assert.equal((await f.run()).status,200);
  assert.equal(f.saved().asset_name,'Verified equipment');
  assert.equal(f.saved().location_id,undefined);
  const retired=fixture({template:true,retired:true,body:{asset_id:'new-asset'}});
  assert.equal((await retired.run()).status,400);
  assert.equal(retired.writes(),0);
});

test('clearing equipment clears its display name',async()=>{
  const f=fixture({body:{asset_id:null,asset_name:'Stale name'}});assert.equal((await f.run()).status,200);assert.equal(f.saved().asset_name,'');
});

test('name-only equipment spoofing is rejected',async()=>{
  const f=fixture({body:{asset_name:'Spoof'}});assert.equal((await f.run()).status,400);assert.equal(f.writes(),0);
});

test('unchanged historical equipment preserves its recorded name without requiring a new assignment',async()=>{
  const f=fixture({assetMissing:true,body:{asset_id:'old-asset',asset_name:'Spoof',notes:'Follow-up'}});assert.equal((await f.run()).status,200);assert.equal(f.saved().asset_name,'Original equipment');assert.equal(f.calls.some(c=>c.table==='assets'),false);
});

test('a concurrent close cannot be overwritten by a technician save',async()=>{
  const f=fixture({concurrentStatus:'Closed'});assert.equal((await f.run()).status,409);
});

for (const expected_revision of [undefined, null, 0, -1, '1', 1.5]) test(`invalid revision ${expected_revision} prevents writes`, async () => {
  const f=fixture({body:{notes:'Unsaved notes',expected_revision}});assert.equal((await f.run()).status,428);assert.equal(f.writes(),0);
});

test('stale notes are rejected even while ticket status remains Open',async()=>{
  const f=fixture({currentRevision:2,body:{notes:'Old browser notes',expected_revision:1}});assert.equal((await f.run()).status,409);assert.equal(f.writes(),0);
});

test('a save between read and update is rejected by the atomic revision condition',async()=>{
  const f=fixture({concurrentRevision:2,body:{notes:'Old browser notes',expected_revision:1}});assert.equal((await f.run()).status,409);
});

test('current revision permits a save without writing client revision into the record',async()=>{
  const f=fixture({currentRevision:3,body:{notes:'New notes',expected_revision:3,revision:999}});assert.equal((await f.run()).status,200);assert.equal(f.saved().revision,undefined);assert.equal(f.saved().expected_revision,undefined);
});

test('work-order labor and parts inputs use field-level permissions',()=>{
  const source=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
  const heading=source.match(/<h2\b[^>]*>Labor & Parts<\/h2>/);
  assert.ok(heading, 'Labor & Parts heading must exist independently of its styling');
  const sectionEnd=source.indexOf('</section>',heading.index);
  assert.ok(sectionEnd>heading.index, 'Labor & Parts must have a containing section');
  const section=source.slice(heading.index,sectionEnd);
  assert.match(section,/WorkOrderSupplies[^>]*disabled=\{saving \|\| hasUnsavedChanges\}/);
  assert.match(section,/disabled=\{!canEditField\("hours"\) \|\| saving\}/);
  assert.match(section,/disabled=\{!canEditField\("cost"\) \|\| saving\}/);
  assert.match(source,/workOrderEditableFields\(/);
  for(const field of ['issue','asset_id','category','priority','technician_name','status','due_by']){
    assert.ok(source.includes(`canEditField("${field}")`),`${field} control must follow the shared edit policy`);
  }
  assert.match(source,/disabled=\{!canEditField\("action_root_cause"\) \|\| saving\}/);
  assert.match(source,/const values = \["Open", "In Progress", "Completed"\]/);
  assert.match(source,/else if \(canEditField\("asset_id"\)\) \{\s*Object\.assign\(updatePayload, \{\s*asset_id: assetId \|\| null,\s*category,\s*status: saveStatus,\s*notes: notesWithChanges,/);
});

test('the observed system_admin role can reopen with explicit editing permission',async()=>{
  const f=fixture({closed:true,profile:{active:true,role:'system_admin'}});assert.equal((await f.run()).status,200);
});

test('general manager cannot review or change another user’s pending request',async()=>{
  const f=fixture({profile:{active:true,role:'General Manager'},existingStatus:'Pending Verification',body:{status:'Open',notes:'Approved',expected_revision:1}});
  const r=await f.run();assert.equal(r.status,403);assert.equal(f.writes(),0);
});

test('general manager cannot change technical fields on another user’s pending request',async()=>{
  const f=fixture({profile:{active:true,role:'General Manager'},existingStatus:'Pending Verification',body:{status:'Open',priority:'Urgent',expected_revision:1}});
  assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);
});

test('general manager cannot review another user’s open request',async()=>{
  const f=fixture({profile:{active:true,role:'General Manager'},existingStatus:'Open',body:{status:'Will Not Do',expected_revision:1}});
  assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);
});

test('technician assignment access is limited to their own assigned orders and unassigned coverage',()=>{
  const assigned={technician_name:'Morgan Lee'};
  assert.equal(canAccessWorkOrderByAssignment('Maintenance Technician','Morgan Lee',assigned),true);
  assert.equal(canAccessWorkOrderByAssignment('technician',' Morgan Lee ',assigned),true);
  assert.equal(canAccessWorkOrderByAssignment('technician','Morgan Li',assigned),false);
  assert.equal(canAccessWorkOrderByAssignment('technician','Morgan Lee',{technician_name:null}),true);
  assert.equal(canAccessWorkOrderByAssignment('technician','Morgan Lee',{technician_name:''}),true);
  assert.equal(canAccessWorkOrderByAssignment('technician','',{technician_name:'Morgan Lee'}),false);
  assert.equal(canAccessWorkOrderByAssignment('Chief Engineer','Other Engineer',assigned),true);
});

test('technician can claim an open unassigned order for themself',async()=>{
  const f=fixture({
    profile:{id:'actor',active:true,role:'Maintenance Technician',full_name:'Morgan Lee'},
    existingTechnician:null,
    body:{expected_revision:1,technician_name:'Morgan Lee'},
  });
  const response=await f.run();
  assert.equal(response.status,200);
  assert.equal(f.writes(),1);
  assert.equal(f.saved().technician_name,'Morgan Lee');
});

test('technician cannot edit a closed unassigned order, assign it to another person, or replace another assignment',async()=>{
  const profile={id:'actor',active:true,role:'Maintenance Technician',full_name:'Morgan Lee'};
  for(const config of [
    {existingTechnician:null,existingStatus:'Closed',body:{expected_revision:1,technician_name:'Morgan Lee'}},
    {existingTechnician:null,existingStatus:'Open',body:{expected_revision:1,status:'Completed'}},
    {existingTechnician:'',body:{expected_revision:1,technician_name:'Other Technician'}},
    {existingTechnician:'Other Technician',body:{expected_revision:1,technician_name:'Morgan Lee'}},
  ]){
    const f=fixture({profile,...config});
    assert.equal((await f.run()).status,403);
    assert.equal(f.writes(),0);
  }
});

test('malformed work-order identifiers return client errors before detail reads or writes',async()=>{
  for(const method of ['GET','PATCH','DELETE']){
    const f=fixture({id:'test-id'});
    assert.equal((await f.run(method)).status,400,method);
    assert.equal(f.calls.length,0,method);
    assert.equal(f.writes(),0,method);
  }
});

test('only engineer reviewers and system administrators may delete work orders',async()=>{
  for(const role of ['General Manager','Maintenance Technician','Senior Management']){
    const f=fixture({profile:{id:'actor',active:true,role,full_name:'Audit Actor'}});
    assert.equal((await f.run('DELETE')).status,403,role);
    assert.equal(f.writes(),0,role);
  }
  for(const role of ['Engineer','Chief Engineer','system_admin']){
    const f=fixture({profile:{id:'actor',active:true,role,full_name:'Audit Actor'}});
    assert.equal((await f.run('DELETE')).status,200,role);
    assert.equal(f.writes(),1,role);
  }
});

test('technical mutations and attachments preserve assignment guards while detail/history share the read policy',()=>{
  const routePaths=[
    '../src/app/api/work-orders/[id]/route.ts',
    '../src/app/api/work-orders/[id]/activity/route.ts',
    '../src/app/api/work-orders/[id]/attachments/route.ts',
  ];
  for(const routePath of routePaths){
    const source=readFileSync(new URL(routePath,import.meta.url),'utf8');
    if (routePath.includes("activity")) assert.match(source,/canReadWorkOrder\(/);
    else if (routePath.includes("attachments")) assert.match(source,/allows\(auth.principal, 'add_work_order_notes'\)/);
    else assert.match(source,/canAccessWorkOrderByAssignment\(/,`${routePath} must enforce technician assignment`);
  }
});

test('work-order detail does not request restricted maintenance reference for limited readers',()=>{
  const page=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
  assert.match(page,/loadTicket\(showLoading = true, canLoadMaintenanceReference = true, background = false\)/);
  assert.match(page,/if \(canLoadMaintenanceReference\) void loadMaintenanceReference\(\)/);
  assert.match(page,/canLoadMaintenanceReference = session\.capabilities\.includes\("view_dashboard"\)/);
  assert.match(page,/await loadTicket\(!hadPreview, canLoadMaintenanceReference\)/);
});

test('maintenance attribution exposes its current display title without rewriting creator or authorization role', async () => {
 for (const [email,expected] of [['maint.cmpri@hawkeyehotels.com','Chief Engineer'],['pickering.scott@gmail.com','System Administrator + Engineer']]) {
  const f=fixture({email,createdBy:'actor',profile:{id:'actor',active:true,role:'system_admin',secondary_roles:['engineer']}});
  const result=await f.get();
  assert.equal(result.status,200);
  assert.equal(result.body.workOrder.creator_display_role,expected);
  assert.equal(result.body.workOrder.creator_role,'system_admin');
  assert.equal(result.body.workOrder.creator_name,'Historical recorded name');
  assert.equal(f.writes(),0);
 }
});

test('engineering readback resolves maintenance creator title independently of the viewing account', async () => {
 const f=fixture({email:'pickering.scott@gmail.com',createdBy:'maintenance-author',creatorProfile:{email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:['engineer']}});
 const result=await f.get();
 assert.equal(result.status,200);
 assert.equal(result.body.workOrder.creator_display_role,'Chief Engineer');
 assert.equal(result.body.workOrder.creator_role,'system_admin');
 assert.equal(result.body.workOrder.creator_name,'Historical recorded name');
 assert.equal(f.writes(),0);
});

// The new read grant does not grant note/status/photo mutations on closed tickets.
for (const role of ['Front Desk','Housekeeping','General Manager','Assistant General Manager','Front Desk Manager','Assistant Manager','Senior Management']) test(`${role} reads own and other creators Closed tickets`, async()=>{
 const profile={id:'actor',active:true,role,full_name:'Historical recorded name'};
 assert.equal((await fixture({profile,existingStatus:'Closed',createdBy:'actor'}).get()).status,200);
 assert.equal((await fixture({profile,existingStatus:'Closed',createdBy:'other'}).get()).status,200);
 for(const status of ['Pending Verification','Completed','Will Not Do']) assert.equal((await fixture({profile,existingStatus:status,createdBy:'actor'}).get()).status,200);
});

test('new technician reads expose ticket history without expanding purchasing activity access',async()=>{
 const tables=[];
 const principal={hotelId:'hotel',identity:{id:'actor'},profile:{role:'technician',full_name:'Reader',active:true}};
 const allows=(_p,c)=>['view_dashboard','view_work_orders','edit_tickets'].includes(c);
 const admin={from(table){
  tables.push(table);
  const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},
   maybeSingle:async()=>({data:{id:'order',hotel_id:'hotel',status:'Open',created_by:'other',technician_name:'Another Technician'},error:null}),
   then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);}};
  return q;
 }};
 const exports={};vm.runInNewContext(activityCode,{exports,require(name) { if(name === "@/lib/server/work-order-parts-status") return partsStatusDependency;if(name==='@/lib/server/work-order-mentions')return {persistMentionedWorkOrder:async()=>null};if(name === "@/lib/cmpri-location-groups") return commonAreas;
  if(name.includes('work-order-read-policy')||name.includes('work-order-reader'))return ticketReadDependency(name,allows);
  if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
  if(name==='@/lib/server/access')return {allows};
  if(name==='@/lib/server/auth')return {requireUser:async()=>({principal,admin})};
  if(name==='@/lib/server/work-order-assignment')return assignmentExports;
  if(name==='@/lib/constants')return {HOTEL_ID:'hotel'};
  if(name==='@/lib/uuid')return {isUuid:()=>true};
  throw Error(name);
 }});
 assert.equal((await exports.GET({}, {params:Promise.resolve({id:'order'})})).status,200);
 assert.deepEqual(tables,['work_orders','cmpri_work_order_history']);
});

for (const role of ['Front Desk Manager','Assistant General Manager','General Manager','Maintenance Technician','Chief Engineer']) for (const status of ['Open','In Progress','Closed','Completed','Pending Verification','Will Not Do']) {
 test(`${role} correction at ${status} follows existing visibility and active statuses`,async()=>{
  const f=fixture({profile:{id:'actor',active:true,role},createdBy:'other',staffName:'Vaun',existingStatus:status,body:{issue:'Corrected fan report',location_id:'00000000-0000-0000-0000-000000000020'}});
  const eligible=role==='Chief Engineer'||['Open','In Progress'].includes(status);
  assert.equal((await f.run()).status,eligible?200:403);
  if(eligible) {assert.equal(f.saved().room,'Room 410');assert.deepEqual(Object.keys(f.saved()).sort(),['history_actor_user_id','history_source','issue','location_id','room'].sort());}
  else assert.equal(f.writes(),0);
 });
}
for(const role of ['Front Desk','Housekeeping','Senior Management','Engineer','system_admin']) test(`${role} gains no location correction permission`,async()=>{
 const f=fixture({profile:{id:'actor',active:true,role},createdBy:'actor',body:{location_id:'00000000-0000-0000-0000-000000000020'}});
 assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);
});
for(const field of ['status','priority','asset_id','notes','room','created_by','submitted_by_name','history_actor_user_id','history_source']) test(`eligible manager cannot tamper with ${field}`,async()=>{
 const f=fixture({profile:{id:'actor',active:true,role:'Front Desk Manager'},body:{issue:'Corrected',[field]:'tampered'}});
 assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);
});
for(const config of [{locationMissing:true},{locationInactive:true},{locationError:true}])test(`unavailable correction location ${JSON.stringify(config)}`,async()=>{
 const f=fixture({profile:{id:'actor',active:true,role:'Chief Engineer'},body:{location_id:'00000000-0000-0000-0000-000000000020'},...config});
 assert.equal((await f.run()).status,config.locationError?503:400);assert.equal(f.writes(),0);
});
test('Chief Engineer corrects another submitter without changing saved equipment',async()=>{
 const f=fixture({profile:{id:'actor',active:true,role:'Chief Engineer'},createdBy:'other',existingStatus:'Closed',body:{location_id:'00000000-0000-0000-0000-000000000020'}});
 assert.equal((await f.run()).status,200);assert.equal(f.saved().room,'Room 410');assert.equal(f.saved().asset_id,undefined);
});
test('generic engineer does not gain new location permission on another ticket',async()=>{
 const f=fixture({profile:{id:'actor',active:true,role:'Engineer'},createdBy:'other',body:{location_id:'00000000-0000-0000-0000-000000000020'}});
 assert.equal((await f.run()).status,403);
});

test('correction role gate never replaces row visibility and recognizes secondary canonical roles',()=>{
 const {canCorrectReport}=editPolicyExports;
 for(const role of ['Front Desk Manager','Assistant General Manager','General Manager','Maintenance Technician','Chief Engineer']) {
  assert.equal(canCorrectReport({role},'Open',false),false);
  assert.equal(canCorrectReport({role:'Senior Management',secondary_roles:[role]},'Open',true),true);
 }
 assert.equal(canCorrectReport({role:'Senior Management'},'Open',true),false);
});
test('shared-name attribution and different original author do not restrict eligible manager',async()=>{
 const f=fixture({profile:{id:'actor',active:true,role:'Front Desk Manager'},createdBy:'other',staffName:'Vaun',body:{issue:'Actual issue'}});
 assert.equal((await f.get()).body.workOrder.can_correct_report,true);
 assert.equal((await f.run()).status,200);
});

test('Chief and established dual-role Chief can transition every status pair with audit identity',async()=>{
 const statuses=['Pending Verification','Open','In Progress','Completed','Will Not Do','Closed'];
 for(const profile of [{active:true,role:'Chief Engineer'},{active:true,role:'system_admin',secondary_roles:['Chief Engineer']},{id:'750f77bf-7d5d-4ca6-8421-e025edea87ba',email:'maint.cmpri@hawkeyehotels.com',active:true,role:'system_admin',secondary_roles:['Engineer']}]){
  for(const from of statuses)for(const to of statuses){const f=fixture({profile,existingStatus:from,existingTechnician:'',body:{status:to}});assert.equal((await f.run()).status,200,`${profile.role}: ${from} -> ${to}`);assert.equal(f.saved().history_actor_user_id,'actor');assert.equal(f.saved().history_source,'CMPRI app');}
 }
});
test('generic engineer/admin and lookalike chief do not get unrestricted closed transitions',async()=>{
 for(const profile of [{active:true,role:'Engineer'},{active:true,role:'system_admin'},{id:'other',email:'maint.cmpri@hawkeyehotels.com',active:true,role:'system_admin',secondary_roles:['Engineer']}]){
 const f=fixture({profile,existingStatus:'Closed',body:{status:'Pending Verification'}});assert.notEqual((await f.run()).status,200);assert.equal(f.writes(),0);
 }
});


test('technical note saves use atomic mention results and do not fall through to another update',async()=>{
 const note='CMPRI2|2026-10-20T10:00:00Z|Author|Chief Engineer|note|@Scott';
 const f=fixture({body:{notes:note},mentionResult:{data:{id:'order',status:'Open'},error:null}});assert.equal((await f.run()).status,200);assert.equal(f.writes(),0);
 const stale=fixture({body:{notes:note},mentionResult:{data:null,error:null}});assert.equal((await stale.run()).status,409);assert.equal(stale.writes(),0);
 const fail=fixture({body:{notes:note},mentionFailure:true});assert.equal((await fail.run()).status,503);assert.equal(fail.writes(),0);
});
