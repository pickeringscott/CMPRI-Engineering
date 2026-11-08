import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {loadTs} from './helpers/load-ts.mjs';
import * as roles from '../src/lib/server/roles.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hotel=id(1),ticket=id(100);
const migration=readdirSync('supabase/migrations').find(x=>x.endsWith('_work_order_collaboration_notifications.sql'));
const sql=name=>readFileSync('supabase/migrations/'+name,'utf8');
const collaborators=[10,11,12,14,18].map(id); // Chief, system admin, assigned tech, submitter, secondary Chief.
async function database({apply=true}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table profiles(id uuid primary key,role text,secondary_roles text[] default '{}',full_name text,active boolean,preferences jsonb default '{}');
 create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
 create table work_orders(id uuid primary key,hotel_id uuid,display_id text,room text,issue text,status text,created_at timestamptz default now(),
  revision bigint default 1,created_by uuid,submitted_by_user_id uuid,source_draft_created_by uuid,creator_name text,technician_name text,notes text,history_actor_user_id uuid,history_source text);
 create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,target_path text,message text check(length(message)<=500),recorded_at timestamptz,read_at timestamptz,cleared_at timestamptz,unique(hotel_id,recipient_user_id,notification_key));
 create table cmpri_web_push_subscriptions(id uuid primary key,hotel_id uuid,recipient_user_id uuid,enabled boolean);
 create table cmpri_web_push_deliveries(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,subscription_id uuid,notification_key text,status text,unique(hotel_id,recipient_user_id,subscription_id,notification_key));
 create table cmpri_pool_control(hotel_id uuid,revision bigint);create table room_operations(hotel_id uuid,room text);
 create table cmpri_room_operation_imports(hotel_id uuid);create table user_feedback(hotel_id uuid);create table cmpri_work_order_drafts(hotel_id uuid);
 create table cmpri_work_order_history(id uuid primary key default gen_random_uuid(),hotel_id uuid,work_order_id uuid,actor_user_id uuid,actor_name text,event_type text,old_status text,new_status text,changed_fields jsonb,snapshot jsonb,source text,recorded_at timestamptz default now());
 create table cmpri_work_order_technician_views(id uuid primary key default gen_random_uuid(),hotel_id uuid,work_order_id uuid,work_order_display_id text,viewed_at timestamptz default now());
 create table cmpri_work_order_engineering_views(hotel_id uuid,work_order_id uuid,work_order_display_id text,engineering_user_id uuid,viewed_at timestamptz,unique(hotel_id,work_order_id,engineering_user_id));
 create function capture_actor_and_revision() returns trigger language plpgsql as $$begin
  perform set_config('cmpri.history_actor',coalesce(new.history_actor_user_id::text,''),true);
  perform set_config('cmpri.history_source',coalesce(new.history_source,''),true);
  new.history_actor_user_id=null;new.history_source=null;
  if tg_op='UPDATE' then new.revision=old.revision+1;end if;return new;end$$;
 create trigger capture_actor_and_revision before insert or update on work_orders for each row execute function capture_actor_and_revision();`);
 await db.exec(sql('20261013143835_cmpri_prospective_event_push.sql'));
 await db.exec(sql('20261106133302_event_driven_resources.sql'));
 await db.exec(sql('20260930220000_cmpri_work_order_history_notifications.sql'));
 await db.exec(sql('20261008174000_cmpri_group5_work_order_notifications.sql'));
 await db.exec('create trigger cmpri_work_order_history_log after insert or update of status,technician_name on work_orders for each row execute function cmpri_log_work_order_history();');
 const people=[
  [10,'Chief Engineer',[],'Chief Person',true,hotel,true],
  [11,'system_admin',[],'Admin Person',true,hotel,true],
  [12,'Maintenance Technician',[],'Assigned Tech',true,hotel,true],
  [13,'Maintenance Technician',[],'Other Tech',true,hotel,true],
  [14,'Front Desk',[],'Submitter Person',true,hotel,true],
  [15,'General Manager',[],'Manager Person',true,hotel,true],
  [16,'Chief Engineer',[],'Inactive Chief',false,hotel,true],
  [17,'Chief Engineer',[],'Other Hotel Chief',true,id(2),true],
  [18,'Lead Housekeeper',['Chief Engineer'],'Secondary Chief',true,hotel,true],
  [19,'Chief Engineer',[],'Inactive Membership',true,hotel,false],
  [20,'Engineer',[],'Unrelated Engineer',true,hotel,true],
 ];
 for(const [n,role,secondary,name,active,h,memberActive] of people){
  await db.query('insert into auth.users values($1)',[id(n)]);
  await db.query('insert into profiles(id,role,secondary_roles,full_name,active) values($1,$2,$3,$4,$5)',[id(n),role,secondary,name,active]);
  await db.query('insert into hotel_members values($1,$2,$3)',[h,id(n),memberActive]);
  await db.query('insert into cmpri_web_push_subscriptions values($1,$2,$3,true)',[id(n+50),h,id(n)]);
 }
 if(apply)await db.exec(sql(migration));
 return db;
}
async function create(db,{key=ticket,status='Open',creator=id(14),submitted=null,notes='Initial note supplied with ticket',assigned='Assigned Tech',actor=creator}={}){
 await db.query('insert into work_orders(id,hotel_id,display_id,room,issue,status,created_by,submitted_by_user_id,technician_name,notes,history_actor_user_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[key,hotel,'workorder_261108001','204','Leaking faucet',status,creator,submitted,assigned,notes,actor]);
}
const inbox=async(db,prefix)=>(await db.query('select * from cmpri_dashboard_notifications where notification_key like $1 order by recipient_user_id',[prefix+'%'])).rows;
const note=n=>`CMPRI2|2026-11-08T12:00:${String(n).padStart(2,'0')}Z|Manager|General Manager|note|New comment ${n}`;
async function append(db,text,actor=id(15)){
 await db.query("update work_orders set notes=coalesce(notes,'')||E'\n'||$1,history_actor_user_id=$2 where id=$3",[text,actor,ticket]);
}

test('creation emits one approval OR open-by-manager event per existing recipient; initial notes never emit note/status alerts',async()=>{
 const db=await database();try{
  await create(db,{status:'Pending Verification',notes:note(0)});
  let rows=await inbox(db,'new-order:');
  assert.deepEqual(rows.map(x=>x.recipient_user_id),[10,11,12,13,18].map(id));
  assert.ok(rows.every(x=>x.message.includes('needs approval')&&!x.message.includes('created open')));
  assert.equal((await inbox(db,'work-order-note:')).length,0);assert.equal((await inbox(db,'work-order-status:')).length,0);
  await db.query("insert into cmpri_work_order_history(hotel_id,work_order_id,actor_user_id,event_type,new_status,changed_fields,snapshot) values($1,$2,$3,'created','Pending Verification',$4,$5)",[hotel,ticket,id(12),{actor_role:'Maintenance Technician'},{display_id:'workorder_261108001'}]);
  assert.equal((await inbox(db,'new-order:')).length,rows.length);
  await create(db,{key:id(101),creator:id(15),notes:note(1)});
  rows=(await inbox(db,'new-order:')).filter(x=>x.work_order_id===id(101));
  assert.equal(rows.length,5);assert.ok(rows.every(x=>/created open by manager Manager Person/.test(x.message)&&!x.message.includes('needs approval')));
  assert.equal((await inbox(db,'work-order-note:')).length,0);
 }finally{await db.close();}
});

test('notes reach every Chief, the assigned technician and original submitter, once per save, including the author',async()=>{
 const db=await database();try{
  await create(db);await append(db,note(1),id(12));
  let rows=await inbox(db,'work-order-note:');assert.deepEqual(rows.map(x=>x.recipient_user_id),collaborators);
  assert.ok(rows.every(x=>x.push_requested&&x.message.includes('New note on WO#261108001 (204) by Assigned.')));
  const deliveries=(await db.query("select * from cmpri_web_push_deliveries where notification_key like 'work-order-note:%'")).rows;assert.equal(deliveries.length,5);
  await db.query('update work_orders set notes=notes where id=$1',[ticket]);assert.equal((await inbox(db,'work-order-note:')).length,5);
  await append(db,note(2)+'\n'+note(3),id(10));
  rows=await inbox(db,'work-order-note:');assert.equal(rows.length,10);assert.equal(rows.filter(x=>x.message.includes('2 new notes')&&x.recipient_user_id===id(10)).length,1);
  assert.ok(rows.every(x=>![id(13),id(15),id(16),id(17),id(19),id(20)].includes(x.recipient_user_id)));
 }finally{await db.close();}
});

test('system/change entries and removed notes do not alert; plain appended comments do',async()=>{
 const db=await database();try{
  await create(db);await append(db,'CMPRI2|now|Manager|General Manager|change|Status updated\nCMPRI|now|System|system|Imported history');
  assert.equal((await inbox(db,'work-order-note:')).length,0);
  await db.query('update work_orders set notes=$1 where id=$2',['',ticket]);assert.equal((await inbox(db,'work-order-note:')).length,0);
  await append(db,'Plain comment');assert.equal((await inbox(db,'work-order-note:')).length,5);
 }finally{await db.close();}
});

test('status changes from every author target the same collaborators; no legacy duplicate status event is emitted',async()=>{
 const db=await database();try{
  await create(db);
  for(const [status,actor] of [['In Progress',15],['Closed',10],['Open',12]]){
   await db.query('update work_orders set status=$1,history_actor_user_id=$2 where id=$3',[status,id(actor),ticket]);
   const rows=(await inbox(db,'work-order-status:')).filter(x=>x.message.includes('→ '+status+' by'));
   assert.deepEqual(rows.map(x=>x.recipient_user_id),collaborators);
  }
  assert.equal((await inbox(db,'history:')).length,0);assert.equal((await inbox(db,'work-order-status:')).length,15);
  await db.query('update work_orders set status=status where id=$1',[ticket]);assert.equal((await inbox(db,'work-order-status:')).length,15);
  assert.equal((await inbox(db,'work-order-note:')).length,0);
 }finally{await db.close();}
});

test('overlapping Chief/assignee/submitter roles deduplicate; the original draft submitter wins over the approver',async()=>{
 const db=await database();try{
  await create(db,{creator:id(10),assigned:'Chief Person'});await append(db,note(1));
  assert.deepEqual((await inbox(db,'work-order-note:')).map(x=>x.recipient_user_id),[10,11,18].map(id));
  await db.query('update work_orders set created_by=$1,submitted_by_user_id=$2,source_draft_created_by=$3,technician_name=$4 where id=$5',[id(15),id(15),id(14),'Assigned Tech',ticket]);
  await append(db,note(2));const rows=(await inbox(db,'work-order-note:')).filter(x=>x.message.includes('Manager.'));
  const latest=(await db.query("select recipient_user_id from cmpri_dashboard_notifications where notification_key=(select notification_key from cmpri_dashboard_notifications where notification_key like 'work-order-note:%' order by recorded_at desc limit 1) order by recipient_user_id")).rows;
  assert.deepEqual(latest.map(x=>x.recipient_user_id),collaborators);assert.ok(rows.length>0);
 }finally{await db.close();}
});

test('assignment and viewed notifications keep their existing recipients and messages',async()=>{
 const db=await database();try{
  await create(db);
  await db.query('update work_orders set technician_name=$1,history_actor_user_id=$2 where id=$3',['Other Tech',id(10),ticket]);
  const assigned=(await db.query("select * from cmpri_dashboard_notifications where message like '%was assigned to you.'")).rows;
  assert.deepEqual(assigned.map(x=>x.recipient_user_id),[id(13)]);
  await db.query('insert into cmpri_work_order_technician_views(hotel_id,work_order_id,work_order_display_id) values($1,$2,$3)',[hotel,ticket,'WO#261108001']);
  assert.deepEqual((await inbox(db,'technician-view:')).map(x=>x.recipient_user_id),[10,11,18].map(id));
 }finally{await db.close();}
});

test('rollout creates no historical alerts; inbox failure rolls back the note; private functions cannot be invoked by browser roles',async()=>{
 const db=await database({apply:false});try{
  await create(db,{notes:note(0)});const before=(await db.query('select count(*)::int n from cmpri_dashboard_notifications')).rows[0].n;
  await db.exec(sql(migration));assert.equal((await db.query('select count(*)::int n from cmpri_dashboard_notifications')).rows[0].n,before);
  await db.exec("create function reject_note() returns trigger language plpgsql as $$begin if new.notification_key like 'work-order-note:%' then raise exception 'Inbox unavailable';end if;return new;end$$;create trigger reject_note before insert on cmpri_dashboard_notifications for each row execute function reject_note();");
  await assert.rejects(append(db,note(1)),/Inbox unavailable/);
  let row=(await db.query('select notes,revision from work_orders where id=$1',[ticket])).rows[0];assert.equal(row.notes,note(0));assert.equal(Number(row.revision),1);
  await db.exec('drop trigger reject_note on cmpri_dashboard_notifications');await append(db,note(1));assert.equal((await inbox(db,'work-order-note:')).length,5);
  for(const role of ['anon','authenticated']){
   assert.equal((await db.query("select has_function_privilege($1,'cmpri_private.notify_work_order_collaborators(uuid,uuid,text,text,timestamptz)','execute') ok",[role])).rows[0].ok,false);
   assert.equal((await db.query("select has_function_privilege($1,'cmpri_private.notify_added_work_order_notes()','execute') ok",[role])).rows[0].ok,false);
  }
 }finally{await db.close();}
});

test('targeted note/status phone eligibility does not change any other notification category',()=>{
 const policy=loadTs('src/lib/notifications/event-eligibility.ts',{'@/lib/server/roles':roles});
 for(const role of ['Chief Engineer','Maintenance Technician','Front Desk','Lead Housekeeper','General Manager','system_admin']){
  for(const prefix of ['work-order-note:','work-order-status:']){
   assert.equal(policy.receivesEventPush({role},{id:prefix+'fixture',work_order_id:ticket}),true);
   assert.equal(policy.receivesEventPush({role},{id:prefix+'fixture'}),false);
  }
  assert.equal(policy.receivesEventPush({role},{id:'new-order:fixture',work_order_id:ticket}),roles.receivesWorkOrderNotifications({role}));
  assert.equal(policy.receivesEventPush({role},{id:'pool-closed:fixture'}),roles.receivesPoolClosedNotifications({role}));
 }
});

test('migration refuses to overwrite an independently changed notification producer',async()=>{
 const db=await database({apply:false});try{
  await db.exec("create or replace function cmpri_private.materialize_work_notification() returns trigger language plpgsql security definer set search_path='' as $$begin return null;end$$;");
  await assert.rejects(db.exec(sql(migration)),/notification policy changed/);
  await db.exec('rollback');
  assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname='event_work_notes'")).rows[0].n,0);
 }finally{await db.close();}
});
