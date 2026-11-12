import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const hotel='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',asset='00000000-0000-4000-8000-000000000003',order='00000000-0000-4000-8000-000000000004',from='00000000-0000-4000-8000-000000000005',to='00000000-0000-4000-8000-000000000006';
async function fixture(){const db=new PGlite();await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth; create function auth.role() returns text language sql as $$select current_setting('test.role',true)$$;
create table public.profiles(id uuid primary key,active boolean,role text);
create table public.hotel_members(user_id uuid,hotel_id uuid,active boolean);
create table public.locations(id uuid,hotel_id uuid,name text,active boolean);
create table public.assets(id uuid,hotel_id uuid,location_id uuid,updated_at timestamptz,documentation_verified_at timestamptz,documentation_verified_by uuid,documentation_revision_id uuid,name text);
create table public.cmpri_equipment_document_revisions(id uuid,asset_id uuid,hotel_id uuid,closed_at timestamptz,prior_asset jsonb);
create table public.work_orders(id uuid,hotel_id uuid,asset_id uuid,location_id uuid,room text,notes text,revision bigint,history_actor_user_id uuid,history_source text);
insert into profiles values('${actor}',true,'engineer');insert into hotel_members values('${actor}','${hotel}',true);
insert into locations values('${from}','${hotel}','Room 212',true),('${to}','${hotel}','Engineering',true);
insert into assets values('${asset}','${hotel}','${from}','2026-01-01T00:00:00Z',now(),'${actor}',null,'Unit');
insert into work_orders values('${order}','${hotel}','${asset}','${from}','Room 212','Existing note',3,null,null);
select set_config('test.role','service_role',false);
`);await db.exec(readFileSync(new URL('../supabase/migrations/20261112050431_asset_move_work_order.sql',import.meta.url),'utf8'));await db.exec('create trigger protect before update on public.assets for each row execute function public.cmpri_protect_verified_asset();');return db;}
const args=[hotel,asset,to,'2026-01-01T00:00:00Z',order,3,actor,'Move note'];
const query='select public.cmpri_move_asset_with_order($1,$2,$3,$4,$5,$6,$7,$8)';
test('moves verified equipment and linked ticket atomically, preserving notes and verified fields',async()=>{const db=await fixture();try{await db.query(query,args);const a=(await db.query('select * from assets')).rows[0],w=(await db.query('select * from work_orders')).rows[0];assert.equal(a.location_id,to);assert.ok(a.documentation_verified_at);assert.equal(a.name,'Unit');assert.equal(w.location_id,to);assert.equal(w.room,'Engineering');assert.equal(w.notes,'Existing note\nMove note');await assert.rejects(db.exec("update assets set name='Changed'"),/locked/);}finally{await db.close();}});
test('stale ticket rejects move without changing either record',async()=>{const db=await fixture();try{await assert.rejects(db.query(query,[...args.slice(0,5),2,...args.slice(6)]),/changed/);assert.equal((await db.query('select location_id from assets')).rows[0].location_id,from);assert.equal((await db.query('select location_id from work_orders')).rows[0].location_id,from);}finally{await db.close();}});
test('unauthorized database role and unrelated order cannot move equipment',async()=>{const db=await fixture();try{await db.exec("select set_config('test.role','authenticated',false)");await assert.rejects(db.query(query,args),/Service role/);await db.exec("select set_config('test.role','service_role',false); update work_orders set asset_id=null");await assert.rejects(db.query(query,args),/not linked/);assert.equal((await db.query('select location_id from assets')).rows[0].location_id,from);}finally{await db.close();}});
test('stale asset and invalid destination leave the work order untouched',async()=>{const db=await fixture();try{await assert.rejects(db.query(query,[hotel,asset,to,'2025-01-01',order,3,actor,'Move note']),/Asset changed/);await db.exec(`update locations set active=false where id='${to}'`);await assert.rejects(db.query(query,args),/active destination/);assert.equal((await db.query('select notes from work_orders')).rows[0].notes,'Existing note');}finally{await db.close();}});
test('allows a storage move without a work order',async()=>{const db=await fixture();try{await db.query(query,[hotel,asset,to,'2026-01-01T00:00:00Z',null,null,actor,null]);assert.equal((await db.query('select location_id from assets')).rows[0].location_id,to);assert.equal((await db.query('select location_id from work_orders')).rows[0].location_id,from);}finally{await db.close();}});
test('moves through the consolidated assets view while retaining verified protection',async()=>{const db=await fixture();try{await db.exec('alter table public.assets rename to cmpri_assets_and_pdfs; create view public.assets as select * from public.cmpri_assets_and_pdfs');await db.query(query,args);const a=(await db.query('select * from public.assets')).rows[0];assert.equal(a.location_id,to);assert.ok(a.documentation_verified_at);await assert.rejects(db.exec("update public.assets set name='Changed'"),/locked/);}finally{await db.close();}});
