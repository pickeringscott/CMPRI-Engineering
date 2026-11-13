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

const readPolicy=loadTs('src/lib/work-order-read-policy.ts');
const reader=loadTs('src/lib/server/work-order-reader.ts',{'./access':access,'./roles':roles});
const uuid=loadTs('src/lib/uuid.ts');
const alertId='00000000-0000-4000-8000-000000000003';
function alertFixture(overrides={}) {
 const authState=auth('engineer');
 let order={id:alertId,hotel_id:authState.principal.hotelId,location_id:'room-101',room:'Room 101',priority:'Urgent',ranker_base_priority:'Low',ranker_alert_active:true,status:'Open',...overrides};
 let relatedReads=0;
 authState.admin={from(){
  const query={};
  for(const method of ['select','eq','neq','in','order'])query[method]=()=>query;
  query.maybeSingle=async()=>({data:order,error:null});
  query.then=(resolve)=>{relatedReads++;return Promise.resolve({data:[],error:null}).then(resolve);};
  return query;
 }};
 const route=loadTs('src/app/api/work-orders/[id]/ranker-alert/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200,headers:init.headers})}},
  '@/lib/server/auth':{requireUser:async()=>authState},
  '@/lib/server/work-order-reader':reader,'@/lib/work-order-read-policy':readPolicy,
  '@/lib/uuid':uuid,'@/lib/ticket-room-ranking':ranking,
 });
 return {read:()=>route.GET({}, {params:Promise.resolve({id:alertId})}),set:value=>{order={...order,...value};},relatedReads:()=>relatedReads};
}

test('work-order escalation flag clears when the original priority is restored despite historical flag',async()=>{
 const fixture=alertFixture();
 assert.equal((await fixture.read()).body.active,true);
 fixture.set({priority:'Medium'});
 assert.equal((await fixture.read()).body.active,true); // Three Low tickets still meet the Medium rule.
 fixture.set({priority:'Low'});
 const response=await fixture.read();
 assert.equal(response.body.active,false);
 assert.equal(response.body.related.length,0);
 assert.match(response.headers['Cache-Control'],/no-store/);
 assert.equal(fixture.relatedReads(),2);
});

test('natural priorities and finished work orders do not show an escalation flag',async()=>{
 for(const fields of [{priority:'High',ranker_base_priority:'High'},{priority:'Urgent',ranker_base_priority:'Urgent'},{ranker_base_priority:null},...['Completed','Closed','Will Not Do'].map(status=>({status}))]){
  const fixture=alertFixture(fields);
  assert.equal((await fixture.read()).body.active,false);
  assert.equal(fixture.relatedReads(),0);
 }
});

test('current escalation is visible even when no historical alert was recorded',async()=>{
 const fixture=alertFixture({priority:'Medium',ranker_base_priority:'Low',ranker_alert_active:false});
 assert.equal((await fixture.read()).body.active,true);
});

test('production Room Ranker calculation lowers priorities and restores original priority and due date',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const {readFileSync}=await import('node:fs');
 const db=new PGlite();
 try {
  await db.exec(`
   create role anon; create role authenticated; create schema cmpri_private;
   create table public.locations(id uuid primary key,hotel_id uuid,name text,room_number text,location_type text,active boolean);
   create table public.work_orders(id uuid primary key,hotel_id uuid,location_id uuid,room text,priority text,status text,due_by timestamptz,ranker_base_priority text,ranker_auto_urgent boolean default false,ranker_base_due_by timestamptz);
   create table cmpri_private.room_rank_state(hotel_id uuid,location_id uuid,rank text,primary key(hotel_id,location_id));
   insert into public.locations values ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','Room 101','101','Guest Room',true);
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261111022952_work_order_ranker_alert.sql',import.meta.url),'utf8'));
  const source=readFileSync(new URL('../supabase/migrations/20261109175913_room_ranker_automatic_escalation.sql',import.meta.url),'utf8');
  for(const name of ['room_ranker_location','room_ranker_recalculate']){
   const start=source.indexOf('create function cmpri_private.'+name+'(');
   assert.ok(start>=0);
   await db.exec(source.slice(start,source.indexOf('$$;',start)+3));
  }
  const recalculate=()=>db.exec("select cmpri_private.room_ranker_recalculate('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101',false)");
  const tickets=async()=> (await db.query('select priority,ranker_base_priority,ranker_auto_urgent,due_by::date::text from public.work_orders order by id')).rows;
  await db.exec(`insert into public.work_orders(id,hotel_id,location_id,room,priority,ranker_base_priority,status,due_by)
   select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','Room 101','Low','Low','Open','2030-01-01' from generate_series(1,4) n`);
  await recalculate();
  assert.ok((await tickets()).every(ticket=>ticket.priority==='Urgent'&&ticket.ranker_auto_urgent&&ranking.isTicketAutomaticallyEscalated(ticket)));
  await db.exec("update public.work_orders set status='Completed' where id='00000000-0000-0000-0000-000000000004'");
  await recalculate();
  assert.deepEqual((await tickets()).map(ticket=>ticket.priority),['Medium','Medium','Medium','Low']);
  assert.ok((await tickets()).every(ticket=>!ticket.ranker_auto_urgent&&ticket.due_by==='2030-01-01'));
  await db.exec("update public.work_orders set status='Completed' where id='00000000-0000-0000-0000-000000000003'");
  await recalculate();
  assert.ok((await tickets()).every(ticket=>ticket.priority==='Low'&&ticket.ranker_base_priority==='Low'&&!ranking.isTicketAutomaticallyEscalated(ticket)));
  await db.exec("delete from public.work_orders; insert into public.work_orders(id,hotel_id,location_id,room,priority,ranker_base_priority,status,due_by) select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','Room 101','Medium','Medium','Open','2031-02-03' from generate_series(1,3) n");
  await recalculate();
  assert.ok((await tickets()).every(ticket=>ticket.priority==='Urgent'));
  await db.exec("update public.work_orders set status='Closed' where id='00000000-0000-0000-0000-000000000003'");
  await recalculate();
  assert.ok((await tickets()).every(ticket=>ticket.priority==='Medium'&&ticket.ranker_base_priority==='Medium'&&ticket.due_by==='2031-02-03'&&!ranking.isTicketAutomaticallyEscalated(ticket)));
 } finally {await db.close();}
});
