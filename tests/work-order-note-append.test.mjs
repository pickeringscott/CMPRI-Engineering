import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
const roles=loadTs('src/lib/server/roles.ts');
const hotel='hotel';const id='00000000-0000-4000-8000-000000000042';
function fixture({role='technician',status='Open',otherHotel=false,race=false,authenticated=true,mentionResult=null,mentionFailure=false}={}) {
 const writes=[];const filters=[];const existing={id,notes:'Original requester\nCMPRI|2026-01-01|Other Person|note|Existing finding',status,revision:7};
 const admin={from(table){assert.equal(table,'work_orders');let mutation;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},in(k,v){filters.push([k,Array.from(v)]);return q},update(v){mutation=v;writes.push(v);return q},async maybeSingle(){return {data:mutation?(race?null:{...existing,...mutation,revision:8}):(otherHotel?null:existing),error:null}}};return q}};
 const principal={identity:{id:'actor-id'},profile:{role,full_name:'Actual Author'},hotelId:hotel};
 const route=loadTs('src/app/api/work-orders/[id]/notes/route.ts',{
 'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200})}},
 '@/lib/server/work-order-mentions':{persistMentionedWorkOrder:async()=>{if(mentionFailure)throw Error("directory offline");return mentionResult;}},
 '@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/auth':{requireUser:async()=>authenticated?{principal,admin}:null},
 '@/lib/server/access':{allows:(_,cap)=>roles.roleAllows(role,cap)},'@/lib/uuid':loadTs('src/lib/uuid.ts'),
 '@/lib/account-display':loadTs('src/lib/account-display.ts'),'@/lib/ticket-note-presentation':loadTs('src/lib/ticket-note-presentation.ts')});
 return {writes,filters,existing,run:(body={notes:['Correct finding'],expected_revision:7})=>route.POST({json:async()=>body,headers:new Headers()}, {params:Promise.resolve({id})})};
}
for(const role of ['front_desk','housekeeping','front_desk_manager','assistant_manager','manager','senior_management','technician','engineer','chief_engineer','system_admin']) {
 for(const status of ['Pending Verification','Open','In Progress','Completed','Closed','Will Not Do']) test(`${role} appends to another person's ${status} ticket without replacing history`,async()=>{
  const f=fixture({role,status});const r=await f.run();assert.equal(r.status,200);assert.ok(f.writes[0].notes.startsWith(f.existing.notes+'\n'));assert.match(f.writes[0].notes,/Actual Author\|[^|]+\|note\|Correct finding$/);assert.equal(f.writes[0].history_actor_user_id,'actor-id');assert.deepEqual(Object.keys(f.writes[0]).sort(),['history_actor_user_id','history_source','notes']);assert.ok(f.filters.some(([k,v])=>k==='hotel_id'&&v===hotel));assert.ok(f.filters.some(([k,v])=>k==='revision'&&v===7));
 });

}
test('append validates payload, attribution, isolation, authentication and stale versions',async()=>{
 for(const body of [{notes:['x'],expected_revision:7,status:'Closed'},{notes:['x'],expected_revision:7,actor:'Spoof'},{notes:[],expected_revision:7},{notes:[''],expected_revision:7}]){const f=fixture();assert.equal((await f.run(body)).status,400);assert.equal(f.writes.length,0)}
 for(const [options,status] of [[{otherHotel:true},404],[{authenticated:false},403],[{role:'unknown'},403],[{race:true},409]])assert.equal((await fixture(options).run()).status,status);
 const f=fixture();assert.equal((await f.run({notes:['x'],expected_revision:6})).status,409);assert.equal(f.writes.length,0);
});


test('recognized commenters can submit notes on every accessible ticket status',()=>{
 const policy=loadTs('src/lib/work-order-edit-policy.ts');
 for(const status of ['Closed','Pending Verification','Completed','Will Not Do']) assert.equal(policy.canSubmitWorkOrderNote({role:'technician',canEdit:false,canReview:false,canAddNotes:true,status}),true,status);
 for(const status of ['Open','In Progress']) assert.equal(policy.canSubmitWorkOrderNote({role:'technician',canEdit:false,canReview:false,canAddNotes:true,status}),true,status);
});


test('append-only saves consume atomic mention results, retain stale/failed notes and never double-save',async()=>{
 const saved=fixture({mentionResult:{data:{id,revision:8},error:null}});assert.equal((await saved.run({notes:['@Scott'],expected_revision:7})).status,200);assert.equal(saved.writes.length,0);
 const stale=fixture({mentionResult:{data:null,error:null}});assert.equal((await stale.run({notes:['@Scott'],expected_revision:7})).status,409);assert.equal(stale.writes.length,0);
 const offline=fixture({mentionFailure:true});assert.equal((await offline.run({notes:['@Scott'],expected_revision:7})).status,503);assert.equal(offline.writes.length,0);
});
