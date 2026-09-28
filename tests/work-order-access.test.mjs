import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const roleExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/server/roles.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:roleExports});
const assignmentExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/server/work-order-assignment.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:assignmentExports,require(name){if(name==='./roles')return roleExports;throw new Error(name);}});
const { canAccessWorkOrderByAssignment }=assignmentExports;

const code=ts.transpileModule(readFileSync(new URL('../src/app/api/work-orders/[id]/route.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;

function fixture(config={}){
  let writes=0;let saved;
  const calls=[];
  const profile=config.profile===undefined?{id:'actor',active:true,role:'Engineer'}:config.profile;
  const existingStatus=config.existingStatus??(config.closed?'Closed':'Open');
  const existingTechnician=config.existingTechnician===undefined?'Scott':config.existingTechnician;

  const db={auth:{getUser:async()=>({data:{user:{id:'actor'}},error:null})},from(table){
    const filters=[];
    const q={
      select(){return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},in(){return q;},limit(){return q;},
      async maybeSingle(){
        calls.push({table,filters});
        if(table==='work_orders')return {data:config.missing?null:{id:'order',location_id:'room-409',asset_id:'old-asset',asset_name:'Original equipment',revision:config.currentRevision??1,status:existingStatus,technician_name:existingTechnician,last_assigned_technician_name:'Scott'},error:config.lookupError?{message:'failed'}:null};
        if(table==='assets')return {data:config.assetMissing?null:{id:'new-asset',location_id:config.wrongRoom?'room-410':'room-409',active:!config.retired,name:'Verified equipment'},error:config.assetError?{message:'failed'}:null};
        return {data:null,error:null};
      },
      update(value){writes++;saved=value;return q;},
      single:async()=>(config.concurrentStatus || config.concurrentRevision) && filters.some(([key,value])=>key==='revision'&&value!==(config.concurrentRevision??2))
        ? {data:null,error:{code:'PGRST116',message:'No matching row'}}
        : {data:{id:'order',status:String(saved?.status??existingStatus)},error:null},
    };
    return q;
  }};

  const principal=profile&&profile.active===true?{
    identity:{id:'actor',email:'actor@example.invalid'},
    profile,
    hotelId:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',
    membership:{user_id:'actor',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',role:null,active:true},
    permissions:config.denied?[{role:profile.role,permission:'manage_work_orders',allowed:false}]:[{role:profile.role,permission:'manage_work_orders',allowed:true}],
  }:null;

  const allows=(p,c)=>{
    if(!p||p.profile?.active!==true||config.permissionError||config.denied)return false;
    const role=p.profile.role;
    if(c==='view_dashboard')return ['Engineer','Chief Engineer','General Manager','Senior Management','system_admin'].includes(role);
    if(c==='edit_tickets')return ['Engineer','Chief Engineer','Maintenance Technician','system_admin'].includes(role);
    if(c==='review_tickets')return ['Chief Engineer','General Manager','system_admin'].includes(role);
    if(c==='reopen'||c==='close_tickets')return ['Engineer','Chief Engineer','system_admin'].includes(role);
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
    process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},
    require(name){
      if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
      if(name==='@supabase/supabase-js')return {createClient:()=>db};
      if(name==='server-only')return {};
      if(name==='@/lib/constants')return {HOTEL_ID:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'};
      if(name==='@/lib/supabase/config')return {SUPABASE_URL:'https://test.invalid',SUPABASE_PUBLISHABLE_KEY:'fake'};
      if(name==='@/lib/server/access')return {allows};
      if(name==='@/lib/server/auth')return authModule;
      if(name==='@/lib/server/roles')return {
        roleKey:value=>{
          const key=typeof value==='string'?value.trim().toLowerCase().replace(/[\s_-]+/g,''):'unknown';
          return key==='maintenancetechnician'?'technician':key;
        },
        roleAllows:(role,capability)=>capability==='edit_tickets'&&['Engineer','Chief Engineer','Maintenance Technician','system_admin'].includes(role),
      };
      if(name==='@/lib/server/work-order-assignment')return {canAccessWorkOrderByAssignment};
      if(name==='@/lib/work-order-categories')return {normalizeWorkOrderCategory:(value)=>typeof value==='string'&&value.trim()?value.trim():null};
      if(name==='@/lib/server/room-ranker')return {processRoomRankerSyncForWorkOrder:async()=>{}};
      throw new Error(name);
    },
  });

  const req={headers:new Headers({authorization:'Bearer fake'}),json:async()=>{
    if(config.badJson)throw Error('bad json');
    return config.nullBody?null:{expected_revision:1,...(config.body??{status:config.status||'In Progress'})};
  }};
  return {run:()=>exports.PATCH(req,{params:Promise.resolve({id:'order'})}),writes:()=>writes,saved:()=>saved,calls};
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

for(const [config,status]of [[{lookupError:true},503],[{missing:true},404]])test(`lookup failure returns ${status} without writes`,async()=>{const f=fixture(config);assert.equal((await f.run()).status,status);assert.equal(f.writes(),0);});

for(const body of [{},{issue:'  '},{issue:null},{notes:{text:'bad'}},{priority:'invented'},{cost:-1},{cost:'5'},{hours:-1},{hours:Infinity},{due_by:'not a date'},{technician_name:42},{created_by:'spoof'}])test(`invalid ticket fields rejected: ${JSON.stringify(body)}`,async()=>{
  const f=fixture({body});assert.equal((await f.run()).status,400);assert.equal(f.writes(),0);
});

test('valid amounts and optional clearing are retained while protected fields are ignored',async()=>{
  const f=fixture({body:{cost:0,hours:1.5,notes:'',due_by:null,created_by:'spoof'}});
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

test('the observed system_admin role can reopen with explicit editing permission',async()=>{
  const f=fixture({closed:true,profile:{active:true,role:'system_admin'}});assert.equal((await f.run()).status,200);
});

test('general manager can approve a pending request without technical edit rights',async()=>{
  const f=fixture({profile:{active:true,role:'General Manager'},existingStatus:'Pending Verification',body:{status:'Open',notes:'Approved',expected_revision:1}});
  const r=await f.run();assert.equal(r.status,200);assert.equal(f.saved().status,'Open');assert.equal(f.saved().notes,'Approved');
});

test('general manager cannot change technical fields during review',async()=>{
  const f=fixture({profile:{active:true,role:'General Manager'},existingStatus:'Pending Verification',body:{status:'Open',priority:'Urgent',expected_revision:1}});
  assert.equal((await f.run()).status,403);assert.equal(f.writes(),0);
});

test('general manager review is limited to pending requests',async()=>{
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

test('detail, activity, and attachment routes all share the technician assignment guard',()=>{
  const routePaths=[
    '../src/app/api/work-orders/[id]/route.ts',
    '../src/app/api/work-orders/[id]/activity/route.ts',
    '../src/app/api/work-orders/[id]/attachments/route.ts',
  ];
  for(const routePath of routePaths){
    const source=readFileSync(new URL(routePath,import.meta.url),'utf8');
    assert.match(source,/canAccessWorkOrderByAssignment\(/,`${routePath} must enforce technician assignment`);
  }
});
