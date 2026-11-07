import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('new cache signals cover catalog, notes, pool, PM, GSS and authorization without exposing business rows',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;
   create table profiles(id uuid primary key,role text,secondary_roles text[] default '{}',full_name text,active boolean);
   create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
   create table role_permissions(role text,permission text,allowed boolean);
   create table work_orders(id uuid primary key,hotel_id uuid,display_id text,room text,issue text,status text,created_at timestamptz default now());
   create table cmpri_dashboard_notifications(id uuid default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,message text,recorded_at timestamptz,push_requested boolean,unique(hotel_id,recipient_user_id,notification_key));
   create table cmpri_work_order_history(id uuid,hotel_id uuid,work_order_id uuid,actor_user_id uuid,actor_name text,event_type text,old_status text,new_status text,changed_fields jsonb,snapshot jsonb,recorded_at timestamptz default now());
   create table cmpri_work_order_technician_views(id uuid,hotel_id uuid,work_order_id uuid,work_order_display_id text,viewed_at timestamptz default now());`);
  for(const table of ['cmpri_pool_control','room_operations','cmpri_room_operation_imports','user_feedback','cmpri_work_order_drafts','cmpri_inventory_items','cmpri_vendors','pool_daily_logs','pm_plans','cmpri_staff_notes','cmpri_gss_reports','cmpri_assets_and_pdfs','troubleshooting_cache','locations','cmpri_purchases','cmpri_enseo_tickets','cmpri_warranty_cases','cmpri_supplier_followups'])await db.exec(`create table ${table}(id uuid,hotel_id uuid);`);
  await db.exec('create schema storage;create table storage.objects(id uuid,bucket_id text,name text);create table cmpri_purchase_shipments(id uuid,purchase_id uuid,status text);create table cmpri_web_push_tests(id uuid,hotel_id uuid,recipient_user_id uuid,status text);');
  await db.exec(readFileSync('supabase/migrations/20261106133302_event_driven_resources.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261106133511_modal_resource_events.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261107194347_device_data_cache_signals.sql','utf8'));
  await db.exec(`insert into profiles values('${id(2)}','housekeeping','{}','A',true),('${id(3)}','housekeeping','{}','B',true),('${id(4)}','housekeeping','{}','Other property',true);
   insert into hotel_members values('${id(1)}','${id(2)}',true),('${id(1)}','${id(3)}',true),('${id(9)}','${id(4)}',true);delete from cmpri_resource_signals;`);
  for(const [table,topic] of [['cmpri_inventory_items','reference'],['cmpri_vendors','reference'],['pool_daily_logs','pool'],['pm_plans','reference'],['cmpri_staff_notes','inbox'],['cmpri_gss_reports','reference']]){
   await db.exec('delete from cmpri_resource_signals');await db.query(`insert into ${table} values($1,$2)`,[id(6),id(1)]);
   const rows=(await db.query('select * from cmpri_resource_signals')).rows;
   assert.equal(rows.length,2,table);assert.ok(rows.every(r=>r.hotel_id===id(1)&&r.topic===topic));
  }
  await db.exec('delete from cmpri_resource_signals');await db.query('update profiles set role=$1 where id=$2',['technician',id(2)]);
  const session=(await db.query("select * from cmpri_resource_signals where topic='session'")).rows;
  assert.equal(session.length,1);assert.equal(session[0].recipient_user_id,id(2));
  await db.exec('delete from cmpri_resource_signals');await db.query('insert into role_permissions values($1,$2,true)',['technician','view_dashboard']);
  assert.equal((await db.query("select * from cmpri_resource_signals where topic='session'")).rows.length,3);
  await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${id(2)}',false);`);
  const scoped=(await db.query('select * from cmpri_resource_signals')).rows;assert.ok(scoped.every(r=>r.recipient_user_id===id(2)&&r.hotel_id===id(1)));
  await assert.rejects(db.exec('select cmpri_private.signal_cached_permissions()'),/permission denied/);
  await assert.rejects(db.exec('update cmpri_resource_signals set revision=999'),/permission denied/);
 }finally{await db.close()}
});
