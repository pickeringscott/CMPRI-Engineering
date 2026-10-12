import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../supabase/migrations/20261012205937_cmpri_ticket_read_access.sql',import.meta.url),'utf8');
const hotel='00000000-0000-4000-8000-000000000001', otherHotel='00000000-0000-4000-8000-000000000002';
const user='00000000-0000-4000-8000-000000000003', other='00000000-0000-4000-8000-000000000004';
const statuses=['Open','In Progress','Closed','Completed','Will Not Do','Pending Verification','Draft','Unknown'];
const roles=['front_desk','housekeeping','front_desk_manager','assistant_manager','manager','senior_management','technician','engineer','chief_engineer','system_admin'];
const db=new PGlite();
test('actual PostgreSQL RLS adds only active and creator-owned Closed reads, with hotel/activation isolation and unchanged grants',async()=>{
 try {
 await db.exec(`create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;
 grant execute on function auth.uid() to authenticated,anon;
 create table profiles(id uuid primary key,role text,secondary_roles text[],active boolean);
 create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
 create table work_orders(id text primary key,hotel_id uuid,created_by uuid,status text,notes text);
 alter table work_orders enable row level security;
 grant select on work_orders to authenticated;
 insert into profiles values('${user}','front_desk','{}',true);
 insert into hotel_members values('${user}','${hotel}',true);`);
 const least=readFileSync(new URL('../supabase/migrations/20261002214500_cmpri_rls_least_privilege.sql',import.meta.url),'utf8');
 await db.exec(least.slice(0,least.indexOf('CREATE OR REPLACE FUNCTION public.can_manage_hotel')));
 const manager=readFileSync(new URL('../supabase/migrations/20261006100000_cmpri_manager_role_database_permissions.sql',import.meta.url),'utf8');
 for(const name of ['cmpri_can_view_work_orders','cmpri_can_view_open_work_orders_only']) {
  const start=manager.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`),end=manager.indexOf('$$;',start)+3;
  await db.exec(manager.slice(start,end));
 }
 await db.exec(readFileSync(new URL('../supabase/migrations/20261006120000_cmpri_work_order_read_capability.sql',import.meta.url),'utf8'));
 for(const h of [hotel,otherHotel]) for(const creator of [user,other]) for(const status of statuses) await db.query('insert into work_orders values($1,$2,$3,$4,$5)',[`${h}/${creator}/${status}`,h,creator,status,'Engineering notes remain readable']);
 async function visible(role,active=true,membership=true,identity=user) {
  await db.query('update profiles set role=$1,active=$2',[role,active]);
  await db.query('update hotel_members set active=$1',[membership]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[identity]);
  await db.exec('set role authenticated');
  try {return (await db.query('select * from work_orders order by id')).rows;} finally {await db.exec('reset role');}
 }
 const before=new Map();for(const role of roles) before.set(role,await visible(role));
 await db.exec(migration);await db.exec(migration); // Idempotence.
 for(const role of roles) {
  const rows=await visible(role);const prior=before.get(role);
  const expected=new Set(prior.map(row=>row.id));
  for(const creator of [user,other]) for(const status of ['Open','In Progress']) expected.add(`${hotel}/${creator}/${status}`);
  expected.add(`${hotel}/${user}/Closed`);
  assert.deepEqual(rows.map(row=>row.id).sort(),[...expected].sort(),role);
  assert.ok(rows.every(row=>row.hotel_id===hotel && row.notes==='Engineering notes remain readable'),role);
  assert.equal((await visible(role,false)).length,0,`${role}/inactive profile`);
  assert.equal((await visible(role,true,false)).length,0,`${role}/inactive membership`);
  assert.equal((await visible(role,true,true,other)).length,0,`${role}/no membership`);
 }
 await visible('front_desk');
 await db.exec('set role authenticated');
 await assert.rejects(db.exec("update work_orders set status='Closed'"),/permission denied/);
 await assert.rejects(db.exec('delete from work_orders'),/permission denied/);
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claim.sub','',false)");
 await db.exec('set role authenticated');
 assert.equal((await db.query('select * from work_orders')).rows.length,0);
 await db.exec('reset role; set role anon');
 await assert.rejects(db.exec('select * from work_orders'),/permission denied/);
 } finally {await db.close();}
});
