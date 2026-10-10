// Real PostgreSQL execution in PGlite, isolated from Supabase production.
// CMPRI_PGLITE_ROOT points to an installation of @electric-sql/pglite 0.5.8.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
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
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
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
  await db.exec(`create table public.cmpri_vendors (id uuid primary key, company_name text not null);
    create table if not exists public.assets (
      id uuid primary key,
      hotel_id uuid,
      name text,
      updated_at timestamptz not null default now()
    );
    create table public.cmpri_inventory_items (id uuid primary key, item_name text not null);
    create table public.cmpri_order_ideas (id uuid primary key);
    create table public.cmpri_vendor_proposals (id uuid primary key);
    create table public.room_operations (
      id uuid primary key default gen_random_uuid(),
      hotel_id uuid not null,
      room text not null,
      reserved boolean not null default false,
      room_status text not null default '',
      departure_date date,
      checkout_time time,
      default_checkout_time boolean not null default true,
      deadline timestamptz,
      arrival_date date,
      checkin_time time,
      default_checkin_time boolean not null default true,
      guest_name text not null default '',
      guest_arrival_date date,
      stay_nights integer not null default 0,
      report_date date,
      moved_from_room text not null default '',
      moved_rooms boolean not null default false,
      room_type text not null default '',
      guest_code text not null default '',
      updated_at timestamptz not null default now(),
      constraint room_operations_hotel_id_room_key unique (hotel_id, room)
    );`);
  const assetModelFamilyMigration = readFileSync(new URL('../supabase/migrations/20261006160000_cmpri_asset_model_family.sql', import.meta.url), 'utf8');
  await check('asset model-family migration', async () => db.exec(assetModelFamilyMigration));
  await check('asset model-family migration is idempotent', async () => db.exec(assetModelFamilyMigration));
  await check('asset model-family field is stored on equipment', async () => {
    const { rows } = await db.query(`select column_name from information_schema.columns
      where table_schema='public' and table_name='assets' and column_name='model_family'`);
    assert.deepEqual(rows, [{ column_name: 'model_family' }]);
  });
  const databaseSafetyMigration = readFileSync(new URL('../supabase/migrations/20261007090000_cmpri_database_safety_guards.sql', import.meta.url), 'utf8');
  await check('database safety guards migration', async () => db.exec(databaseSafetyMigration));
  await check('database safety guards migration is idempotent', async () => db.exec(databaseSafetyMigration));
  await check('account role and active updates are applied together', async () => {
    const testHotel = '00000000-0000-0000-0000-000000000910';
    const testUser = '00000000-0000-0000-0000-000000000911';
    await db.exec(`insert into public.hotels (id, code, name, timezone, default_checkout_time, default_checkin_time, created_at, updated_at)
      values (${quote(testHotel)}, 'SAFETY_TEST', 'Safety Test', 'UTC', '11:00', '15:00', now(), now());
      insert into public.profiles (id, role, property_scope, active, created_at, updated_at, preferred_language, full_name)
      values (${quote(testUser)}, 'manager', 'assigned_property', true, now(), now(), 'en', 'Safety Test User');
      insert into public.hotel_members (hotel_id, user_id, role, active, created_at)
      values (${quote(testHotel)}, ${quote(testUser)}, 'manager', true, now());
      select set_config('cmpri.test_role', 'service_role', false);`);
    await db.query(`select public.cmpri_update_user_access(
      ${quote(testUser)}, ${quote(testHotel)}, 'manager', true, null, false,
      'engineer', false, 'manager'::public.hotel_role, true,
      'admin'::public.hotel_role, false
    )`);
    await db.exec(`select set_config('cmpri.test_role', '', false);`);
    const { rows: profiles } = await db.query(`select role, active from public.profiles where id=${quote(testUser)}`);
    const { rows: memberships } = await db.query(`select role::text, active from public.hotel_members where hotel_id=${quote(testHotel)} and user_id=${quote(testUser)}`);
    assert.deepEqual(profiles, [{ role: 'engineer', active: false }]);
    assert.deepEqual(memberships, [{ role: 'admin', active: false }]);
  });
  await check('verified equipment rejects subsequent field updates', async () => {
    const testHotel = '00000000-0000-0000-0000-000000000910';
    const testUser = '00000000-0000-0000-0000-000000000911';
    const testAsset = '00000000-0000-0000-0000-000000000912';
    await db.exec(`insert into public.assets (id, hotel_id, name, updated_at)
      values (${quote(testAsset)}, ${quote(testHotel)}, 'Before verification', now());
      select set_config('cmpri.test_role', 'service_role', false);`);
    await db.query(`select public.cmpri_verify_asset_documentation(
      ${quote(testAsset)}, ${quote(testHotel)},
      (select updated_at from public.assets where id=${quote(testAsset)}),
      ${quote(testUser)}
    )`);
    await assert.rejects(
      db.exec(`update public.assets set name='After verification' where id=${quote(testAsset)}`),
      /Verified equipment is locked against changes/,
    );
    await db.exec(`select set_config('cmpri.test_role', '', false);`);
    const { rows } = await db.query(`select name, documentation_verified_at is not null as verified
      from public.assets where id=${quote(testAsset)}`);
    assert.deepEqual(rows, [{ name: 'Before verification', verified: true }]);
  });
  await check('application database role cannot delete hotels or work orders', async () => {
    const testHotel = '00000000-0000-0000-0000-000000000910';
    const testWorkOrder = '00000000-0000-0000-0000-000000000913';
    await db.exec(`insert into public.work_orders (
        id, hotel_id, display_id, room, asset_name, category, issue, priority,
        technician_name, action_root_cause, parts, cost, hours, status, notes,
        logged_on, created_at, updated_at, creator_name, creator_initials, creator_source
      ) values (
        ${quote(testWorkOrder)}, ${quote(testHotel)}, 'SAFETY-TEST', '1', '', 'General',
        'Test issue', 'Medium', '', '', '', 0, 0, 'Open', '', current_date, now(), now(), '', '', 'signed_in_user'
      );
      alter table public.hotels disable row level security;
      alter table public.work_orders disable row level security;
      alter table public.hotels owner to service_role;
      alter table public.work_orders owner to service_role;
      set role service_role;`);
    const { rows: deletionPrivileges } = await db.query(`select
      current_user as current_user,
      has_table_privilege(current_user, 'public.hotels', 'delete') as can_delete_hotels,
      has_table_privilege(current_user, 'public.work_orders', 'delete') as can_delete_work_orders`);
    assert.deepEqual(deletionPrivileges, [{
      current_user: 'service_role',
      can_delete_hotels: true,
      can_delete_work_orders: true,
    }]);
    try {
      await assert.rejects(
        db.exec(`delete from public.hotels where id=${quote(testHotel)}`),
        /Hotel records cannot be deleted/,
      );
      await assert.rejects(
        db.exec(`delete from public.work_orders where id=${quote(testWorkOrder)}`),
        /Work orders cannot be permanently deleted/,
      );
    } finally {
      await db.exec('reset role');
    }
    await db.exec(`select set_config('cmpri.test_role', '', false);`);
  });
  await db.exec(`create table public.cmpri_dashboard_notifications (
      id uuid primary key,
      hotel_id uuid not null,
      recipient_user_id uuid not null,
      notification_key text not null,
      work_order_id uuid,
      target_path text,
      message text not null,
      recorded_at timestamptz not null default now(),
      cleared_at timestamptz
    );`);
  await db.exec(`create table public.cmpri_work_order_history (
      id uuid primary key default gen_random_uuid(),
      hotel_id uuid not null,
      work_order_id uuid not null,
      actor_user_id uuid,
      event_type text not null,
      recorded_at timestamptz not null default now(),
      snapshot jsonb not null default '{}'::jsonb
    );`);
  const vendorWebsiteMigration = readFileSync(new URL('../supabase/migrations/20261004090000_cmpri_vendors_website.sql', import.meta.url), 'utf8');
  await check('vendor website migration', async () => db.exec(vendorWebsiteMigration));
  await check('vendor website migration is idempotent', async () => db.exec(vendorWebsiteMigration));
  await check('vendor website is optional and persists values', async () => {
    await db.exec(`insert into public.cmpri_vendors (id, company_name) values (${quote('00000000-0000-0000-0000-000000000004')}, 'Audit Vendor')`);
    const { rows } = await db.query(`select website from public.cmpri_vendors where id=${quote('00000000-0000-0000-0000-000000000004')}`);
    assert.equal(rows[0].website, '');
    await db.exec(`update public.cmpri_vendors set website='https://vendor.example.invalid' where id=${quote('00000000-0000-0000-0000-000000000004')}`);
    const { rows: updated } = await db.query(`select website from public.cmpri_vendors where id=${quote('00000000-0000-0000-0000-000000000004')}`);
    assert.equal(updated[0].website, 'https://vendor.example.invalid');
  });
  const goLiveNotificationMigration = readFileSync(new URL('../supabase/migrations/20261005170000_cmpri_go_live_permissions_and_notifications.sql', import.meta.url), 'utf8');
  await check('CMPRI go-live notification migration', async () => db.exec(goLiveNotificationMigration));
  await check('CMPRI go-live notification migration is idempotent', async () => db.exec(goLiveNotificationMigration));
  const webPushMigration = readFileSync(new URL('../supabase/migrations/20261006140000_cmpri_web_push_and_engineering_views.sql', import.meta.url), 'utf8');
  await check('CMPRI Web Push and Engineering-view migration', async () => db.exec(webPushMigration));
  await check('CMPRI Web Push and Engineering-view migration is idempotent', async () => db.exec(webPushMigration));
  await check('Engineering status changes resolve only technician new-order rows', async () => {
    const engineer = '00000000-0000-0000-0000-000000000901';
    const technician = '00000000-0000-0000-0000-000000000902';
    const order = '00000000-0000-0000-0000-000000000903';
    const engineerNotification = '00000000-0000-0000-0000-000000000904';
    const technicianNotification = '00000000-0000-0000-0000-000000000905';
    const frontDesk = '00000000-0000-0000-0000-000000000906';
    const unrelatedOrder = '00000000-0000-0000-0000-000000000907';
    const unrelatedNotification = '00000000-0000-0000-0000-000000000908';
    await db.exec(`insert into public.profiles(id,role,active,full_name) values
        (${quote(engineer)},'engineer',true,'Test Engineer'),
        (${quote(technician)},'technician',true,'Test Technician'),
        (${quote(frontDesk)},'front_desk',true,'Test Front Desk');
      insert into public.hotel_members(hotel_id,user_id,role,active) values
        (${quote(hotel)},${quote(engineer)},'admin',true),
        (${quote(hotel)},${quote(technician)},'admin',true),
        (${quote(hotel)},${quote(frontDesk)},'viewer',true);
      insert into public.work_orders(id,hotel_id,display_id,room,issue,status)
        values
          (${quote(order)},${quote(hotel)},'WO-TEST','Room 1','Test issue','Open'),
          (${quote(unrelatedOrder)},${quote(hotel)},'WO-OTHER','Room 2','Other issue','Open');
      insert into public.cmpri_dashboard_notifications(id,hotel_id,recipient_user_id,notification_key,work_order_id,message)
        values
          (${quote(engineerNotification)},${quote(hotel)},${quote(engineer)},'new-order:${order}',${quote(order)},'Chief Engineer item'),
          (${quote(technicianNotification)},${quote(hotel)},${quote(technician)},'new-order:${order}',${quote(order)},'Technician item'),
          (${quote(unrelatedNotification)},${quote(hotel)},${quote(technician)},'new-order:${unrelatedOrder}',${quote(unrelatedOrder)},'Technician item');
      insert into public.cmpri_work_order_history(hotel_id,work_order_id,actor_user_id,event_type,snapshot)
        values
          (${quote(hotel)},${quote(order)},${quote(engineer)},'status_changed','{"display_id":"WO-TEST"}'::jsonb),
          (${quote(hotel)},${quote(unrelatedOrder)},${quote(frontDesk)},'status_changed','{"display_id":"WO-OTHER"}'::jsonb);`);
    const { rows } = await db.query(`select recipient_user_id, cleared_at from public.cmpri_dashboard_notifications
      where work_order_id=${quote(order)} order by recipient_user_id`);
    assert.equal(rows.find((row) => row.recipient_user_id === engineer).cleared_at, null);
    assert.ok(rows.find((row) => row.recipient_user_id === technician).cleared_at);
    const { rows: unrelatedRows } = await db.query(`select cleared_at from public.cmpri_dashboard_notifications
      where id=${quote(unrelatedNotification)}`);
    assert.equal(unrelatedRows[0].cleared_at, null);
  });
  await check('notification read receipts and pool-log targets are constrained and indexed', async () => {
    const { rows: columns } = await db.query(`select column_name from information_schema.columns
      where table_schema='public' and table_name='cmpri_dashboard_notifications' and column_name='read_at'`);
    const { rows: indexes } = await db.query(`select indexname from pg_indexes
      where schemaname='public' and tablename='cmpri_dashboard_notifications' and indexname='cmpri_dashboard_notifications_unread_idx'`);
    const { rows: constraints } = await db.query(`select conname from pg_constraint
      where conrelid='public.cmpri_dashboard_notifications'::regclass and conname='cmpri_dashboard_notifications_target'`);
    assert.equal(columns.length, 1);
    assert.equal(indexes.length, 1);
    assert.equal(constraints.length, 1);
  });
  await check('catalog schema fields exist for inventory notes and proposal links', async () => {
    const { rows } = await db.query(`select table_name, column_name from information_schema.columns
      where table_schema='public' and table_name in ('cmpri_inventory_items','cmpri_vendor_proposals','cmpri_order_ideas')
        and column_name in ('notes','asset_id','work_order_id')
      order by table_name, column_name`);
    assert.deepEqual(rows, [
      { table_name: 'cmpri_inventory_items', column_name: 'notes' },
      { table_name: 'cmpri_order_ideas', column_name: 'work_order_id' },
      { table_name: 'cmpri_vendor_proposals', column_name: 'asset_id' },
      { table_name: 'cmpri_vendor_proposals', column_name: 'work_order_id' },
    ]);
  });
  // Synthetic record checks that a migration does not rewrite historical status.
  await db.exec(`insert into auth.users(id) values (${quote(actor)});
    insert into public.work_orders(hotel_id,display_id,room,issue,status) values (${quote(hotel)},'legacy','Room 409','Legacy task','Done');
    insert into public.profiles(id,role,active,full_name) values (${quote(actor)},'front_desk',true,'Shared Front Desk');
    insert into public.hotel_members(hotel_id,user_id,role,active) values (${quote(hotel)},${quote(actor)},'admin',true);
    select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false);`);
  const files = ['status_values', 'integrations', 'submitter_attribution', 'work_order_revision', 'draft_provenance', 'exact_duplicate_guard', 'work_order_imports', 'pool_log_guard', 'room_operations'];
  for (const file of files) await check(`migration ${file}`, async () => {
    await db.exec(readFileSync(new URL(`../supabase/cmpri_v1_0_${file}.sql`, import.meta.url), 'utf8'));
  });
  const workOrderDuplicateGuardMigration = readFileSync(new URL('../supabase/migrations/20261006150000_cmpri_work_order_duplicate_guard.sql', import.meta.url), 'utf8');
  await check('work-order duplicate guard migration', async () => db.exec(workOrderDuplicateGuardMigration));
  await check('work-order duplicate guard migration is idempotent', async () => db.exec(workOrderDuplicateGuardMigration));
  const draftIdempotencyMigration = readFileSync(new URL('../supabase/migrations/20261009120000_cmpri_work_order_draft_idempotency.sql', import.meta.url), 'utf8');
  await check('draft approval idempotency migration rejects prior duplicate provenance', async () => db.exec(draftIdempotencyMigration));
  await check('draft approval idempotency migration is idempotent', async () => db.exec(draftIdempotencyMigration));
  const draftReviewProvenanceMigration = readFileSync(new URL('../supabase/migrations/20261010170000_cmpri_draft_review_provenance.sql', import.meta.url), 'utf8');
  await check('draft review provenance migration', async () => db.exec(draftReviewProvenanceMigration));
  await check('draft review provenance migration is idempotent', async () => db.exec(draftReviewProvenanceMigration));
  await check('supervisor-approved drafts have a supported creator source', async () => {
    const sourceDraftId = '00000000-0000-0000-0000-000000000022';
    await db.exec(`select set_config('cmpri.test_uid','',false),set_config('cmpri.test_role','service_role',false)`);
    try {
      const { rows } = await db.query(`insert into public.work_orders(
          hotel_id,display_id,room,issue,creator_source,source_draft_id,source_draft_created_by
        ) values ($1,'draft-approval-supervisor','Room 101','Supervisor-approved draft',
          'draft_submitted_by_supervisor',$2,$3) returning creator_source`,
      [hotel, sourceDraftId, actor]);
      assert.deepEqual(rows, [{ creator_source: 'draft_submitted_by_supervisor' }]);
      await assert.rejects(
        () => db.query(`insert into public.work_orders(
            hotel_id,display_id,room,issue,creator_source,source_draft_id,source_draft_created_by
          ) values ($1,'draft-approval-invalid-source','Room 101','Invalid source',
            'unsupported_source','00000000-0000-0000-0000-000000000023',$2)`, [hotel, actor]),
        /work_orders_creator_source_check/,
      );
    } finally {
      await db.exec(`select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false)`);
    }
  });
  await check('one work order can be created per source draft', async () => {
    const sourceDraftId = '00000000-0000-0000-0000-000000000021';
    await db.query(`insert into public.work_orders(hotel_id,display_id,room,issue,submitted_by_name,source_draft_id)
      values ($1,'draft-approval-first','Room 101','Draft request','Test Submitter',$2)`, [hotel, sourceDraftId]);
    await assert.rejects(
      () => db.query(`insert into public.work_orders(hotel_id,display_id,room,issue,submitted_by_name,source_draft_id)
        values ($1,'draft-approval-second','Room 101','Edited draft request','Test Submitter',$2)`, [hotel, sourceDraftId]),
      /duplicate key value violates unique constraint/,
    );
  });
  const workOrderImportsMigration = readFileSync(new URL('../supabase/migrations/20261004120000_cmpri_work_order_imports.sql', import.meta.url), 'utf8');
  await check('work-order imports migration is idempotent', async () => db.exec(workOrderImportsMigration));
  const bromineBandMigration = readFileSync(new URL('../supabase/migrations_archive/20260930030000_cmpri_pool_log_bromine_bands.sql', import.meta.url), 'utf8');
  await check('pool-log bromine-band migration', async () => db.exec(bromineBandMigration));
  await check('pool-log bromine-band migration is idempotent', async () => db.exec(bromineBandMigration));
  const poolLogRequirementsMigration = readFileSync(new URL('../supabase/migrations_archive/20260930060000_cmpri_pool_log_requirements.sql', import.meta.url), 'utf8');
  await check('pool-log requirements migration', async () => db.exec(poolLogRequirementsMigration));
  await check('pool-log requirements migration is idempotent', async () => db.exec(poolLogRequirementsMigration));
  const poolLogDailySamplesMigration = readFileSync(new URL('../supabase/migrations_archive/20260930070000_cmpri_pool_log_daily_samples.sql', import.meta.url), 'utf8');
  await check('pool-log daily-samples migration', async () => db.exec(poolLogDailySamplesMigration));
  await check('pool-log daily-samples migration is idempotent', async () => db.exec(poolLogDailySamplesMigration));
  const dailyRoomOperationsMigration = readFileSync(new URL('../supabase/migrations_archive/20260930040000_cmpri_daily_room_operations.sql', import.meta.url), 'utf8');
  await check('daily room-operations snapshot migration', async () => db.exec(dailyRoomOperationsMigration));
  await check('daily room-operations snapshot migration is idempotent', async () => db.exec(dailyRoomOperationsMigration));
  const technicianViewsMigration = readFileSync(new URL('../supabase/migrations_archive/20260930050000_cmpri_work_order_technician_views.sql', import.meta.url), 'utf8');
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
    const frontDeskManagerPoolLogMigration = readFileSync(new URL('../supabase/migrations/20261006110000_cmpri_front_desk_manager_pool_logs.sql', import.meta.url), 'utf8');
    await db.exec(frontDeskManagerPoolLogMigration);
    await db.exec(frontDeskManagerPoolLogMigration);
  });
  await check('user-management grants are restored for account managers', async () => {
    const migration = readFileSync(new URL('../supabase/migrations_archive/20260926101000_cmpri_manage_users_grants.sql', import.meta.url), 'utf8');
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
    const migration = readFileSync(new URL('../supabase/migrations_archive/20260926101500_cmpri_allow_manager_profile_role.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("insert into public.profiles(id, role, active, full_name) values ('00000000-0000-0000-0000-000000000004', 'manager', true, 'Test Manager')");
    await assert.rejects(
      () => db.exec("insert into public.profiles(id, role, active, full_name) values ('00000000-0000-0000-0000-000000000005', 'unknown_role', true, 'Invalid Role')"),
      /profiles_role_check/,
    );
  });
  await check('Front Desk Manager role migration is idempotent and preserves existing roles', async () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260930230000_cmpri_front_desk_manager_role.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("insert into public.profiles(id, role, active, full_name) values ('00000000-0000-0000-0000-000000000007', 'front_desk_manager', true, 'Test Front Desk Manager')");
    await assert.rejects(
      () => db.exec("insert into public.profiles(id, role, active, full_name) values ('00000000-0000-0000-0000-000000000008', 'unknown_role', true, 'Invalid Role')"),
      /profiles_role_check/,
    );
    const frontDeskManager = '00000000-0000-0000-0000-000000000009';
    await db.exec(`insert into auth.users(id) values (${quote(frontDeskManager)});
      insert into public.profiles(id, role, active, full_name) values (${quote(frontDeskManager)}, 'front_desk_manager', true, 'Test Front Desk Manager');
      insert into public.hotel_members(hotel_id, user_id, role, active) values (${quote(hotel)}, ${quote(frontDeskManager)}, 'viewer', true);
      select set_config('cmpri.test_uid', ${quote(frontDeskManager)}, false);`);
    const { rows: attributed } = await db.query(`insert into public.work_orders(hotel_id, display_id, room, issue, status, submitted_by_name)
      values (${quote(hotel)}, 'front-desk-manager-test', 'Room 409', 'Test request', 'Open', 'Taylor')
      returning creator_name, creator_source, status, submitted_by_name`);
    assert.deepEqual(attributed[0], {
      creator_name: 'Taylor',
      creator_source: 'front_desk_pending_verification',
      status: 'Pending Verification',
      submitted_by_name: 'Taylor',
    });
    await db.exec(`select set_config('cmpri.test_uid', ${quote(actor)}, false);`);
  });
  const secondaryProfileRolesMigration = readFileSync(new URL('../supabase/migrations/20261001022500_cmpri_secondary_profile_roles.sql', import.meta.url), 'utf8');
  await check('secondary profile roles migration supports an empty shadow auth schema', async () => {
    await db.exec(secondaryProfileRolesMigration);
    const { rows } = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='secondary_roles'");
    assert.equal(rows.length, 1);
  });
  await check('secondary profile roles migration assigns engineer alongside system admin', async () => {
    const target = '00000000-0000-0000-0000-000000000011';
    const targetHotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
    await db.exec("alter table public.hotel_members add primary key (hotel_id, user_id)");
    await db.exec(`insert into auth.users(id, email) values (${quote(target)}, 'maint.cmpri@hawkeyehotels.com');
      insert into public.profiles(id, email, role, active, full_name) values (${quote(target)}, 'maint.cmpri@hawkeyehotels.com', 'engineer', true, 'CMPRI Maintenance');
      insert into public.hotel_members(hotel_id, user_id, role, active) values (${quote(targetHotel)}, ${quote(target)}, 'viewer', true);`);
    await db.exec(secondaryProfileRolesMigration);
    await db.exec(secondaryProfileRolesMigration);
    const { rows } = await db.query(`select role, secondary_roles, active from public.profiles where id = ${quote(target)}`);
    assert.deepEqual(rows[0], { role: 'system_admin', secondary_roles: ['engineer'], active: true });
    const { rows: memberships } = await db.query(`select role, active from public.hotel_members where hotel_id = ${quote(targetHotel)} and user_id = ${quote(target)}`);
    assert.deepEqual(memberships[0], { role: 'admin', active: true });
    await assert.rejects(
      () => db.exec(`update public.profiles set secondary_roles = ARRAY['system_admin']::text[] where id = ${quote(target)}`),
      /profiles_secondary_roles_check/,
    );
  });
  await check('user feedback table migration is isolated, constrained, and idempotent', async () => {
    const migration = readFileSync(new URL('../supabase/migrations_archive/20260927100000_cmpri_user_feedback.sql', import.meta.url), 'utf8');
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

    const migration = readFileSync(new URL('../supabase/migrations_archive/20260926102000_cmpri_permanent_user_purge.sql', import.meta.url), 'utf8');
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
        values ($1,$2,'duplicate-active-1','Room 410','Drain blocked!!!','Open')`,[hotel,room]);
      await assert.rejects(
        () => db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
          values ($1,$2,'duplicate-active-2','Room 411','  DRAIN blocked!!! ','Open')`,[hotel,room]),
        /duplicate key/,
      );
    } finally {
      await db.exec(`select set_config('cmpri.test_uid',${quote(actor)},false),set_config('cmpri.test_role','authenticated',false)`);
    }
  });
  await check('duplicate pending submissions are blocked but completed history is allowed', async () => {
    await db.exec("select set_config('cmpri.test_uid','',false),set_config('cmpri.test_role','service_role',false)");
    try {
      await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
        values ($1,$2,'duplicate-pending-1','Room 410','Pending leak guard','Pending Verification')`,[hotel,room]);
      await assert.rejects(
        () => db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
          values ($1,$2,'duplicate-pending-2','Room 411','Pending leak guard','Pending Verification')`,[hotel,room]),
        /duplicate key/,
      );
      await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
        values ($1,$2,'duplicate-history-1','Room 410','Historical leak guard','Completed')`,[hotel,room]);
      await db.query(`insert into public.work_orders(hotel_id,location_id,display_id,room,issue,status)
        values ($1,$2,'duplicate-history-2','Room 410','Historical leak guard','Completed')`,[hotel,room]);
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
    await db.query("update public.profiles set role='front_desk_manager',active=true where id=$1",[actor]);
    const operationalLog=await db.query("insert into public.pool_daily_logs(hotel_id,pool_facility_id,log_date,created_by,updated_by,ph_am,sanitizer_band_am,sample_location_am,temperature_f,flow_rate_gpm,main_drain_visible,filter_backwashed) values ($1,$1,'2026-09-26',$2,$2,7.4,'3-6','shallow',82,80,true,false) returning id,revision",[hotel,actor]);
    assert.equal(Number(operationalLog.rows[0].revision),1);
    await assert.rejects(()=>db.query("update public.pool_daily_logs set ph_am=7.6 where id=$1",[operationalLog.rows[0].id]),/Only System Administrators can change saved pool readings/);
    await db.query("update public.profiles set role='front_desk' where id=$1",[actor]);await assert.rejects(insert,/active CMPRI engineering account/);
    await db.query("update public.profiles set role='system_admin',active=false where id=$1",[actor]);await assert.rejects(insert,/active CMPRI engineering account/);
    await db.query('update public.profiles set active=true where id=$1',[actor]);
    await db.query('update public.hotel_members set active=false where user_id=$1',[actor]);await assert.rejects(insert,/active CMPRI engineering account/);
  });
  const rlsLeastPrivilegeMigration = readFileSync(new URL('../supabase/migrations/20261002214500_cmpri_rls_least_privilege.sql', import.meta.url), 'utf8');
  const membershipIntersectionMigration = readFileSync(new URL('../supabase/migrations/20261002220000_cmpri_membership_capability_intersection.sql', import.meta.url), 'utf8');
  const revokeDirectWritesMigration = readFileSync(new URL('../supabase/migrations/20261002221500_cmpri_revoke_direct_client_writes.sql', import.meta.url), 'utf8');
  const revokeWorkOrderInsertMigration = readFileSync(new URL('../supabase/migrations/20261002223000_cmpri_revoke_direct_work_order_insert.sql', import.meta.url), 'utf8');
  const draftHotelIsolationMigration = readFileSync(new URL('../supabase/migrations/20261005150000_cmpri_work_order_drafts_hotel_isolation.sql', import.meta.url), 'utf8');
  const managerRolePermissionsMigration = readFileSync(new URL('../supabase/migrations/20261006100000_cmpri_manager_role_database_permissions.sql', import.meta.url), 'utf8');
  const workOrderReadCapabilityMigration = readFileSync(new URL('../supabase/migrations/20261006120000_cmpri_work_order_read_capability.sql', import.meta.url), 'utf8');
  await check('least-privilege RLS migration is idempotent and blocks direct role bypasses', async () => {
    const frontDesk = '00000000-0000-0000-0000-000000000013';
    const administrator = '00000000-0000-0000-0000-000000000014';
    const seniorManager = '00000000-0000-0000-0000-000000000015';
    const engineerWithViewerMembership = '00000000-0000-0000-0000-000000000016';
    const secondHotel = '00000000-0000-0000-0000-000000000017';
    const generalManager = '00000000-0000-0000-0000-000000000030';
    const assistantGeneralManager = '00000000-0000-0000-0000-000000000031';
    const frontDeskManager = '00000000-0000-0000-0000-000000000032';
    const cmpriHotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
    await db.exec(`alter table public.profiles drop constraint profiles_role_check;
      alter table public.profiles add constraint profiles_role_check
        check (role in ('engineer', 'technician', 'front_desk', 'housekeeping', 'system_admin', 'manager', 'front_desk_manager', 'senior_management'));`);
    await db.exec(`create table public.cmpri_rls_policy_probe (hotel_id uuid not null, content text not null);
      alter table public.cmpri_rls_policy_probe enable row level security;
      grant all on public.cmpri_rls_policy_probe to anon, authenticated;
      create policy cmpri_rls_probe_member_access on public.cmpri_rls_policy_probe
        using (hotel_id is not null) with check (hotel_id is not null);
      insert into auth.users(id) values
        (${quote(frontDesk)}), (${quote(administrator)}), (${quote(seniorManager)}),
        (${quote(engineerWithViewerMembership)}), (${quote(generalManager)}), (${quote(frontDeskManager)});
      insert into public.profiles(id, role, active, full_name) values
        (${quote(frontDesk)}, 'front_desk', true, 'Test Front Desk'),
        (${quote(administrator)}, 'system_admin', true, 'Test System Administrator'),
        (${quote(seniorManager)}, 'senior_management', true, 'Test Senior Manager'),
        (${quote(engineerWithViewerMembership)}, 'engineer', true, 'Engineer With Viewer Membership'),
        (${quote(generalManager)}, 'manager', true, 'Test General Manager'),
        (${quote(frontDeskManager)}, 'front_desk_manager', true, 'Test Front Desk Manager');
      insert into public.hotel_members(hotel_id, user_id, role, active) values
        (${quote(hotel)}, ${quote(frontDesk)}, 'viewer', true),
        (${quote(hotel)}, ${quote(administrator)}, 'admin', true),
        (${quote(hotel)}, ${quote(seniorManager)}, 'viewer', true),
        (${quote(hotel)}, ${quote(engineerWithViewerMembership)}, 'viewer', true),
        (${quote(hotel)}, ${quote(generalManager)}, 'manager', true),
        (${quote(hotel)}, ${quote(frontDeskManager)}, 'technician', true),
        (${quote(cmpriHotel)}, ${quote(generalManager)}, 'manager', true),
        (${quote(cmpriHotel)}, ${quote(frontDeskManager)}, 'technician', true);
      select set_config('cmpri.test_uid', '', false), set_config('cmpri.test_role', 'service_role', false);
      insert into public.work_orders(hotel_id, display_id, room, issue, status, created_by) values
        (${quote(hotel)}, 'rls-own-order', 'Room 901', 'Own order', 'Open', ${quote(frontDesk)}),
        (${quote(hotel)}, 'rls-other-order', 'Room 902', 'Other order', 'Open', ${quote(administrator)}),
        (${quote(hotel)}, 'rls-viewer-visible-order', 'Room 904', 'Viewer role may read', 'Open', ${quote(administrator)}),
        (${quote(hotel)}, 'manager-open-order', 'Room 908', 'Open manager-visible order', 'Open', ${quote(administrator)}),
        (${quote(hotel)}, 'manager-owned-open-order', 'Room 913', 'Open manager-owned order', 'Open', ${quote(generalManager)}),
        (${quote(hotel)}, 'manager-progress-order', 'Room 909', 'In Progress manager-visible order', 'In Progress', ${quote(administrator)}),
        (${quote(hotel)}, 'manager-closed-order', 'Room 910', 'Closed manager-hidden order', 'Completed', ${quote(administrator)}),
        (${quote(secondHotel)}, 'rls-cross-property-order', 'Room 905', 'Other property', 'Open', ${quote(administrator)});
      create table public.cmpri_pm_proposals (id uuid primary key, hotel_id uuid not null, status text not null, submitted_by uuid);
      alter table public.cmpri_pm_proposals enable row level security;
      grant select on public.cmpri_pm_proposals to authenticated;
      create policy cmpri_pm_proposals_member_read on public.cmpri_pm_proposals
        for select to authenticated using (
          hotel_id = ${quote(cmpriHotel)}::uuid
          and exists (
            select 1 from public.hotel_members membership
            where membership.user_id = auth.uid()
              and membership.hotel_id = cmpri_pm_proposals.hotel_id
              and membership.active = true
          )
        );
      insert into public.cmpri_pm_proposals(id, hotel_id, status, submitted_by)
          values ('00000000-0000-0000-0000-000000000111', ${quote(cmpriHotel)}, 'pending', ${quote(administrator)});
      select set_config('cmpri.test_uid', ${quote(frontDesk)}, false);`);
    await db.exec(rlsLeastPrivilegeMigration);
    await db.exec(rlsLeastPrivilegeMigration);
    await db.exec(membershipIntersectionMigration);
    await db.exec(membershipIntersectionMigration);
    await db.exec(revokeDirectWritesMigration);
    await db.exec(revokeDirectWritesMigration);
    await db.exec(revokeWorkOrderInsertMigration);
    await db.exec(revokeWorkOrderInsertMigration);
    await check('management-role database permissions migration is idempotent', async () => {
      await db.exec(managerRolePermissionsMigration);
      await db.exec(managerRolePermissionsMigration);
    });
    await check('work-order SELECT requires explicit view capability and preserves manager status scope', async () => {
      await db.exec(workOrderReadCapabilityMigration);
      await db.exec(workOrderReadCapabilityMigration);
    });

    await db.exec(`insert into auth.users(id) values (${quote(assistantGeneralManager)});
      insert into public.profiles(id, role, active, full_name) values
        (${quote(assistantGeneralManager)}, 'assistant_manager', true, 'Test Assistant General Manager');
      insert into public.hotel_members(hotel_id, user_id, role, active) values
        (${quote(hotel)}, ${quote(assistantGeneralManager)}, 'technician', true),
        (${quote(cmpriHotel)}, ${quote(assistantGeneralManager)}, 'technician', true);
      select set_config('cmpri.test_uid', '', false), set_config('cmpri.test_role', 'service_role', false);
      insert into public.work_orders(hotel_id, display_id, room, issue, status, created_by) values
        (${quote(hotel)}, 'assistant-open-order', 'Room 911', 'Open assistant-visible order', 'Open', ${quote(administrator)}),
        (${quote(hotel)}, 'assistant-closed-order', 'Room 912', 'Closed assistant-hidden order', 'Completed', ${quote(administrator)});
      select set_config('cmpri.test_uid', ${quote(frontDesk)}, false), set_config('cmpri.test_role', 'authenticated', false);`);

    await db.exec(`ALTER TABLE public.cmpri_work_order_drafts ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.cmpri_work_order_drafts FROM anon, authenticated;
      GRANT SELECT ON public.cmpri_work_order_drafts TO authenticated;
      DROP POLICY IF EXISTS cmpri_work_order_drafts_owner_select ON public.cmpri_work_order_drafts;
      DROP POLICY IF EXISTS cmpri_work_order_drafts_owner_write ON public.cmpri_work_order_drafts;
      CREATE POLICY cmpri_work_order_drafts_owner_select ON public.cmpri_work_order_drafts
        FOR SELECT TO authenticated USING (
          created_by = auth.uid() AND EXISTS (
            SELECT 1 FROM public.hotel_members m
            WHERE m.user_id = auth.uid() AND m.hotel_id = m.hotel_id AND m.active = true
          )
        );
      CREATE POLICY cmpri_work_order_drafts_owner_write ON public.cmpri_work_order_drafts
        FOR ALL TO authenticated USING (
          created_by = auth.uid() AND EXISTS (
            SELECT 1 FROM public.hotel_members m
            WHERE m.user_id = auth.uid() AND m.hotel_id = m.hotel_id AND m.active = true
          )
        ) WITH CHECK (
          created_by = auth.uid() AND EXISTS (
            SELECT 1 FROM public.hotel_members m
            WHERE m.user_id = auth.uid() AND m.hotel_id = m.hotel_id AND m.active = true
          )
        );
      INSERT INTO public.cmpri_work_order_drafts(id, hotel_id, created_by) VALUES
        ('00000000-0000-0000-0000-000000000101', ${quote(hotel)}, ${quote(frontDesk)}),
        ('00000000-0000-0000-0000-000000000102', ${quote(secondHotel)}, ${quote(frontDesk)});`);
    await db.exec('SET ROLE authenticated');
    assert.deepEqual(
      (await db.query('SELECT id FROM public.cmpri_work_order_drafts ORDER BY id')).rows,
      [
        { id: '00000000-0000-0000-0000-000000000101' },
        { id: '00000000-0000-0000-0000-000000000102' },
      ],
      'the baseline predicate exposes a creator draft in a property without membership',
    );
    await db.exec('RESET ROLE');
    await check('work-order draft property isolation migration is idempotent', async () => {
      await db.exec(draftHotelIsolationMigration);
      await db.exec(draftHotelIsolationMigration);
    });
    await db.exec('SET ROLE authenticated');
    assert.deepEqual(
      (await db.query('SELECT id FROM public.cmpri_work_order_drafts ORDER BY id')).rows,
      [{ id: '00000000-0000-0000-0000-000000000101' }],
      'draft RLS must exclude another property even when the same user created the row',
    );
    await db.exec('RESET ROLE');

    const { rows: policyRows } = await db.query("select cmd from pg_policies where schemaname='public' and tablename='cmpri_rls_policy_probe' and policyname='cmpri_rls_probe_member_access'");
    assert.deepEqual(policyRows, [{ cmd: 'SELECT' }]);
    const { rows: grants } = await db.query(`select
      has_table_privilege('authenticated', 'public.cmpri_rls_policy_probe', 'SELECT') as can_read_probe,
      has_table_privilege('authenticated', 'public.cmpri_rls_policy_probe', 'UPDATE') as can_update_probe,
      has_table_privilege('authenticated', 'public.work_orders', 'INSERT') as can_insert_work_orders,
      has_table_privilege('authenticated', 'public.work_orders', 'UPDATE') as can_update_work_orders,
      has_table_privilege('authenticated', 'public.work_orders', 'DELETE') as can_delete_work_orders,
      has_table_privilege('authenticated', 'public.cmpri_work_order_drafts', 'INSERT') as can_insert_drafts,
      has_table_privilege('anon', 'public.profiles', 'SELECT') as anon_can_read_profiles,
      has_table_privilege('anon', 'public.work_orders', 'SELECT') as anon_can_read_work_orders`);
    assert.deepEqual(grants[0], {
      can_read_probe: true,
      can_update_probe: false,
      can_insert_work_orders: false,
      can_update_work_orders: false,
      can_delete_work_orders: false,
      can_insert_drafts: false,
      anon_can_read_profiles: false,
      anon_can_read_work_orders: false,
    });
    assert.equal((await db.query('select public.cmpri_can_view_work_orders($1) as allowed', [hotel])).rows[0].allowed, false);
    assert.equal((await db.query('select public.cmpri_can_submit_work_orders($1) as allowed', [hotel])).rows[0].allowed, true);
    assert.equal((await db.query('select public.cmpri_can_view_open_work_orders_only($1) as limited', [hotel])).rows[0].limited, false);
    assert.equal((await db.query("select role from public.hotel_members where user_id=$1", [frontDesk])).rows[0].role, 'technician');

    for (const [id, role] of [
      [generalManager, 'manager'],
      [assistantGeneralManager, 'assistant_manager'],
      [frontDeskManager, 'front_desk_manager'],
    ]) {
      await db.exec(`select set_config('cmpri.test_uid', ${quote(id)}, false);`);
      assert.equal((await db.query('select public.cmpri_can_view_work_orders($1) as allowed', [hotel])).rows[0].allowed, true, `${role} work-order visibility`);
      assert.equal((await db.query('select public.cmpri_can_view_open_work_orders_only($1) as limited', [hotel])).rows[0].limited, true, `${role} active-order-only scope`);
      await db.exec('set role authenticated');
      assert.deepEqual(
        (await db.query(`select display_id from public.work_orders
          where display_id in ('manager-open-order','manager-owned-open-order','manager-progress-order','manager-closed-order','assistant-open-order','assistant-closed-order')
          order by display_id`)).rows,
        [
          { display_id: 'assistant-open-order' },
          { display_id: 'manager-open-order' },
          { display_id: 'manager-owned-open-order' },
          { display_id: 'manager-progress-order' },
        ],
        `${role} direct Supabase reads include active orders only`,
      );
      assert.equal((await db.query('select id from public.cmpri_pm_proposals')).rows.length, role === 'manager' ? 1 : 0,
        `${role} direct PM visibility`);
      await db.exec('reset role');
    }

    assert.deepEqual((await db.query(`select
      has_table_privilege('authenticated', 'public.cmpri_pm_proposals', 'INSERT') as can_insert,
      has_table_privilege('authenticated', 'public.cmpri_pm_proposals', 'UPDATE') as can_update,
      has_table_privilege('authenticated', 'public.cmpri_pm_proposals', 'DELETE') as can_delete`)).rows[0], {
      can_insert: false,
      can_update: false,
      can_delete: false,
    });

    await db.exec(`select set_config('cmpri.test_uid', ${quote(frontDesk)}, false);`);
    await db.query("update public.profiles set secondary_roles=ARRAY['engineer']::text[] where id=$1", [frontDesk]);
    assert.equal((await db.query('select public.cmpri_can_view_work_orders($1) as allowed', [hotel])).rows[0].allowed, true);
    assert.equal((await db.query('select public.cmpri_can_view_open_work_orders_only($1) as limited', [hotel])).rows[0].limited, false);
    await db.exec('set role authenticated');
    assert.deepEqual(
      (await db.query("select display_id from public.work_orders where display_id='rls-own-order'")).rows,
      [{ display_id: 'rls-own-order' }],
      'view-capable users retain direct reads of their own work orders',
    );
    await db.exec('reset role');
    await db.query("update public.profiles set secondary_roles=ARRAY[]::text[] where id=$1", [frontDesk]);
    await db.exec(`select set_config('cmpri.test_uid', ${quote(seniorManager)}, false);`);
    assert.equal((await db.query('select public.cmpri_can_view_work_orders($1) as allowed', [hotel])).rows[0].allowed, true);
    assert.equal((await db.query('select public.cmpri_can_submit_work_orders($1) as allowed', [hotel])).rows[0].allowed, false);
    await db.exec(`select set_config('cmpri.test_uid', ${quote(engineerWithViewerMembership)}, false);`);
    assert.equal((await db.query('select public.cmpri_can_view_work_orders($1) as allowed', [hotel])).rows[0].allowed, true);
    assert.equal((await db.query('select public.cmpri_can_submit_work_orders($1) as allowed', [hotel])).rows[0].allowed, false);
    assert.equal((await db.query('select public.is_hotel_member($1) as allowed', [secondHotel])).rows[0].allowed, false);

    await db.exec(`select set_config('cmpri.test_uid', ${quote(frontDesk)}, false);
      set role authenticated;`);
    assert.deepEqual((await db.query('select id from public.profiles')).rows, [{ id: frontDesk }]);
    await assert.rejects(
      () => db.query(`insert into public.work_orders(hotel_id, display_id, room, issue, status, created_by, submitted_by_name)
        values (${quote(hotel)}, 'rls-frontdesk-direct', 'Room 907', 'Forged direct submission', 'Closed', ${quote(frontDesk)}, 'Test Front Desk')`),
      /permission denied/,
    );
    const ownOrders = await db.query('select display_id from public.work_orders order by display_id');
    assert.deepEqual(ownOrders.rows, [], 'submit-only users cannot read even their own work orders directly');
    await assert.rejects(
      () => db.query("update public.cmpri_rls_policy_probe set content='forged'"),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query("update public.work_orders set issue='forged' where display_id='rls-own-order'"),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query("delete from public.work_orders where display_id='rls-own-order'"),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query(`insert into public.cmpri_work_order_drafts(id, hotel_id, created_by)
        values ('00000000-0000-0000-0000-000000000031', ${quote(hotel)}, ${quote(frontDesk)})`),
      /permission denied/,
    );
    await db.exec('reset role');

    await db.exec(`select set_config('cmpri.test_uid', ${quote(seniorManager)}, false);
      set role authenticated;`);
    await assert.rejects(
      () => db.query(`insert into public.work_orders(hotel_id, display_id, room, issue, status, created_by)
        values (${quote(hotel)}, 'rls-senior-submit', 'Room 903', 'Should be denied', 'Open', ${quote(seniorManager)})`),
      /permission denied/,
    );
    await db.exec('reset role');

    await db.exec(`select set_config('cmpri.test_uid', ${quote(engineerWithViewerMembership)}, false);
      set role authenticated;`);
    assert.deepEqual(
      (await db.query("select display_id from public.work_orders where display_id='rls-viewer-visible-order'")).rows,
      [{ display_id: 'rls-viewer-visible-order' }],
    );
    await assert.rejects(
      () => db.query(`insert into public.work_orders(hotel_id, display_id, room, issue, status, created_by)
        values (${quote(hotel)}, 'rls-viewer-insert', 'Room 906', 'Should be denied', 'Open', ${quote(engineerWithViewerMembership)})`),
      /permission denied/,
    );
    assert.equal((await db.query("select id from public.work_orders where display_id='rls-cross-property-order'")).rows.length, 0);
    await db.exec('reset role');
    await db.exec(`create table public.cmpri_future_acl_probe (value text);
      select set_config('cmpri.test_uid', ${quote(frontDesk)}, false);
      set role authenticated;`);
    const futureGrants = await db.query(`select
      has_table_privilege('anon', 'public.cmpri_future_acl_probe', 'SELECT') as anon_can_read,
      has_table_privilege('authenticated', 'public.cmpri_future_acl_probe', 'SELECT') as authenticated_can_read,
      has_table_privilege('authenticated', 'public.cmpri_future_acl_probe', 'INSERT') as authenticated_can_insert`);
    assert.deepEqual(futureGrants.rows[0], {
      anon_can_read: false,
      authenticated_can_read: false,
      authenticated_can_insert: false,
    });
    await db.exec('reset role; drop table public.cmpri_future_acl_probe');

    await db.exec(`select set_config('cmpri.test_uid', ${quote(administrator)}, false);
      set role authenticated;`);
    assert.equal((await db.query("select display_id from public.work_orders where display_id like 'rls-%'")).rows.length, 3);
    await assert.rejects(
      () => db.query("update public.work_orders set issue='forged' where display_id='rls-own-order'"),
      /permission denied/,
    );
    await db.exec('reset role');
    await db.exec('drop table public.cmpri_rls_policy_probe');
  });
  await check('room-operations snapshots retain dates and enforce dashboard RLS', async () => {
    const roomOpsFrontDesk = '00000000-0000-0000-0000-000000000018';
    const roomOpsEngineer = '00000000-0000-0000-0000-000000000019';
    const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map(part => [part.type, part.value]));
    const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
    const yesterday = new Date(`${today}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayDate = yesterday.toISOString().slice(0, 10);
    await db.exec(`insert into public.hotels(id,code,name)
      values (${quote(hotel)},'audit-room-ops','Audit Room Ops')
      on conflict (id) do nothing;
      insert into auth.users(id) values (${quote(roomOpsFrontDesk)}),(${quote(roomOpsEngineer)});
      insert into public.profiles(id,role,active,full_name) values
        (${quote(roomOpsFrontDesk)},'front_desk',true,'Audit Front Desk'),
        (${quote(roomOpsEngineer)},'engineer',true,'Audit Engineer');
      insert into public.hotel_members(hotel_id,user_id,role,active) values
        (${quote(hotel)},${quote(roomOpsFrontDesk)},'technician',true),
        (${quote(hotel)},${quote(roomOpsEngineer)},'admin',true);
      insert into public.room_operations(hotel_id,room,room_status,guest_name,report_date) values
        (${quote(hotel)},'101','Occupied','Audit Guest',${quote(today)}),
        (${quote(hotel)},'102','Vacant Ready','',null);
      alter table public.room_operations enable row level security;
      grant all on public.room_operations to anon,authenticated;
      create policy room_operations_member_access on public.room_operations
        for select to authenticated using (public.is_hotel_member(hotel_id));`);

    const roomOperationsSnapshotsMigration = readFileSync(new URL('../supabase/migrations/20261004133000_cmpri_room_operations_daily_snapshots.sql', import.meta.url), 'utf8');
    await check('room-operations snapshot/RLS migration', async () => db.exec(roomOperationsSnapshotsMigration));
    await check('room-operations snapshot/RLS migration is idempotent', async () => db.exec(roomOperationsSnapshotsMigration));

    const { rows: backfilled } = await db.query(`select report_date::text from public.room_operations
      where hotel_id=$1 and room='102'`, [hotel]);
    assert.deepEqual(backfilled, [{ report_date: today }]);

    await db.exec(`select set_config('cmpri.test_uid',${quote(roomOpsFrontDesk)},false),set_config('cmpri.test_role','authenticated',false);
      set role authenticated;`);
    assert.deepEqual((await db.query(`select room from public.room_operations where hotel_id=$1`, [hotel])).rows, []);
    await assert.rejects(
      () => db.query(`update public.room_operations set room_status='Forged' where hotel_id=$1`, [hotel]),
      /permission denied/,
    );
    await db.exec('reset role');

    await db.exec(`select set_config('cmpri.test_uid',${quote(roomOpsEngineer)},false),set_config('cmpri.test_role','authenticated',false);
      set role authenticated;`);
    assert.equal((await db.query(`select room from public.room_operations where hotel_id=$1`, [hotel])).rows.length, 2);
    await db.exec('reset role');

    const importRows = status => JSON.stringify([{
      room: '101', room_status: status, guest_name: 'Audit Guest', checkout_date: '',
      checkout_time: '', arrival_date: '', arrival_time: '', guest_arrival_date: '',
      stay_nights: 1, reserved: false, room_type: 'KING', guest_code: '', move_from: '', move_to: '',
    }]);
    await db.exec("select set_config('cmpri.test_role','service_role',false)");
    await db.query(`select public.cmpri_replace_room_operations($1,$2,$3,$4,$5,$6::jsonb)`, [
      hotel, yesterdayDate, actor, 'Local Audit', 'paste', importRows('Vacant Dirty'),
    ]);
    let rows = await db.query(`select report_date::text,room_status from public.room_operations
      where hotel_id=$1 and room='101' order by report_date`, [hotel]);
    assert.deepEqual(rows.rows, [
      { report_date: yesterdayDate, room_status: 'Vacant Dirty' },
      { report_date: today, room_status: 'Occupied' },
    ]);
    await db.query(`select public.cmpri_replace_room_operations($1,$2,$3,$4,$5,$6::jsonb)`, [
      hotel, yesterdayDate, actor, 'Local Audit', 'file', importRows('Vacant Ready'),
    ]);
    rows = await db.query(`select report_date::text,room_status from public.room_operations
      where hotel_id=$1 and room='101' order by report_date`, [hotel]);
    assert.deepEqual(rows.rows, [
      { report_date: yesterdayDate, room_status: 'Vacant Ready' },
      { report_date: today, room_status: 'Occupied' },
    ]);

    await db.exec(`select set_config('cmpri.test_role','authenticated',false);
      set role authenticated;`);
    await assert.rejects(
      () => db.query(`select public.cmpri_replace_room_operations($1,$2,$3,$4,$5,$6::jsonb)`, [
        hotel, today, actor, 'Local Audit', 'paste', importRows('Closed'),
      ]),
      /permission denied/,
    );
    await db.exec('reset role; select set_config(\'cmpri.test_role\',\'service_role\',false)');
    rows = await db.query(`select report_date::text,room_status from public.room_operations
      where hotel_id=$1 and room='101' order by report_date`, [hotel]);
    assert.deepEqual(rows.rows, [
      { report_date: yesterdayDate, room_status: 'Vacant Ready' },
      { report_date: today, room_status: 'Occupied' },
    ]);
  });
  console.log(`${passed} PostgreSQL migration/behavior checks passed. Supabase RLS policies and concurrent sessions are not reproduced.`);
} finally { await db.close(); }
