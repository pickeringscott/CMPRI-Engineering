import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const h=id(1),f=id(2),eng=id(3),fd=id(4),log=id(5);
const source=JSON.parse(readFileSync('tests/fixtures/pool-reconciliation-20261012.json','utf8'));
const columns=Object.entries(source).map(([key,value])=>{
 const type=key==='revision'?'bigint':key.endsWith('_id')||['id','created_by','updated_by'].includes(key)?'uuid':key.endsWith('_at')?'timestamptz':key==='log_date'?'date':typeof value==='boolean'?'boolean':typeof value==='number'||(/^(ph_|sanitizer_)/.test(key)&&!key.startsWith('sanitizer_band'))||['cyanuric_acid_ppm','combined_chlorine_ppm'].includes(key)?'numeric':'text';return `"${key}" ${type}`;
});
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
create table profiles(id uuid primary key,role text,secondary_roles text[],active boolean);create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
create table pool_facilities(id uuid primary key,hotel_id uuid,active boolean);
create table pool_daily_logs(${columns.join(',')});
create table cmpri_pool_log_history(id uuid default gen_random_uuid(),pool_log_id uuid,snapshot jsonb);
create table cmpri_dashboard_notifications(hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,target_path text,message text,recorded_at timestamptz,push_requested boolean,unique(hotel_id,recipient_user_id,notification_key));
insert into profiles values('${eng}','chief_engineer','{}',true),('${fd}','front_desk','{}',true);
insert into hotel_members values('${eng}','${h}',true),('${fd}','${h}',true);insert into pool_facilities values('${f}','${h}',true);`);
await db.exec(readFileSync('supabase/migrations/20261012212441_cmpri_pool_retest_status.sql','utf8'));
await db.exec('create trigger cmpri_pool_log_stamp before insert or update on pool_daily_logs for each row execute function cmpri_stamp_pool_log()');
await db.exec(readFileSync('supabase/migrations/20261022070428_cmpri_pool_status_controls.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/20261106133521_pool_manager_reopening.sql','utf8'));
const clock=async s=>db.exec(`create or replace function cmpri_pool_clock() returns timestamptz language sql stable as $$select '${s}'::timestamptz$$`);
await clock('2026-10-22T15:00:00Z');
await db.query(`insert into pool_daily_logs(id,hotel_id,pool_facility_id,log_date,ph_am,sanitizer_am,main_drain_visible,filter_backwashed,temperature_f,flow_rate_gpm,updated_by,created_by,closure_condition,manual_closure) values($1,$2,$3,'2026-10-22',7.4,4,true,false,80,50,$4,$4,false,false)`,[log,h,f,eng]);
const snapshot=async()=> (await db.query(`select cmpri_pool_snapshot('${h}','${f}') s`)).rows[0].s;
const act=async(actor,key,action,reason='',revision)=>{await db.query(`select cmpri_pool_reconcile('${h}','${f}',false)`);return db.query(`select cmpri_pool_action($1,$2,$3,$4,$5,$6,$7) s`,[h,f,actor,id(key),action,reason,revision??(await snapshot()).revision]);};
assert.equal((await snapshot()).closed,false);
await assert.rejects(act(fd,10,'close',' '),/reason/);
await act(fd,11,'close','Maintenance');assert.equal((await snapshot()).reason,'Maintenance');
const count=async()=>Number((await db.query('select count(*) n from cmpri_dashboard_notifications')).rows[0].n);
const notifications=await count();assert.equal(notifications,2);
await db.query(`select cmpri_pool_reconcile('${h}','${f}',false)`);assert.equal(await count(),notifications);
await assert.rejects(act(fd,12,'open'),/Engineering/);await assert.rejects(act(fd,13,'clear-manual'),/Engineering/);
await clock('2026-10-23T03:00:00Z');
await assert.rejects(act(eng,14,'open'),/10 PM/);await assert.rejects(act(fd,15,'close','Night'),/10 PM/);
await act(eng,16,'clear-manual');assert.equal((await snapshot()).closed,true);assert.equal((await snapshot()).reason,'Closed 10 PM-7 AM');
await clock('2026-10-23T12:00:00Z');assert.equal((await snapshot()).closed,true);await act(eng,17,'open');assert.equal((await snapshot()).closed,false);
// GM/AGM can clear Front Desk holds, reopen, create logs and correct saved readings.
for (const [index,role] of ['manager','assistant_manager','front_desk_manager','housekeeping','technician','senior_management'].entries()) {
 const actor=id(100+index);
 await db.query('insert into profiles values($1,$2,$3,true)',[actor,role,[]]);
 await db.query('insert into hotel_members values($1,$2,true)',[actor,h]);
 await act(fd,200+index*10,'close','Front Desk closure');
 if(index<2){
  await act(actor,201+index*10,'clear-manual');
  assert.equal((await snapshot()).closed,true,'clearing the hold alone must not reopen');
  await act(actor,202+index*10,'open');assert.equal((await snapshot()).closed,false);
  await db.query('update pool_daily_logs set temperature_f=$1,updated_by=$2 where id=$3',[81+index,actor,log]);
  const created=id(400+index);
  await db.query(`insert into pool_daily_logs(id,hotel_id,pool_facility_id,log_date,ph_am,sanitizer_am,main_drain_visible,filter_backwashed,temperature_f,flow_rate_gpm,updated_by,created_by,closure_condition,manual_closure) values($1,$2,$3,'2026-10-21',7.4,4,true,false,80,50,$4,$4,false,false)`,[created,h,f,actor]);
  await assert.rejects(db.query('update pool_daily_logs set ph_am=null,updated_by=$1 where id=$2',[actor,log]),/both pH/);
  assert.ok((await db.query('select actor_id from cmpri_pool_control_history where actor_id=$1',[actor])).rows.length>=2);
 }else{
  await assert.rejects(act(actor,201+index*10,'clear-manual'),/Engineering/);
  await assert.rejects(act(actor,202+index*10,'open'),/Engineering/);
  await assert.rejects(db.query('update pool_daily_logs set temperature_f=99,updated_by=$1 where id=$2',[actor,log]));
  await act(eng,203+index*10,'open');
 }
}

// Full pool-log correction parity includes classifying an unknown historical hold.
// Seed legacy data without invoking today's stamping logic, then restore the real trigger.
for(const [index,actor] of [id(100),id(101)].entries()){
 const legacy=id(600+index);
 await db.exec('alter table pool_daily_logs disable trigger cmpri_pool_log_stamp');
 await db.query(`insert into pool_daily_logs(id,hotel_id,pool_facility_id,log_date,ph_am,sanitizer_am,main_drain_visible,filter_backwashed,temperature_f,flow_rate_gpm,updated_by,created_by,closure_condition,manual_closure,closure_reason) values($1,$2,$3,'2026-10-20',7.4,4,true,false,80,50,$4,$4,true,null,'Historical closure awaiting classification')`,[legacy,h,f,eng]);
 await db.exec('alter table pool_daily_logs enable trigger cmpri_pool_log_stamp');
 await assert.rejects(db.query('update pool_daily_logs set manual_closure=false,updated_by=$1 where id=$2',[id(102),legacy]),/classify/);
 await db.query('update pool_daily_logs set manual_closure=false,updated_by=$1 where id=$2',[actor,legacy]);
 const row=(await db.query('select manual_closure,closure_condition from pool_daily_logs where id=$1',[legacy])).rows[0];
 assert.equal(row.manual_closure,false);assert.equal(row.closure_condition,true,'classification alone cannot reopen without a new test');
}

// Existing real testing trigger, not a separate simulated status write.
await db.query(`update pool_daily_logs set retest_submission=$1,closure_reason='Bromine below safe range',updated_by=$2 where id=$3`,[{id:id(20),ph:7.4,sanitizer_band:'0'},eng,log]);
assert.equal((await snapshot()).closed,true);await assert.rejects(act(eng,21,'open'),/testing/);
for(const actor of [id(100),id(101)])await assert.rejects(act(actor,500+Number(actor.slice(-1)),'open'),/testing/);
assert.ok((await db.query(`select message from cmpri_dashboard_notifications where recipient_user_id='${fd}'`)).rows.some(r=>/bromine/i.test(r.message)));
const before=await count();await db.query(`select cmpri_pool_reconcile('${h}','${f}',true)`);assert.equal(await count(),before);
await db.exec('set role authenticated');await assert.rejects(db.query(`select cmpri_pool_action('${h}','${f}','${eng}','${id(30)}','open','',0)`),/permission denied/);await db.exec('reset role');
console.log('PASS real PostgreSQL: persisted manual close, reason validation, Engineering/GM/AGM-only open/clear, GM/AGM log create/edit with validation and actor history, overnight denials, clear without reopen, testing-triggered closure/recipient record, repeated-reconcile dedup, direct-role denial');
// Pool chemicals share the real pool stamping, role, revision and audit path.
const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
for(const name of ['cmpri_inventory_items','cmpri_inventory_movements']){
 const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
 await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3));
 await db.exec(`alter table ${name} add primary key(id)`);
}
const unitSql=readFileSync('supabase/migrations/20261022070436_cmpri_po_package_units.sql','utf8');
const unitStart=unitSql.indexOf('create function public.cmpri_unit_grams');
await db.exec(unitSql.slice(unitStart,unitSql.indexOf('$$;',unitStart)+3));
await db.exec(readFileSync('supabase/migrations/20261109113001_pool_log_chemical_usage.sql','utf8'));
await db.exec('alter table cmpri_pool_log_history add column hotel_id uuid, add column actor_id uuid');
const auditStart=baseline.indexOf('CREATE OR REPLACE FUNCTION "public"."cmpri_audit_pool_log"');
await db.exec(baseline.slice(auditStart,baseline.indexOf('$$;',auditStart)+3));
await db.exec('create trigger cmpri_pool_log_audit after insert or update on pool_daily_logs for each row execute function cmpri_audit_pool_log()');
await db.query(`insert into cmpri_inventory_items(id,hotel_id,item_name,unit_of_measure,quantity_on_hand,quantity_reserved) values($1,$2,'Pool bromine','LB',10,2)`,[id(900),h]);
const initial=(await db.query('select * from pool_daily_logs where id=$1',[log])).rows[0];
const firstUse={id:id(901),item:id(900),quantity:16,unit:'OZ'};
const first=(await db.query('update pool_daily_logs set chemical_uses=$1,remarks=$2,updated_by=$3 where id=$4 returning *',[[firstUse],initial.remarks,eng,log])).rows[0];
assert.equal(first.chemical_uses.length,1);assert.match(first.remarks,/Chemical used: 16 OZ Pool bromine/);
const second=(await db.query('update pool_daily_logs set chemical_uses=$1,remarks=$2,updated_by=$3 where id=$4 returning *',[[{...firstUse,id:id(902)}],first.remarks+'\nRetested after adjustment.\nChemical used: 16 OZ Pool bromine.',eng,log])).rows[0];
assert.ok(second.remarks.startsWith(first.remarks));assert.equal(second.chemical_uses.length,2);
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[id(900)])).rows[0].quantity_on_hand),8);
const history=(await db.query('select snapshot from cmpri_pool_log_history where pool_log_id=$1',[log])).rows;
assert.ok(history.some(row=>row.snapshot.chemical_uses?.length===2 && row.snapshot.remarks===second.remarks));
assert.equal(Number(second.revision),Number(initial.revision)+2);
console.log('PASS pool chemical usage with real operator restrictions, saved Remarks prefix, stamp revision and complete audit snapshot');
await db.close();
