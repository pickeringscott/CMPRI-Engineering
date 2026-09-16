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
  await db.exec(`insert into public.work_orders(hotel_id,display_id,room,issue,status) values (${quote(hotel)},'legacy','Room 409','Legacy task','Done');
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
