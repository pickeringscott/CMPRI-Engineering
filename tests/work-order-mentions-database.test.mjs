import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migrations=new URL('../supabase/migrations/',import.meta.url);
const sql=name=>readFileSync(new URL(name,migrations),'utf8');
const migration=readdirSync(migrations).find(name=>name.endsWith('_work_order_mentions.sql'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('real PostgreSQL commits note, mention inbox and captured phone delivery together; retries and failures cannot duplicate or lose alerts',async()=>{
 assert.ok(migration);const db=new PGlite();
 try{
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table profiles(id uuid primary key,full_name text,active boolean,preferences jsonb default '{}');
 create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
 create type work_order_status as enum ('Open','In Progress','Closed');
 create table work_orders(id uuid primary key,hotel_id uuid,revision bigint default 1,display_id text,status work_order_status,notes text,issue text,location_id uuid,room text,asset_id uuid,asset_name text,category text,priority text,technician_name text,action_root_cause text,parts text,cost numeric,hours numeric,due_by timestamptz,history_actor_user_id uuid,history_source text);
 create function bump_revision() returns trigger language plpgsql as $$begin new.revision=old.revision+1;return new;end$$;
 create trigger bump_revision before update on work_orders for each row execute function bump_revision();
 create table status_column_updates(id integer);
 create function record_status_column_update() returns trigger language plpgsql as $$begin insert into status_column_updates values(1);return new;end$$;
 create trigger record_status_column_update after update of status on work_orders for each row execute function record_status_column_update();
 create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,target_path text,message text,recorded_at timestamptz,read_at timestamptz,cleared_at timestamptz,unique(hotel_id,recipient_user_id,notification_key),constraint note_target check (((work_order_id is not null) and (target_path is null)) or ((work_order_id is null) and target_path in ('/engineering/room-operations','/engineering/pool-log'))));
 create table cmpri_web_push_subscriptions(id uuid primary key,hotel_id uuid,recipient_user_id uuid,enabled boolean);
 create table cmpri_web_push_deliveries(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,subscription_id uuid,notification_key text,status text,unique(hotel_id,recipient_user_id,subscription_id,notification_key));`);
 await db.exec(sql('20261013143835_cmpri_prospective_event_push.sql'));
 await db.exec(sql(migration));
 for(let n=10;n<=15;n++){
  await db.query('insert into profiles(id,full_name,active) values($1,$2,$3)',[id(n),n===10?'Scott Pickering':`Staff ${n}`,n!==13]);
  await db.query('insert into hotel_members values($1,$2,$3)',[id(n),n===14?id(2):id(1),n!==15]);
  await db.query('insert into cmpri_web_push_subscriptions values($1,$2,$3,true)',[id(n+20),id(1),id(n)]);
 }
 await db.query(`update profiles set preferences='{"notifications":{"mentions":false}}' where id=$1`,[id(12)]);
 await db.query("insert into work_orders(id,hotel_id,display_id,status,notes,issue) values($1,$2,'WO-123','Open','Original notes','Keep issue')",[id(3),id(1)]);
 const update={notes:'Original notes\nCMPRI2|2026-10-20T10:00:00Z|Scott|Chief Engineer|note|@Staff please check',history_actor_user_id:id(10),history_source:'CMPRI app'};
 const call=(revision=1,patch=update,hotel=id(1),recipients=[10,11,11,12,13,14,15].map(id))=>db.query('select cmpri_save_mentioned_work_order($1,$2,$3,$4,$5,$6,true) as saved',[hotel,id(3),id(10),revision,patch,recipients]);
 const result=await call();assert.equal(result.rows[0].saved.revision,2);assert.equal(result.rows[0].saved.notes,update.notes);assert.equal(result.rows[0].saved.issue,'Keep issue');
 let inbox=(await db.query('select * from cmpri_dashboard_notifications')).rows;
 assert.equal(inbox.length,1);assert.equal(inbox[0].recipient_user_id,id(11));assert.equal(inbox[0].work_order_id,id(3));assert.equal(inbox[0].target_path,null);assert.equal((await db.query('select count(*)::int n from status_column_updates')).rows[0].n,0);assert.match(inbox[0].message,/^Scott mentioned you in WO#123 notes\./);assert.ok(!inbox[0].message.includes('Pickering'));
 const deliveries=(await db.query('select * from cmpri_web_push_deliveries')).rows;assert.equal(deliveries.length,1);assert.equal(deliveries[0].status,'pending');
 assert.equal((await call()).rows[0].saved,null);await assert.rejects(call(2,update,id(2)),/Active hotel membership is required/);
 assert.equal((await db.query('select count(*)::int n from cmpri_dashboard_notifications')).rows[0].n,1);
 // Provider intent/inbox failure must roll back the note and revision as well.
 await db.exec(`create function fail_alert() returns trigger language plpgsql as $$begin raise exception 'Inbox unavailable';end$$;create trigger fail_alert before insert on cmpri_dashboard_notifications for each row execute function fail_alert();`);
 await assert.rejects(call(2,{...update,notes:update.notes+'\nAnother mention'}),/Inbox unavailable/);
 let ticket=(await db.query('select * from work_orders')).rows[0];assert.equal(ticket.revision,2);assert.equal(ticket.notes,update.notes);
 await db.exec('drop trigger fail_alert on cmpri_dashboard_notifications');
 const retry=await call(2,{...update,notes:update.notes+'\nAnother mention'});assert.equal(retry.rows[0].saved.revision,3);
 assert.equal((await db.query('select count(*)::int n from cmpri_dashboard_notifications')).rows[0].n,2);
 await assert.rejects(call(3,{...update,hotel_id:id(2)}),/Invalid mentioned work-order update/);
 await db.query("update work_orders set status='Closed' where id=$1",[id(3)]);
 assert.equal((await call(4)).rows[0].saved,null);
 const signature='public.cmpri_save_mentioned_work_order(uuid,uuid,uuid,integer,jsonb,uuid[],boolean)';
 for(const role of ['anon','authenticated'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') ok',[role,signature])).rows[0].ok,false);
 assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') ok',['service_role',signature])).rows[0].ok,true);
 }finally{await db.close()}
});
