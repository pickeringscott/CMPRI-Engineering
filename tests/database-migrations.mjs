// Real PostgreSQL execution in PGlite, isolated from Supabase production.
// CMPRI_PGLITE_ROOT points to an installation of @electric-sql/pglite 0.5.8.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.env.CMPRI_PGLITE_ROOT;
if (!root) throw new Error('Set CMPRI_PGLITE_ROOT to an isolated @electric-sql/pglite installation.');
const { PGlite } = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
const { pgcrypto } = await import(pathToFileURL(path.join(root, 'dist/contrib/pgcrypto.js')).href);
const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const schema = JSON.parse(readFileSync(new URL('./fixtures/live-core-schema-2026-09-15.json', import.meta.url), 'utf8'));
const hotel = '00000000-0000-0000-0000-000000000001';
const actor = '00000000-0000-0000-0000-000000000002';
const room = '00000000-0000-0000-0000-000000000003';
try {
  await db.exec(`create schema auth;
    create table auth.users (id uuid primary key);
    create role anon;
    create role authenticated;
    create role service_role;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('cmpri.test_uid',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select current_setting('cmpri.test_role',true) $$;
    create type public.hotel_role as enum ('admin','manager','technician','viewer');
    create type public.work_order_status as enum ('Open','In Progress','Completed','Done');`);
  for (const [name, definition] of Object.entries(schema.definitions)) {
    const columns = Object.entries(definition.properties).map(([column, spec]) => {
      let defaultValue = '';
      if (Object.hasOwn(spec, 'default')) {
        const value = spec.default;
        defaultValue = ' default ' + (typeof value !== 'string' || /^(gen_random_uuid\(\)|now\(\)|CURRENT_DATE)$/.test(value) ? String(value) : quote(value));
      }
      return `"${column}" ${spec.format}${defaultValue}${definition.required?.includes(column) ? ' not null' : ''}${column === 'id' ? ' primary key' : ''}`;
    });
    await db.exec(`create table public.${name} (${columns.join(',')});`);
  }
  // Synthetic record checks that a migration does not rewrite historical status.
  await db.exec(`insert into auth.users(id) values (${quote(actor)});
    insert into public.work_orders(hotel_id,display_id,room,issue,status) values (${quote(hotel)},'legacy','Room 409','Legacy task','Done');
    insert into public.profiles(id,role,active,full_name) values (${quote(actor)},'front_desk',true,'Shared Front Desk');
    insert into public.hotel_members(hotel_id,user_id,role,active) values (${quote(hotel)},${quote(actor)},'admin',true);
    select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false);`);
  const files = ['status_values', 'integrations', 'submitter_attribution', 'work_order_revision', 'exact_duplicate_guard', 'pool_log_guard', 'room_operations'];
  for (const file of files) await check(`migration ${file}`, async () => {
    await db.exec(readFileSync(new URL(`../supabase/cmpri_v1_0_${file}.sql`, import.meta.url), 'utf8'));
  });
  const bromineBandMigration = readFileSync(new URL('../supabase/migrations/20260930030000_cmpri_pool_log_bromine_bands.sql', import.meta.url), 'utf8');
  await check('pool-log bromine-band migration', async () => db.exec(bromineBandMigration));
  await check('pool-log bromine-band migration is idempotent', async () => db.exec(bromineBandMigration));
  const poolLogRequirementsMigration = readFileSync(new URL('../supabase/migrations/20260930060000_cmpri_pool_log_requirements.sql', import.meta.url), 'utf8');
  await check('pool-log requirements migration', async () => db.exec(poolLogRequirementsMigration));
  await check('pool-log requirements migration is idempotent', async () => db.exec(poolLogRequirementsMigration));
  const poolLogDailySamplesMigration = readFileSync(new URL('../supabase/migrations/20260930070000_cmpri_pool_log_daily_samples.sql', import.meta.url), 'utf8');
  await check('pool-log daily-samples migration', async () => db.exec(poolLogDailySamplesMigration));
  await check('pool-log daily-samples migration is idempotent', async () => db.exec(poolLogDailySamplesMigration));
  const dailyRoomOperationsMigration = readFileSync(new URL('../supabase/migrations/20260930040000_cmpri_daily_room_operations.sql', import.meta.url), 'utf8');
  await check('daily room-operations snapshot migration', async () => db.exec(dailyRoomOperationsMigration));
  await check('daily room-operations snapshot migration is idempotent', async () => db.exec(dailyRoomOperationsMigration));
  const technicianViewsMigration = readFileSync(new URL('../supabase/migrations/20260930050000_cmpri_work_order_technician_views.sql', import.meta.url), 'utf8');
  await check('technician first-view notification migration', async () => db.exec(technicianViewsMigration));
  await check('technician first-view notification migration is idempotent', async () => db.exec(technicianViewsMigration));
  await check('technician first-view notices resolve only after status changes', async () => {
    await db.exec("select set_config('cmpri.test_uid','',false),set_config('cmpri.test_role','service_role',false)");
    const { rows } = await db.query(`insert into public.work_orders(hotel_id,display_id,room,issue,status)
      values (${quote(hotel)},'view-test','Room 410','Technician view test','Open') returning id`);
    await db.exec(`select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false)`);
    const workOrderId = rows[0].id;
    await db.exec(`insert into public.cmpri_work_order_technician_views(
        hotel_id,work_order_id,work_order_display_id,technician_user_id,technician_name,status_at_view
      ) values (${quote(hotel)},${quote(workOrderId)},'view-test',${quote(actor)},'Test Technician','Open');
      update public.work_orders set issue='Updated technician view test' where id=${quote(workOrderId)};`);
    const { rows: pendingViews } = await db.query(`select resolved_at from public.cmpri_work_order_technician_views where work_order_id=${quote(workOrderId)}`);
    assert.equal(pendingViews[0].resolved_at, null);
    await db.exec(`update public.work_orders set status='In Progress' where id=${quote(workOrderId)}`);
    const { rows: views } = await db.query(`select resolved_at from public.cmpri_work_order_technician_views where work_order_id=${quote(workOrderId)}`);
    assert.ok(views[0].resolved_at);
  });
  await check('migrations can be reapplied', async () => {
    for (const file of files) await db.exec(readFileSync(new URL(`../supabase/cmpri_v1_0_${file}.sql`, import.meta.url), 'utf8'));
    // The dated pool-log migration supersedes the v1.0 pool trigger and must follow it.
    await db.exec(poolLogDailySamplesMigration);
  });
  await check('user-management grants are restored for account managers', async () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260926101000_cmpri_manage_users_grants.sql', import.meta.url), 'utf8');
    await db.exec('create table public.role_permissions (role text not null, permission text not null, allowed boolean not null default false)');
    await db.exec("insert into public.role_permissions(role, permission, allowed) values ('Chief Engineer', 'manage_users', false)");
    await db.exec(migration);
    await db.exec(migration);
    const { rows } = await db.query("select role, allowed from public.role_permissions where permission = 'manage_users' order by role");
    assert.deepEqual(rows, [
      { role: 'Chief Engineer', allowed: true },
      { role: 'Engineering Manager', allowed: true },
      { role: 'General Manager', allowed: true },
      { role: 'Regional Maintenance', allowed: true },
    ]);
  });
  await check('manager role is accepted without widening other profile roles', async () => {
    await db.exec("alter table public.profiles add constraint profiles_role_check check (role in ('engineer', 'technician', 'front_desk', 'housekeeping', 'system_admin'))");
    const migration = readFileSync(new URL('../supabase/migrations/20260926101500_cmpri_allow_manager_profile_role.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("insert into public.profiles(id, role, active, full_name) values ('00000000-0000-0000-0000-000000000004', 'manager', true, 'Test Manager')");
    await assert.rejects(
      () => db.exec("insert into public.profiles(id, role, active, full_name) values ('00000000-0000-0000-0000-000000000005', 'unknown_role', true, 'Invalid Role')"),
      /profiles_role_check/,
    );
  });
  await check('user feedback table migration is isolated, constrained, and idempotent', async () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260927100000_cmpri_user_feedback.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const { rows } = await db.query("select relrowsecurity from pg_class where relname='user_feedback'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].relrowsecurity, true);
    const { rows: checks } = await db.query("select count(*)::int as count from pg_constraint where conrelid='public.user_feedback'::regclass and contype='c'");
    assert.ok(checks[0].count >= 4);
    const reviewer = '00000000-0000-0000-0000-000000000006';
    const feedbackHotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
    await db.exec(`insert into auth.users(id) values (${quote(reviewer)});
      insert into public.profiles(id,role,active,full_name) values (${quote(reviewer)},'engineer',true,'Chief Engineer');
      insert into public.hotel_members(hotel_id,user_id,role,active) values (${quote(feedbackHotel)},${quote(actor)},'viewer',true),(${quote(feedbackHotel)},${quote(reviewer)},'admin',true);
      insert into public.user_feedback(hotel_id,user_id,user_name,user_role,feedback_type,description,page_route,app_version)
      values (${quote(feedbackHotel)},${quote(actor)},'Front Desk','Front Desk','Problem','Own feedback','/profile','CMPRI 2.0'),
        (${quote(feedbackHotel)},${quote(reviewer)},'Chief Engineer','Chief Engineer','Suggestion','Reviewer feedback','/engineering','CMPRI 2.0');
      grant select,update on public.user_feedback to authenticated;
      grant select on public.profiles,public.hotel_members to authenticated;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      set role authenticated;
      select set_config('cmpri.test_uid',${quote(actor)},false);`);
    const ownRows = await db.query('select user_id from public.user_feedback order by created_at');
    const rlsContext = (await db.query('select current_user, auth.uid() as user_id')).rows[0];
    assert.equal(ownRows.rows.length, 1, JSON.stringify(rlsContext));
    assert.equal(ownRows.rows[0].user_id, actor);
    await assert.rejects(
      () => db.query(`insert into public.user_feedback(hotel_id,user_id,user_name,user_role,feedback_type,description,page_route,app_version) values ('${feedbackHotel}','${actor}','Spoofed','Engineer','Bug','Direct insert','/','Fake version')`),
      /permission denied/,
    );
    const forbiddenUpdate = await db.query("update public.user_feedback set status='Resolved' where user_id=$1 returning id", [actor]);
    assert.equal(forbiddenUpdate.rows.length, 0);
    await db.exec(`select set_config('cmpri.test_uid',${quote(reviewer)},false);`);
    const reviewRows = await db.query('select user_id from public.user_feedback order by created_at');
    assert.equal(reviewRows.rows.length, 2);
    const reviewerUpdate = await db.query("update public.user_feedback set status='Reviewed' where user_id=$1 returning status", [actor]);
    assert.equal(reviewerUpdate.rows.length, 1);
    await db.exec('reset role');
  });
  await check('test-account purge removes restrictive references before Auth deletion', async () => {
    const target = '00000000-0000-0000-0000-000000000010';
    await db.exec(`create table public.cmpri_work_order_drafts (id uuid primary key, hotel_id uuid not null, created_by uuid not null references auth.users(id) on delete restrict);
      create table public.work_order_creator_audit (id uuid primary key, hotel_id uuid not null, work_order_id uuid not null references public.work_orders(id) on delete cascade, previous_creator_name text not null, previous_creator_initials text not null, corrected_creator_name text not null, corrected_creator_initials text not null, correction_reason text not null, corrected_by uuid not null references auth.users(id) on delete restrict, corrected_at timestamptz not null default now());
      insert into auth.users(id) values (${quote(target)});
      insert into public.profiles(id, role, active, full_name) values (${quote(target)}, 'front_desk', true, 'Disposable Test User');
      insert into public.hotel_members(hotel_id, user_id, role, active) values (${quote(hotel)}, ${quote(target)}, 'viewer', true);
      insert into public.cmpri_work_order_drafts(id, hotel_id, created_by) values ('00000000-0000-0000-0000-000000000030', ${quote(hotel)}, ${quote(target)});
      insert into public.user_feedback(hotel_id,user_id,user_name,user_role,feedback_type,description,page_route,app_version)
      values ('c81ad01a-7a9f-4880-ac1c-5e849f30bad6',${quote(target)},'Disposable Test User','Front Desk','Bug','Disposable feedback','/profile','CMPRI 2.0');
      select set_config('cmpri.test_uid', ${quote(target)}, false), set_config('cmpri.test_role', 'authenticated', false);`);
    const targetWorkOrder = (await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,status,revision)
      values ($1,$2,'purge-target','Room 101','Disposable account ticket','Taylor','Disposable Test User',$3,'Open',1) returning id`, [hotel,room,target])).rows[0];
    await db.exec(`select set_config('cmpri.test_uid', ${quote(actor)}, false), set_config('cmpri.test_role', 'authenticated', false);`);
    const survivorWorkOrder = (await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,status,revision)
      values ($1,$2,'purge-survivor','Room 409','Unrelated employee ticket','Scott','Shared Front Desk',$3,'Open',1) returning id`, [hotel,room,actor])).rows[0];
    await db.exec(`update public.work_orders set creator_account_user_id = ${quote(target)} where display_id = 'purge-survivor';
      insert into public.work_order_creator_audit(id, hotel_id, work_order_id, previous_creator_name, previous_creator_initials, corrected_creator_name, corrected_creator_initials, correction_reason, corrected_by)
      values ('00000000-0000-0000-0000-000000000040', ${quote(hotel)}, ${quote(survivorWorkOrder.id)}, 'Before', 'B', 'After', 'A', 'Test correction', ${quote(target)});`);

    const migration = readFileSync(new URL('../supabase/migrations/20260926102000_cmpri_permanent_user_purge.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.query('select public.purge_cmpri_user($1)', [target]);
    await db.query('select public.purge_cmpri_user($1)', [target]);

    assert.equal((await db.query('select count(*)::int as count from public.profiles where id=$1', [target])).rows[0].count, 0);
    assert.equal((await db.query('select count(*)::int as count from public.hotel_members where user_id=$1', [target])).rows[0].count, 0);
    assert.equal((await db.query('select count(*)::int as count from public.cmpri_work_order_drafts where created_by=$1', [target])).rows[0].count, 0);
    assert.equal((await db.query('select count(*)::int as count from public.user_feedback where user_id=$1', [target])).rows[0].count, 0);
    assert.equal((await db.query('select count(*)::int as count from public.work_orders where id=$1', [targetWorkOrder.id])).rows[0].count, 0);
    assert.equal((await db.query('select creator_account_user_id from public.work_orders where id=$1', [survivorWorkOrder.id])).rows[0].creator_account_user_id, null);
    assert.equal((await db.query('select count(*)::int as count from public.work_order_creator_audit where corrected_by=$1', [target])).rows[0].count, 0);
    assert.equal((await db.query('select has_function_privilege($1, $2, $3) as allowed', ['service_role', 'public.purge_cmpri_user(uuid)', 'EXECUTE'])).rows[0].allowed, true);
    assert.equal((await db.query('select has_function_privilege($1, $2, $3) as allowed', ['authenticated', 'public.purge_cmpri_user(uuid)', 'EXECUTE'])).rows[0].allowed, false);
    await db.query('delete from auth.users where id=$1', [target]);
    assert.equal((await db.query('select count(*)::int as count from auth.users where id=$1', [target])).rows[0].count, 0);
  });
  await check('historical status is retained with initial revision', async () => {
    const { rows } = await db.query("select status,revision from public.work_orders where display_id='legacy'");
    assert.equal(rows[0].status,'Done'); assert.equal(Number(rows[0].revision),1);
  });
  const insert = (issue, name='Scott') => db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,status,revision)
    values ($1,$2,'test','Room 409',$3,$4,'Spoof',$1,'Closed',999) returning *`,[hotel,room,issue,name]);
  let saved;
  await check('database enforces first-name attribution and initial revision', async () => {
    saved=(await insert('Sink leaking')).rows[0];
    assert.equal(saved.created_by,actor);assert.equal(saved.creator_name,'Scott');assert.equal(saved.status,'Pending Verification');assert.equal(Number(saved.revision),1);
  });
  await check('missing first name is rejected by PostgreSQL', async () => { await assert.rejects(()=>insert('Door sticks',''),/first name/); });
  await check('punctuation/case duplicate is blocked by unique index', async () => {
    await db.exec("select set_config('cmpri.test_uid','',false),set_config('cmpri.test_role','service_role',false)");
    try {
      await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
        values ($1,$2,'duplicate-active-1','Room 410','Sink leaking!!!','Open')`,[hotel,room]);
      await assert.rejects(
        () => db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
          values ($1,$2,'duplicate-active-2','Room 411','  SINK leaking!!! ','Open')`,[hotel,room]),
        /duplicate key/,
      );
    } finally {
      await db.exec(`select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false)`);
    }
  });
  await check('stale same-status save cannot overwrite the newer notes', async () => {
    const first=await db.query('update public.work_orders set notes=$1 where id=$2 and revision=1 returning revision',['First save',saved.id]);
    const second=await db.query('update public.work_orders set notes=$1 where id=$2 and revision=1 returning revision',['Stale save',saved.id]);
    assert.equal(first.rows.length,1);assert.equal(Number(first.rows[0].revision),2);assert.equal(second.rows.length,0);
    assert.equal((await db.query('select notes from public.work_orders where id=$1',[saved.id])).rows[0].notes,'First save');
  });
  await check('writer cannot forge the next revision', async () => {
    assert.equal(Number((await db.query('update public.work_orders set revision=999 where id=$1 returning revision',[saved.id])).rows[0].revision),3);
  });
  await check('deactivated profile cannot insert a work order', async () => {
    await db.query('update public.profiles set active=false where id=$1',[actor]);
    await assert.rejects(()=>insert('Different task'),/active account/);
  });
  await check('integration tables have RLS enabled', async () => {
    const {rows}=await db.query("select relrowsecurity from pg_class where relname in ('cmpri_email_events','cmpri_purchases','cmpri_purchase_shipments','cmpri_enseo_tickets','cmpri_warranty_cases','cmpri_supplier_followups','cmpri_gss_reports')");
    assert.equal(rows.length,7);assert.ok(rows.every(row=>row.relrowsecurity));
  });
  await check('pool log insert and edits retain attribution, audit snapshots and revision guard', async () => {
    await db.query("update public.profiles set active=true,role='system_admin' where id=$1",[actor]);
    const inserted=await db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am,sanitizer_band_am,sample_location_am,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed) values ($1,$1,'2026-09-15',$2,$2,7.4,'2-4','shallow',84,60,true,false) returning id,revision,ph_shallow_am,ph_deep_am",[hotel,actor]);
    const id=inserted.rows[0].id;assert.equal(Number(inserted.rows[0].revision),1);
    assert.equal(Number(inserted.rows[0].ph_shallow_am),7.4);assert.equal(Number(inserted.rows[0].ph_deep_am),7.4);
    await assert.rejects(()=>db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed) values ($1,$1,'2026-09-15',84,60,true,false)",[hotel]),/duplicate key/);
    const split=await db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am,sanitizer_band_am,sample_location_am,ph_pm,sanitizer_band_pm,sample_location_pm,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed) values ($1,$1,'2026-09-22',$2,$2,7.4,'2-4','shallow',7.6,'2-4','deep',84,60,true,false) returning sample_location_am,sample_location_pm,ph_shallow_pm,ph_deep_pm",[hotel,actor]);
    assert.equal(split.rows[0].sample_location_pm,'deep');assert.equal(Number(split.rows[0].ph_shallow_pm),7.6);assert.equal(Number(split.rows[0].ph_deep_pm),7.6);
    const updated=await db.query("update public.pool_daily_logs set ph_pm=7.5,sanitizer_band_pm='3-6',sample_location_pm='shallow',created_by=$1 where id=$2 and revision=1 returning revision,created_by",[hotel,id]);
    assert.equal(Number(updated.rows[0].revision),2);assert.equal(updated.rows[0].created_by,actor);
    assert.equal((await db.query("update public.pool_daily_logs set remarks='stale' where id=$1 and revision=1 returning id",[id])).rows.length,0);
    const audit=await db.query('select snapshot,actor_id from public.cmpri_pool_log_history where pool_log_id=$1 order by recorded_at,id',[id]);
    assert.equal(audit.rows.length,2);assert.ok(audit.rows.every(row=>row.actor_id===actor));
    assert.deepEqual(audit.rows.map(row=>Number(row.snapshot.revision)).sort(),[1,2]);
  });
  await check('pool database trigger automatically records a closure condition for unsafe readings', async () => {
    const base = `hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am,sanitizer_band_am,sample_location_am,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed`;
    const result=await db.query(`insert into public.pool_daily_logs(${base},closure_condition,closure_reason) values ($1,$1,'2026-09-17',$2,$2,7.0,'0','deep',84,60,true,false,false,'Unsafe readings') returning closure_condition,ph_deep_am,ph_middle_am`,[hotel,actor]);
    assert.equal(result.rows[0].closure_condition,true);
    assert.equal(Number(result.rows[0].ph_deep_am),7.0);
    assert.equal(result.rows[0].ph_middle_am,null);
    await assert.rejects(
      ()=>db.query(`insert into public.pool_daily_logs(${base}) values ($1,$1,'2026-09-18',$2,$2,7.4,'not-a-band','shallow',84,60,true,false)`,[hotel,actor]),
      /pool_daily_logs_sanitizer_band_am_check/,
    );
    await assert.rejects(
      ()=>db.query(`insert into public.pool_daily_logs(${base}) values ($1,$1,'2026-09-18',$2,$2,7.4,'2-4','middle',84,60,true,false)`,[hotel,actor]),
      /shallow or deep/,
    );
    for (const [day, temperature, drain] of [['2026-09-23', 84, false], ['2026-09-24', 105, true]]) {
      await assert.rejects(
        ()=>db.query(`insert into public.pool_daily_logs(${base}) values ($1,$1,$3,$2,$2,7.4,'2-4','shallow',$4,60,$5,false)`,[hotel,actor,day,temperature,drain]),
        /pool must be closed/,
      );
    }
  });
  await check('pool closure at pH 8.0 requires a reason and required daily checks', async () => {
    const base = `hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am,sanitizer_band_am,sample_location_am,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed`;
    await assert.rejects(
      () => db.query(`insert into public.pool_daily_logs(${base}) values ($1,$1,'2026-09-19',$2,$2,8.0,'2-4','shallow',84,60,true,false)`,[hotel,actor]),
      /reason is required whenever the pool is closed/,
    );
    for (const missing of ['temperature_f', 'flow_rate_gpm', 'main_drain_visible', 'filter_backwashed']) {
      const values = { temperature_f: '84', flow_rate_gpm: '60', main_drain_visible: 'true', filter_backwashed: 'false', [missing]: 'null' };
      await assert.rejects(
        () => db.query(`insert into public.pool_daily_logs(${base}) values ($1,$1,'2026-09-20',$2,$2,7.4,'2-4','shallow',${values.temperature_f},${values.flow_rate_gpm},${values.main_drain_visible},${values.filter_backwashed})`,[hotel,actor]),
        /Daily checks are required/,
      );
    }
    await assert.rejects(
      () => db.query(`insert into public.pool_daily_logs(${base}) values ($1,$1,'2026-09-20',$2,$2,7.4,null,'shallow',84,60,true,false)`,[hotel,actor]),
      /requires both pH and bromine/,
    );
    const result=await db.query(`insert into public.pool_daily_logs(${base},closure_reason) values ($1,$1,'2026-09-21',$2,$2,8.0,'2-4','deep',84,60,true,false,'pH above operating limit') returning closure_condition,closure_reason`,[hotel,actor]);
    assert.equal(result.rows[0].closure_condition,true);
    assert.equal(result.rows[0].closure_reason,'pH above operating limit');
  });
  await check('engineers add the PM sample to a saved log but cannot change saved readings', async () => {
    await db.query("update public.profiles set role='engineer' where id=$1",[actor]);
    const saved=await db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am,sanitizer_band_am,sample_location_am,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed) values ($1,$1,'2026-09-25',$2,$2,7.4,'2-4','shallow',84,60,true,false) returning id",[hotel,actor]);
    const id=saved.rows[0].id;
    const pm=await db.query("update public.pool_daily_logs set ph_pm=7.6,sanitizer_band_pm='3-6',sample_location_pm='deep',remarks='PM added' where id=$1 returning ph_am,sample_location_am,ph_pm,ph_deep_pm",[id]);
    assert.equal(Number(pm.rows[0].ph_am),7.4);assert.equal(pm.rows[0].sample_location_am,'shallow');assert.equal(Number(pm.rows[0].ph_deep_pm),7.6);
    for (const change of ["ph_am=7.6", "ph_pm=null,sanitizer_band_pm=null", "temperature_f=90", "remarks='replaced'"]) {
      await assert.rejects(()=>db.query(`update public.pool_daily_logs set ${change} where id=$1`,[id]),/Only System Administrators can change saved pool readings/);
    }
    await db.query("update public.profiles set role='system_admin' where id=$1",[actor]);
    assert.equal(Number((await db.query("update public.pool_daily_logs set ph_am=7.6 where id=$1 returning ph_am",[id])).rows[0].ph_am),7.6);
  });
  await check('pool database trigger rejects front desk, deactivated and unassigned operators', async () => {
    const insert=()=>db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,updated_by) values ($1,$1,'2026-09-16',$2)",[hotel,actor]);
    await db.query("update public.profiles set role='front_desk' where id=$1",[actor]);await assert.rejects(insert,/active CMPRI engineering account/);
    await db.query("update public.profiles set role='system_admin',active=false where id=$1",[actor]);await assert.rejects(insert,/active CMPRI engineering account/);
    await db.query('update public.profiles set active=true where id=$1',[actor]);
    await db.query('update public.hotel_members set active=false where user_id=$1',[actor]);await assert.rejects(insert,/active CMPRI engineering account/);
  });
  console.log(`${passed} PostgreSQL migration/behavior checks passed. Supabase RLS policies and concurrent sessions are not reproduced.`);
} finally { await db.close(); }
