import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';

function compile(relative, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, {exports, process: {env: {SUPABASE_SERVICE_ROLE_KEY: 'synthetic-local-only'}},
    require(name) { if (name in dependencies) return dependencies[name]; throw Error(name); },
  });
  return exports;
}
const roles = compile('../src/lib/server/roles.ts');
const display = compile('../src/lib/account-display.ts');
const schedule = compile('../src/lib/notifications/schedule.ts');

test('Chief Engineer identity survives storage, display and notification eligibility', () => {
  const role = roles.profileRoleForStorage('Chief Engineer');
  assert.equal(role, 'chief_engineer');
  assert.equal(roles.roleKey(role), 'engineer');
  assert.equal(display.roleDisplayName(role), 'Chief Engineer');
  assert.equal(roles.receivesWorkOrderNotifications({role}), true);
  assert.equal(schedule.isWebPushEligibleProfile({role}), true);
  assert.equal(roles.membershipRole(role), roles.membershipRole('Chief Engineer'));
});

test('historical generic engineering roles never acquire Chief Engineer alerts', () => {
  for (const original of ['engineer', 'Engineering Manager', 'Regional Maintenance']) {
    const role = roles.profileRoleForStorage(original);
    assert.equal(role, 'engineer');
    assert.equal(roles.receivesWorkOrderNotifications({role}), false);
    assert.equal(schedule.isWebPushEligibleProfile({role}), false);
  }
  assert.equal(roles.receivesWorkOrderNotifications({role: 'front_desk', secondary_roles: ['chief_engineer']}), true);
  assert.equal(roles.receivesWorkOrderNotifications({role: 'front_desk', secondary_roles: ['engineer']}), false);
});

function accountFixture(body, allowAssignment = true) {
  const saved = [], calls = [];
  const target = {id: 'target', role: 'engineer', active: true, full_name: 'Synthetic'};
  const admin = {
    auth: {admin: {createUser: async () => ({data: {user: {id: 'created'}}})}},
    rpc: async (name, args) => {calls.push({name, args}); return {error: null};},
    from(table) {
      const query = {
        select() {return query;}, eq() {return query;},
        maybeSingle: async () => ({data: target, error: null}),
        then(resolve) {return Promise.resolve({data: [{user_id: 'target', hotel_id: 'hotel', role: 'admin', active: true}], error: null}).then(resolve);},
        upsert: async value => {saved.push({table, value}); return {error: null};},
      };
      return query;
    },
  };
  // Account authorization is a boundary stub here; role conversion is real.
  const handlers = compile('../src/app/api/users/route.ts', {
    'next/server': {NextResponse: {json: (body, init = {}) => ({body, status: init.status ?? 200})}},
    '@/lib/constants': {HOTEL_ID: 'hotel'},
    '@/lib/server/auth': {requireCapability: async () => ({principal: {identity: {id: 'caller'}, profile: {id: 'caller', role: 'Chief Engineer'}}, admin})},
    '@/lib/server/roles': {...roles, canManageTargetProfile: () => allowAssignment},
  });
  return {saved, calls, handlers, request: {json: async () => body}};
}

test('authorized account creation persists Chief Engineer distinction', async () => {
  const f = accountFixture({email: 'synthetic@example.invalid', full_name: 'Synthetic', role: 'Chief Engineer', password: 'synthetic-only-123'});
  const response = await f.handlers.POST(f.request);
  assert.equal(response.status, 200);
  assert.equal(f.saved.find(row => row.table === 'profiles').value.role, 'chief_engineer');
  assert.equal(response.body.user.role, 'chief_engineer');
});

test('explicit role update preserves distinction; unrelated edit leaves historical role alone', async () => {
  const f = accountFixture({id: 'target', role: 'Chief Engineer'});
  assert.equal((await f.handlers.PATCH(f.request)).status, 200);
  assert.equal(f.calls[0].args.p_new_role, 'chief_engineer');
  const rename = accountFixture({id: 'target', full_name: 'Renamed'});
  assert.equal((await rename.handlers.PATCH(rename.request)).status, 200);
  assert.equal(rename.calls[0].args.p_new_role, null);
});

test('role persistence does not bypass the existing assignment authorization boundary', async () => {
  const f = accountFixture({email: 'synthetic@example.invalid', full_name: 'Synthetic', role: 'Chief Engineer'}, false);
  assert.equal((await f.handlers.POST(f.request)).status, 403);
  assert.equal(f.saved.length, 0);
});

test('migration retains old roles and accounts, rejects unknown roles, and leaves RLS intact', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE profiles (id int primary key, role text NOT NULL, secondary_roles text[] NOT NULL DEFAULT '{}',
      CONSTRAINT profiles_role_check CHECK(role IN ('engineer','manager','technician','front_desk','housekeeping','assistant_manager','front_desk_manager')),
      CONSTRAINT profiles_secondary_roles_check CHECK(secondary_roles <@ ARRAY['engineer','manager','technician','front_desk','housekeeping','assistant_manager','front_desk_manager']::text[]));
      ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_deny ON profiles USING (false);
      INSERT INTO profiles(id,role,secondary_roles) VALUES (1,'engineer',ARRAY['technician']);`);
    const before = (await db.query('SELECT * FROM profiles')).rows;
    const policies = (await db.query("SELECT policyname,qual,with_check FROM pg_policies WHERE tablename='profiles'")).rows;
    const migration = readFileSync(new URL('../supabase/migrations/20261012011549_cmpri_chief_engineer_role_identity.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual((await db.query('SELECT * FROM profiles')).rows, before);
    await db.exec("INSERT INTO profiles(id,role,secondary_roles) VALUES (2,'chief_engineer',ARRAY['chief_engineer','technician'])");
    await assert.rejects(db.exec("INSERT INTO profiles(id,role) VALUES (3,'invented')"), /profiles_role_check/);
    await assert.rejects(db.exec("INSERT INTO profiles(id,role,secondary_roles) VALUES (4,'engineer',ARRAY['invented','chief_engineer'])"), /profiles_secondary_roles_check/);
    assert.deepEqual((await db.query("SELECT policyname,qual,with_check FROM pg_policies WHERE tablename='profiles'")).rows, policies);
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='profiles'::regclass")).rows[0].relrowsecurity, true);
  } finally {await db.close();}
});
