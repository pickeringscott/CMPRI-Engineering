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
  const files = ['status_values', 'integrations', 'submitter_attribution', 'work_order_revision', 'exact_duplicate_guard', 'pool_log_guard'];
  for (const file of files) await check(`migration ${file}`, async () => {
    await db.exec(readFileSync(new URL(`../supabase/cmpri_v1_0_${file}.sql`, import.meta.url), 'utf8'));
  });
  await check('migrations can be reapplied', async () => {
    for (const file of files) await db.exec(readFileSync(new URL(`../supabase/cmpri_v1_0_${file}.sql`, import.meta.url), 'utf8'));
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
  await check('first-login profile confirmation defaults existing profiles complete and supports new incomplete individuals', async () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260927120000_cmpri_first_login_profile.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query('select manage_profile_first_login_complete from public.profiles where id=$1',[actor])).rows[0].manage_profile_first_login_complete,true);
    const newUser = '00000000-0000-0000-0000-000000000007';
    await db.exec(`insert into auth.users(id) values (${quote(newUser)});
      insert into public.profiles(id,role,active,full_name,manage_profile_first_login_complete)
      values (${quote(newUser)},'engineer',true,'New Engineer',false);`);
    assert.equal((await db.query('select manage_profile_first_login_complete from public.profiles where id=$1',[newUser])).rows[0].manage_profile_first_login_complete,false);
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
  await check('Front Desk tickets retain employee name, shared account id, and named creation-history actor', async () => {
    await db.exec(`insert into public.hotels(id,code,name) values (${quote(hotel)},'TEST','Test Hotel') on conflict(id) do nothing`);
    await db.exec(readFileSync(new URL('../supabase/cmpri_v1_0_work_order_history.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/migrations/20260927130000_cmpri_front_desk_full_name_attribution.sql', import.meta.url), 'utf8'));
    const noteTaker = '00000000-0000-0000-0000-000000000006';
    await db.exec(`insert into public.hotel_members(hotel_id,user_id,role,active) values (${quote(hotel)},${quote(noteTaker)},'admin',true);`);
    await db.exec(`select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false);`);
    const ticket = (await db.query(`insert into public.work_orders(
      hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,
      creator_account_user_id,submitted_by_user_id,status,revision
    ) values ($1,$2,'frontdesk-session-attribution','Room 409','No AC','Taylor Example','spoofed',$3,$3,$3,'Open',1)
    returning id,creator_name,submitted_by_name,created_by,creator_account_user_id,submitted_by_user_id,status`, [hotel,room,actor])).rows[0];
    assert.equal(ticket.creator_name, 'Taylor Example');
    assert.equal(ticket.submitted_by_name, 'Taylor Example');
    assert.equal(ticket.created_by, actor);
    assert.equal(ticket.creator_account_user_id, actor);
    assert.equal(ticket.submitted_by_user_id, actor);
    assert.equal(ticket.status, 'Pending Verification');
    const audit = (await db.query('select actor_user_id,actor_name from public.cmpri_work_order_history where work_order_id=$1', [ticket.id])).rows[0];
    assert.equal(audit.actor_user_id, actor);
    assert.equal(audit.actor_name, 'Taylor Example');
    await db.exec(`select set_config('cmpri.test_uid',${quote(actor)},false);`);
    const nextTicket = (await db.query(`insert into public.work_orders(
      hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,
      creator_account_user_id,submitted_by_user_id,status,revision
    ) values ($1,$2,'frontdesk-session-name-change','Room 410','TV not working','Morgan Employee','spoofed',$3,$3,$3,'Open',1)
    returning id,creator_name,submitted_by_name,created_by`, [hotel,room,actor])).rows[0];
    assert.equal(nextTicket.creator_name, 'Morgan Employee');
    assert.equal(nextTicket.submitted_by_name, 'Morgan Employee');
    assert.equal(nextTicket.created_by, actor);
    const originalTicket = (await db.query('select creator_name,submitted_by_name from public.work_orders where id=$1',[ticket.id])).rows[0];
    assert.equal(originalTicket.creator_name, 'Taylor Example');
    assert.equal(originalTicket.submitted_by_name, 'Taylor Example');
    const cjkTicket = (await db.query(`insert into public.work_orders(
      hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,
      creator_account_user_id,submitted_by_user_id,status,revision
    ) values ($1,$2,'frontdesk-cjk-name','Room 411','Light bulb out','李雷','spoofed',$3,$3,$3,'Open',1)
    returning creator_name,submitted_by_name`, [hotel,room,actor])).rows[0];
    assert.equal(cjkTicket.creator_name, '李雷');
    assert.equal(cjkTicket.submitted_by_name, '李雷');
    const accentedTicket = (await db.query(`insert into public.work_orders(
      hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,
      creator_account_user_id,submitted_by_user_id,status,revision
    ) values ($1,$2,'frontdesk-accented-name','Room 412','No AC','María García','spoofed',$3,$3,$3,'Open',1)
    returning creator_name,submitted_by_name`, [hotel,room,actor])).rows[0];
    assert.equal(accentedTicket.creator_name, 'María García');
    assert.equal(accentedTicket.submitted_by_name, 'María García');
    const spacedCjkTicket = (await db.query(`insert into public.work_orders(
      hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,
      creator_account_user_id,submitted_by_user_id,status,revision
    ) values ($1,$2,'frontdesk-spaced-cjk-name','Room 413','TV not working','李 雷','spoofed',$3,$3,$3,'Open',1)
    returning creator_name,submitted_by_name`, [hotel,room,actor])).rows[0];
    assert.equal(spacedCjkTicket.creator_name, '李 雷');
    assert.equal(spacedCjkTicket.submitted_by_name, '李 雷');
    await db.exec(`select set_config('cmpri.test_uid',${quote(noteTaker)},false);`);
    await db.query("update public.work_orders set notes='Inspector follow-up' where id=$1", [ticket.id]);
    const noteAudit = (await db.query('select actor_user_id,actor_name,changed_fields from public.cmpri_work_order_history where work_order_id=$1 and actor_user_id=$2 order by recorded_at desc limit 1', [ticket.id,noteTaker])).rows[0];
    assert.equal(noteAudit.actor_user_id, noteTaker);
    assert.equal(noteAudit.actor_name, 'Chief Engineer');
    assert.equal(noteAudit.changed_fields.notes, 'Inspector follow-up');
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
      values ($1,$2,'purge-target','Room 101','Disposable account ticket','Taylor Example','Disposable Test User',$3,'Open',1) returning id`, [hotel,room,target])).rows[0];
    await db.exec(`select set_config('cmpri.test_uid', ${quote(actor)}, false), set_config('cmpri.test_role', 'authenticated', false);`);
    const survivorWorkOrder = (await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,status,revision)
      values ($1,$2,'purge-survivor','Room 409','Unrelated employee ticket','Scott Pickering','Shared Front Desk',$3,'Open',1) returning id`, [hotel,room,actor])).rows[0];
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
  const insert = (issue, name='Scott Pickering') => db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,submitted_by_name,creator_name,created_by,status,revision)
    values ($1,$2,'test','Room 409',$3,$4,'Spoof',$1,'Closed',999) returning *`,[hotel,room,issue,name]);
  let saved;
  await check('database enforces full-name attribution and initial revision', async () => {
    saved=(await insert('Sink leaking')).rows[0];
    assert.equal(saved.created_by,actor);assert.equal(saved.creator_name,'Scott Pickering');assert.equal(saved.status,'Pending Verification');assert.equal(Number(saved.revision),1);
  });
  await check('missing full name is rejected by PostgreSQL', async () => { await assert.rejects(()=>insert('Door sticks',''),/full name/); });
  await check('punctuation/case duplicate is blocked by unique index', async () => { await assert.rejects(()=>insert('  SINK leaking!!! '),/duplicate key/); });
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
    const inserted=await db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am) values ($1,$1,'2026-09-15',$2,$2,7.4) returning id,revision",[hotel,actor]);
    const id=inserted.rows[0].id;assert.equal(Number(inserted.rows[0].revision),1);
    await assert.rejects(()=>db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date) values ($1,$1,'2026-09-15')",[hotel]),/duplicate key/);
    const updated=await db.query('update public.pool_daily_logs set ph_pm=7.5,created_by=$1 where id=$2 and revision=1 returning revision,created_by',[hotel,id]);
    assert.equal(Number(updated.rows[0].revision),2);assert.equal(updated.rows[0].created_by,actor);
    assert.equal((await db.query("update public.pool_daily_logs set remarks='stale' where id=$1 and revision=1 returning id",[id])).rows.length,0);
    const audit=await db.query('select snapshot,actor_id from public.cmpri_pool_log_history where pool_log_id=$1 order by recorded_at,id',[id]);
    assert.equal(audit.rows.length,2);assert.ok(audit.rows.every(row=>row.actor_id===actor));
    assert.deepEqual(audit.rows.map(row=>Number(row.snapshot.revision)).sort(),[1,2]);
  });
  await check('pool database trigger rejects front desk, deactivated and unassigned operators', async () => {
    const insert=()=>db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,updated_by) values ($1,$1,'2026-09-16',$2)",[hotel,actor]);
    await db.query("update public.profiles set role='front_desk' where id=$1",[actor]);await assert.rejects(insert,/active engineering account/);
    await db.query("update public.profiles set role='system_admin',active=false where id=$1",[actor]);await assert.rejects(insert,/active engineering account/);
    await db.query('update public.profiles set active=true where id=$1',[actor]);
    await db.query('update public.hotel_members set active=false where user_id=$1',[actor]);await assert.rejects(insert,/active engineering account/);
  });
  console.log(`${passed} PostgreSQL migration/behavior checks passed. Supabase RLS policies and concurrent sessions are not reproduced.`);
} finally { await db.close(); }
