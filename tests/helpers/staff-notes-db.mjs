import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
export const staffId=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const staffHotel=staffId(1),foreignHotel=staffId(99);
export const staffProfiles=[
 {id:staffId(2),role:'engineer',full_name:'Scott Reed'},
 {id:staffId(3),role:'manager',full_name:'Morgan Leader'},
 {id:staffId(4),role:'housekeeping',full_name:'Alex Rivera'},
 {id:staffId(5),role:'housekeeping',full_name:'Alex Chen'},
 {id:staffId(6),role:'front_desk',full_name:'Front Desk'},
 {id:staffId(7),role:'assistant_manager',full_name:'Amy Assistant'},
 {id:staffId(8),role:'front_desk_manager',full_name:'Robin Lead'},
 {id:staffId(9),role:'technician',full_name:'Taylor Technician'},
 {id:staffId(10),role:'system_admin',full_name:'Sam Admin'},
 {id:staffId(11),role:'senior_management',full_name:'Pat Director'},
 {id:staffId(12),role:'housekeeping',full_name:'Deon Housekeeper'},
 {id:staffId(13),role:'housekeeping',full_name:'Inactive Person',active:false},
 {id:staffId(98),role:'housekeeping',full_name:'Foreign Person',hotel_id:foreignHotel},
].map(p=>({active:true,secondary_roles:[],email:`fixture-${p.id}@example.invalid`,...p}));
export async function staffNotesDatabase(beforeTargets){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table hotels(id uuid primary key);
 create table profiles(id uuid primary key,active boolean,role text,secondary_roles text[],full_name text,email text);
 create table hotel_members(user_id uuid,hotel_id uuid,active boolean,primary key(hotel_id,user_id));
 create function public.is_hotel_member(h uuid) returns boolean language sql security definer set search_path='' as $$select exists(select 1 from public.hotel_members m join public.profiles p on p.id=m.user_id where m.hotel_id=h and m.user_id=auth.uid() and m.active and p.active)$$;
 create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,target_path text,message text,recorded_at timestamptz,read_at timestamptz,cleared_at timestamptz,unique(hotel_id,recipient_user_id,notification_key));
 create table cmpri_web_push_subscriptions(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,enabled boolean,subscription jsonb);
 create table cmpri_web_push_deliveries(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,subscription_id uuid,notification_key text,status text,claimed_at timestamptz,unique(hotel_id,recipient_user_id,subscription_id,notification_key));
 create table cmpri_user_notification_schedules(hotel_id uuid,user_id uuid,timezone text,schedule jsonb);
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table locations(id uuid primary key,hotel_id uuid,room_number text,name text,area text,active boolean);
 create table work_orders(id uuid primary key,display_id text,hotel_id uuid,room text,issue text,status text);
 create table untouched(value jsonb);insert into untouched values('{"hours":19,"profile":"unchanged","feedback":"private"}');
 insert into hotels values('${staffHotel}'),('${foreignHotel}');`);
 for(const p of staffProfiles){await db.query('insert into profiles values($1,$2,$3,$4,$5,$6)',[p.id,p.active,p.role,p.secondary_roles,p.full_name,p.email]);await db.query('insert into hotel_members values($1,$2,true)',[p.id,p.hotel_id||staffHotel]);}
 await db.exec(readFileSync('supabase/migrations/20261015055427_cmpri_staff_notes.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261105004859_staff_notes_media_and_room_guest_import.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261013145012_cmpri_prospective_event_push.sql','utf8'));
 if(beforeTargets)await beforeTargets(db);
 await db.exec(readFileSync('supabase/migrations/20261106225339_staff_notes_target_identity_and_flags.sql','utf8'));
 await db.query('insert into locations values($1,$2,$3,$4,$5,true),($6,$7,$8,$9,$10,true)',[staffId(21),staffHotel,'204','Room 204','Guest Rooms',staffId(22),foreignHotel,'999','Foreign Room','Other']);
 await db.query('insert into work_orders values($1,$2,$3,$4,$5,$6),($7,$8,$9,$10,$11,$12)',[staffId(31),'4218',staffHotel,'204','Fixture drain repair','Open',staffId(32),'9911',foreignHotel,'999','SECRET FOREIGN TICKET','Open']);
 const schedule=Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day=>[day,{enabled:true,start:'00:00',end:'00:00'}]));
 for(const p of staffProfiles){
  await db.query('insert into cmpri_user_notification_schedules values($1,$2,$3,$4)',[p.hotel_id||staffHotel,p.id,'America/Chicago',JSON.stringify(schedule)]);
  await db.query('insert into cmpri_web_push_subscriptions(hotel_id,recipient_user_id,enabled,subscription) values($1,$2,true,$3)',[p.hotel_id||staffHotel,p.id,JSON.stringify({endpoint:'https://fixture.push.invalid/'+p.id,keys:{auth:'synthetic',p256dh:'synthetic'}})]);
 }
 return db;
}
