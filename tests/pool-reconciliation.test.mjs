import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const source=JSON.parse(readFileSync(new URL('./fixtures/pool-reconciliation-20261012.json',import.meta.url),'utf8'));
const sql=readFileSync(new URL('../scripts/reconcile-pool-20261012.sql',import.meta.url),'utf8');
const migration=readFileSync(new URL('../supabase/migrations/20261012212441_cmpri_pool_retest_status.sql',import.meta.url),'utf8');
async function fixture(tamper) {
 const db=new PGlite();
 // Match the UTC audit snapshot regardless of the host timezone. JSONB timestamp
 // equality is intentionally strict in the unchanged reconciliation guard.
 await db.exec("SET TIME ZONE 'UTC'");
 const types=Object.entries(source).map(([key,value])=>{
  const type=key==='revision'?'integer':key.endsWith('_id')||['id','created_by','updated_by'].includes(key)?'uuid':key.endsWith('_at')?'timestamptz':key==='log_date'?'date':typeof value==='boolean'?'boolean':typeof value==='number'||(/^(ph_|sanitizer_)/.test(key)&&!key.startsWith('sanitizer_band'))||['cyanuric_acid_ppm','combined_chlorine_ppm'].includes(key)?'numeric':'text';
  return `"${key}" ${type}`;
 });
 await db.exec(`create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create table profiles(id uuid,role text,active boolean);create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
 create table pool_daily_logs(${types.join(',')});
 create table cmpri_pool_log_history(id uuid primary key default gen_random_uuid(),pool_log_id uuid,hotel_id uuid,actor_id uuid,recorded_at timestamptz default now(),snapshot jsonb);
 `);
 await db.query('insert into profiles values($1,$2,true)',[source.updated_by,'system_admin']);
 await db.query('insert into hotel_members values($1,$2,true)',[source.updated_by,source.hotel_id]);
 await db.query('insert into pool_daily_logs select * from jsonb_populate_record(null::pool_daily_logs,$1::jsonb)',[JSON.stringify(source)]);
 await db.query('insert into pool_daily_logs select * from jsonb_populate_record(null::pool_daily_logs,$1::jsonb)',[JSON.stringify({...source,id:'00000000-0000-4000-8000-000000000001',closure_reason:'Unclassified hold'})]);
 const am={...source,revision:1,updated_at:source.created_at,ph_pm:null,sanitizer_band_pm:null,ph_deep_pm:null,ph_shallow_pm:null,sample_location_pm:null};
 for(const [id,snapshot] of [['f22c0708-f51e-40f1-b74b-9cc1af8f2f66',am],['a9ee3285-6a8f-4212-91cd-548f535d8b5f',source]])await db.query('insert into cmpri_pool_log_history(id,pool_log_id,hotel_id,actor_id,recorded_at,snapshot) values($1,$2,$3,$4,$5,$6)',[id,source.id,source.hotel_id,source.updated_by,snapshot.updated_at,JSON.stringify(snapshot)]);
 await db.exec(migration);
 const archived=readFileSync(new URL('../supabase/migrations_archive/20260915163638_cmpri_v1_0_pool_log_columns.sql',import.meta.url),'utf8');
 await db.exec(archived.slice(archived.indexOf('CREATE OR REPLACE FUNCTION public.cmpri_audit_pool_log()')));
 await db.exec('create trigger cmpri_pool_log_stamp before insert or update on pool_daily_logs for each row execute function cmpri_stamp_pool_log()');
 if(tamper)await db.exec(tamper);
 return db;
}
test('bounded reconciliation keeps measurements and old audit, opens one row, records provenance, leaves no override',async()=>{
 const db=await fixture();try{
  const before=(await db.query('select to_jsonb(p) as row from pool_daily_logs p order by id')).rows;
  const audit=(await db.query('select * from cmpri_pool_log_history order by id')).rows;
  const stamp=(await db.query("select pg_get_functiondef('cmpri_stamp_pool_log()'::regprocedure) as definition")).rows;
  await db.exec(sql);
  const after=(await db.query('select to_jsonb(p) as row from pool_daily_logs p order by id')).rows;
  assert.deepEqual(after[0],before[0]);const row=after[1].row;
  assert.equal(row.revision,3);assert.equal(row.closure_condition,false);assert.equal(row.manual_closure,false);assert.equal(row.ph_am,7.6);assert.equal(row.sanitizer_am,0);assert.equal(row.retest_submission,null);
  assert.equal(row.latest_test.recorded_at,'2026-10-12T20:00:54.910027Z');assert.equal(row.latest_test.source_history_id,'a9ee3285-6a8f-4212-91cd-548f535d8b5f');assert.match(row.latest_test.policy_reconciliation.reason,/no new measurement/);
  for(const old of audit)assert.deepEqual((await db.query('select * from cmpri_pool_log_history where id=$1',[old.id])).rows[0],old);
  assert.equal((await db.query('select count(*)::int as n from cmpri_pool_log_history')).rows[0].n,3);
  assert.deepEqual((await db.query("select pg_get_functiondef('cmpri_stamp_pool_log()'::regprocedure) as definition")).rows,stamp);
  assert.equal((await db.query("select to_regprocedure('public.cmpri_reconcile_20261012_pm_once()') as f")).rows[0].f,null);
  await assert.rejects(()=>db.exec(sql),/preconditions changed/);await db.exec('rollback');
  assert.equal((await db.query('select revision from pool_daily_logs where id=$1',[source.id])).rows[0].revision,3);
 }finally{await db.close()}
});
for(const [name,tamper] of [
 ['changed source audit',"update cmpri_pool_log_history set snapshot=jsonb_set(snapshot,'{ph_pm}','7.6') where snapshot->>'revision'='2'"],
 ['inactive approver',"update profiles set active=false"],
 ['extra history',"insert into cmpri_pool_log_history(pool_log_id,snapshot) select pool_log_id,snapshot from cmpri_pool_log_history limit 1"],
 ['changed live revision',"update pool_daily_logs set remarks='New live evidence' where id='eb3437c4-6edc-493c-93c8-76714dec6355'"],
])test(`reconciliation aborts for ${name} without mutations`,async()=>{
 const db=await fixture(tamper);try{const before=(await db.query('select to_jsonb(p) as row from pool_daily_logs p order by id')).rows;const audit=(await db.query('select * from cmpri_pool_log_history order by id')).rows;await assert.rejects(()=>db.exec(sql),/preconditions changed/);await db.exec('rollback');assert.deepEqual((await db.query('select to_jsonb(p) as row from pool_daily_logs p order by id')).rows,before);assert.deepEqual((await db.query('select * from cmpri_pool_log_history order by id')).rows,audit)}finally{await db.close()}
});
