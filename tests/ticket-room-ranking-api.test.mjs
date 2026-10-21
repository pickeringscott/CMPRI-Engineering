import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
const roles=loadTs('src/lib/server/roles.ts');
const access=loadTs('src/lib/server/access.ts',{'./roles':roles});
const ranking=loadTs('src/lib/ticket-room-ranking.ts');
const pagination=loadTs('src/lib/server/paginated-query.ts');
let current=null, calls=[], fail=false;
const api=loadTs('src/app/api/ticket-room-ranker/route.ts',{
 'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200,headers:init.headers})}},
 '@/lib/server/auth':{requireUser:async()=>current},'@/lib/server/access':access,
 '@/lib/ticket-room-ranking':ranking,'@/lib/server/paginated-query':pagination,
});
function auth(role){const id='00000000-0000-4000-8000-000000000001';const hotel='00000000-0000-4000-8000-000000000002';return {principal:{identity:{id},profile:{id,role,active:true},membership:{user_id:id,hotel_id:hotel,active:true,role:'admin'},hotelId:hotel,permissions:[]},admin:{from(table){const query={};for(const method of ['select','eq','not','order'])query[method]=(...args)=>{calls.push([table,method,...args]);return query};query.range=async()=>({data:table==='locations'?[{id:'r1',name:'Room 101',room_number:'101',active:true,location_type:'Guest Room'}]:[{id:'t1',location_id:'r1',room:'Room 101',priority:'High',status:'Open',issue:'HVAC'}],error:fail?{message:'fail'}:null});return query}}}}
test('unauthenticated and inactive principals cannot load ranking',async()=>{
 current=null;assert.equal((await api.GET({})).status,401);
 current=auth('manager');current.principal.profile.active=false;assert.equal((await api.GET({})).status,403);
 current=auth('engineer');current.principal.membership.active=false;assert.equal((await api.GET({})).status,403);
});
test('existing dashboard users including manager roles read property-scoped live data without mutations',async()=>{
 for(const role of ['engineer','manager','senior_management','technician','front_desk_manager','assistant_manager','front_desk','housekeeping','system_admin']){
  calls=[];current=auth(role);const response=await api.GET({});assert.equal(response.status,200,role);assert.equal(response.body.rooms[0].rank,'C');assert.match(response.headers['Cache-Control'],/no-store/);
  for(const table of ['locations','work_orders'])assert(calls.some(c=>c[0]===table&&c[1]==='eq'&&c[2]==='hotel_id'&&c[3]===current.principal.hotelId));
  assert(calls.some(c=>c[0]==='work_orders'&&c[1]==='not'&&c[2]==='status'));assert(!Object.hasOwn(api,'PATCH'));
 }
});
test('query failure returns 503 instead of a false all-A ranking',async()=>{current=auth('manager');fail=true;try{assert.equal((await api.GET({})).status,503)}finally{fail=false}});
