import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const sql=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('atomic real PostgreSQL correction history, Chief-only persistent push intent, no-op and retry behavior',async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function is_hotel_member(uuid) returns boolean language sql stable as $$select true$$;
 create table hotels(id uuid primary key);
 create table profiles(id uuid primary key,full_name text,role text,secondary_roles text[],email text,active boolean);
 create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
 create table work_orders(id uuid primary key,hotel_id uuid,created_by uuid,submitted_by_user_id uuid,submitted_by_name text,creator_name text,display_id text,status text,technician_name text,room text,location_id uuid,issue text,asset_id uuid,notes text);
 create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,message text,recorded_at timestamptz default clock_timestamp(),read_at timestamptz,cleared_at timestamptz,unique(hotel_id,recipient_user_id,notification_key));
 create table cmpri_web_push_subscriptions(id uuid primary key,hotel_id uuid,recipient_user_id uuid,enabled boolean);
 create table cmpri_web_push_deliveries(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,subscription_id uuid,notification_key text,status text,unique(hotel_id,recipient_user_id,subscription_id,notification_key));
 insert into hotels values('${id(1)}');`);
 await db.exec(sql('20260930200000_cmpri_work_order_history.sql'));
 await db.exec(sql('20260930220000_cmpri_work_order_history_notifications.sql'));
 await db.exec(sql('20261013143835_cmpri_prospective_event_push.sql'));
 await db.exec(sql('20261014200934_work_order_report_corrections.sql'));
 const roles=['Front Desk Manager','Chief Engineer','Engineer','Technician','system_admin','Front Desk Manager'];
 for(let i=0;i<roles.length;i++) {
  const user=id(i+10);
  await db.query('insert into auth.users values($1)',[user]);
  await db.query('insert into profiles values($1,$2,$3,$4,$5,true)',[user,roles[i],roles[i],[],`${i}@test.invalid`]);
  await db.query('insert into hotel_members values($1,$2,true)',[user,id(1)]);
  await db.query('insert into cmpri_web_push_subscriptions values($1,$2,$3,true)',[id(i+30),id(1),user]);
 }
 await db.query(`insert into work_orders(id,hotel_id,created_by,display_id,status,room,location_id,issue,asset_id,notes) values($1,$2,$3,'WO-123','Open','Room 409',$4,'Fan noisy',$5,'Keep all notes')`,[id(2),id(1),id(14),id(3),id(4)]);
 await db.query(`insert into cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,work_order_id,message,read_at,cleared_at) values($1,$2,$3,$4,'old alert',now(),now())`,[id(1),id(11),`new-order:${id(2)}`,id(2)]);
 await db.query(`update work_orders set room='Room 410',location_id=$1,issue='Fan rattles',history_actor_user_id=$2,history_source='CMPRI app' where id=$3`,[id(5),id(10),id(2)]);
 let history=(await db.query("select * from cmpri_work_order_history where event_type='report_corrected'")).rows;
 assert.equal(history.length,1); assert.equal(history[0].actor_user_id,id(10));assert.ok(history[0].recorded_at);
 assert.deepEqual(history[0].changed_fields.room,{old:'Room 409',new:'Room 410'});assert.deepEqual(history[0].changed_fields.issue,{old:'Fan noisy',new:'Fan rattles'});
 let alerts=(await db.query("select * from cmpri_dashboard_notifications where notification_key like 'report-correction:%'")).rows;
 assert.equal(alerts.length,1);assert.equal(alerts[0].recipient_user_id,id(11));assert.equal(alerts[0].read_at,null);assert.equal(alerts[0].cleared_at,null);assert.match(alerts[0].message,/WO-123.*Room 409.*Room 410.*Reported Issue/);
 assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,1);
 const row=(await db.query('select * from work_orders')).rows[0];assert.equal(row.asset_id,id(4));assert.equal(row.notes,'Keep all notes');assert.equal(row.status,'Open');
 // Repeated same values produce neither extra history nor another alert.
 await db.query("update work_orders set room='Room 410',issue='Fan rattles',history_actor_user_id=$1",[id(10)]);
 assert.equal((await db.query("select * from cmpri_work_order_history where event_type='report_corrected'")).rows.length,1);
 await db.exec("update cmpri_dashboard_notifications set read_at=now(),cleared_at=now()");
 await db.query("update work_orders set issue='Fan stops',history_actor_user_id=$1",[id(10)]);
 alerts=(await db.query("select * from cmpri_dashboard_notifications where notification_key like 'report-correction:%' order by recorded_at")).rows;
 assert.equal(alerts.length,2);assert.notEqual(alerts[0].notification_key,alerts[1].notification_key);assert.equal(alerts[1].read_at,null);
 assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,2);
 // Chief correction is audited; self notification is excluded.
 await db.query("update work_orders set room='Lobby',history_actor_user_id=$1",[id(11)]);
 assert.equal((await db.query("select * from cmpri_work_order_history where event_type='report_corrected'")).rows.length,3);
 assert.equal((await db.query("select * from cmpri_dashboard_notifications where notification_key like 'report-correction:%'")).rows.length,2);
 // Secondary Chief titles receive future events; inactive/wrong-hotel recipients do not.
 await db.query("update profiles set secondary_roles=ARRAY['Chief Engineer'] where id=$1",[id(12)]);
 await db.query("update profiles set active=false where id=$1",[id(11)]);
 await db.query("update work_orders set issue='Fan repaired then rattled again',history_actor_user_id=$1",[id(10)]);
 const latest=(await db.query("select recipient_user_id from cmpri_dashboard_notifications where notification_key like 'report-correction:%' order by recorded_at desc limit 1")).rows[0];
 assert.equal(latest.recipient_user_id,id(12));
 await db.query("update hotel_members set active=false where user_id=$1",[id(12)]);
 const beforeCount=(await db.query('select count(*)::int as n from cmpri_dashboard_notifications')).rows[0].n;
 await db.query("update work_orders set issue='Another real correction',history_actor_user_id=$1",[id(10)]);
 assert.equal((await db.query('select count(*)::int as n from cmpri_dashboard_notifications')).rows[0].n,beforeCount);
 // Ineligible actor's existing technical edit remains audited without a correction alert.
 await db.query('update hotel_members set active=true where user_id=$1',[id(12)]);
 const alertCount=(await db.query('select count(*)::int as n from cmpri_dashboard_notifications')).rows[0].n;
 await db.query("update work_orders set issue='Admin technical edit',history_actor_user_id=$1",[id(14)]);
 assert.equal((await db.query('select count(*)::int as n from cmpri_dashboard_notifications')).rows[0].n,alertCount);
 // A Chief correction alerts a different active Chief, including on a closed ticket.
 await db.query("update work_orders set status='Closed'");
 await db.query("update profiles set active=true where id=$1",[id(11)]);
 await db.query("update work_orders set issue='Chief closed correction',history_actor_user_id=$1",[id(11)]);
 const chiefAlert=(await db.query("select recipient_user_id from cmpri_dashboard_notifications where notification_key like 'report-correction:%' order by recorded_at desc limit 1")).rows[0];
 assert.equal(chiefAlert.recipient_user_id,id(12));
 await db.exec('set role authenticated');
 await assert.rejects(db.exec('select cmpri_log_report_correction()'),/permission denied/);
 await assert.rejects(db.exec("update cmpri_work_order_history set actor_name='spoof'"),/permission denied/);
 await db.exec('reset role');
 } finally {await db.close();}
});
