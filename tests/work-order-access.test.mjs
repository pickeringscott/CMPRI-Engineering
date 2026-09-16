import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../src/app/api/work-orders/[id]/route.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
function fixture(config={}){
  let writes=0;let saved;
  const calls=[];
  const profile=config.profile===undefined?{id:'actor',active:true,role:'Engineer'}:config.profile;
  const db={auth:{getUser:async()=>({data:{user:{id:'actor'}},error:null})},from(table){
    const filters=[];
    const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},in(){return q;},limit(){return q;},
      async maybeSingle(){calls.push({table,filters});
        if(table==='profiles')return {data:profile,error:config.profileError?{message:'failed'}:null};
        if(table==='role_permissions')return {data:config.denied?null:{permission:'edit_work_orders'},error:config.permissionError?{message:'failed'}:null};
        if(table==='work_orders')return {data:config.missing?null:{id:'order',location_id:'room-409',asset_id:'old-asset',asset_name:'Original equipment',revision:config.currentRevision??1,status:config.closed?'Closed':'Open',technician_name:'Scott',last_assigned_technician_name:'Scott'},error:config.lookupError?{message:'failed'}:null};
        if(table==='assets')return {data:config.assetMissing?null:{id:'new-asset',location_id:config.wrongRoom?'room-410':'room-409',active:!config.retired,name:'Verified equipment'},error:config.assetError?{message:'failed'}:null};
      },
      update(value){writes++;saved=value;return q;},single:async()=>(config.concurrentStatus || config.concurrentRevision) && filters.some(([key,value])=>key==='revision'&&value!==(config.concurrentRevision??2))
        ? {data:null,error:{code:'PGRST116',message:'No matching row'}}
        : {data:{id:'order',status:'In Progress'},error:null}};return q;
  }};
  const exports={};vm.runInNewContext(code,{exports,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},require(name){
    if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
    if(name==='@supabase/supabase-js')return {createClient:()=>db};
    if(name==='server-only')return {};
    if(name==='@/lib/constants')return {HOTEL_ID:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'};
    if(name==='@/lib/server/access')return {allows:(p,c)=>{if(c==='edit_tickets')return p&&p.profile&&['Engineer','system_admin'].includes(p.profile.role);if(c==='view_dashboard')return true;if(c==='reopen')return p&&p.profile&&['Engineer','system_admin'].includes(p.profile.role);if(c==='close_tickets')return p&&p.profile&&['Engineer','system_admin'].includes(p.profile.role);return false}};
    if(name==='@/lib/server/auth')return {requireCapability:async()=>{const u=await db.auth.getUser();if(u.error||!u.data?.user)return null;const p=await db.from('profiles').select().eq('id',u.data.user.id).maybeSingle();if(p.error||!p.data||p.data.active!==true)return null;return {principal:{identity:u.data.user,profile:p.data,membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:db}},requireCapability:async()=>{const u=await db.auth.getUser();if(u.error||!u.data?.user)return null;const p=await db.from('profiles').select().eq('id',u.data.user.id).maybeSingle();if(p.error||!p.data||p.data.active!==true)return null;const perm=await db.from('role_permissions').select().eq('role',p.data.role).maybeSingle();if(perm.error||!perm.data)return null;return {principal:{identity:u.data.user,profile:p.data,membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:db}}};
    if(name==='@/lib/work-order-categories')return {WORK_ORDER_STATUSES:['Open','In Progress','Closed','Pending Verification'],normalizeWorkOrderStatus:function(s){return s}};
    if(name==='@/lib/server/room-ranker')return {processRoomRankerSyncForWorkOrder:async()=>{}};throw new Error(name);
  }});
  const req={headers:new Headers({authorization:'Bearer fake'}),json:async()=>{if(config.badJson)throw Error('bad json');return config.nullBody?null:{expected_revision:1,...(config.body??{status:config.status||'In Progress'})};}};
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
