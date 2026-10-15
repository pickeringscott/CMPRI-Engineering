import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function compile(path, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' } },
    require(name) { if (name in dependencies) return dependencies[name]; throw Error(name); },
  });
  return exports;
}
const roles = compile('../src/lib/server/roles.ts');
const access = compile('../src/lib/server/access.ts', { './roles': roles });
const display = compile('../src/lib/account-display.ts');
const keepers = ['Chief Engineer', 'General Manager', 'Maintenance Technician', 'Front Desk',
  'Assistant General Manager', 'Front Desk Manager', 'Lead Housekeeper'];
const retired = ['Engineering Manager', 'Regional Maintenance', 'Sales Manager'];

function fixture(body = {}, targetRole = 'front_desk', callerRole = 'system_admin') {
  const mutations = [];
  const caller = { id: 'synthetic-admin', role: callerRole, active: true };
  const target = { id: 'synthetic-target', role: targetRole, active: true };
  const admin = {
    auth: { admin: { createUser: async attributes => {
      mutations.push({ operation: 'create', attributes });
      return { data: { user: { id: 'synthetic-created' } }, error: null };
    } } },
    rpc: async (name, args) => { mutations.push({ operation: name, args }); return { error: null }; },
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        maybeSingle: async () => ({ data: target, error: null }),
        order: async () => ({ data: [caller, target], error: null }),
        then(resolve) { return Promise.resolve({ data: [
          { user_id: caller.id, hotel_id: 'hotel', role: 'admin', active: true },
          { user_id: target.id, hotel_id: 'hotel', role: roles.membershipRole(target.role), active: true },
        ], error: null }).then(resolve); },
        upsert: async value => { mutations.push({ operation: 'upsert', table, value }); return { error: null }; },
      };
      return query;
    },
  };
  const handlers = compile('../src/app/api/users/route.ts', {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } },
    '@/lib/constants': { HOTEL_ID: 'hotel' },
    '@/lib/server/auth': { requireCapability: async () => ({ principal: { identity: { id: caller.id }, profile: caller }, admin }) },
    '@/lib/server/roles': roles,
  });
  return { handlers, mutations, request: { json: async () => body } };
}

test('all assignment catalogs expose precisely seven business titles', async () => {
  assert.deepEqual([...roles.ASSIGNABLE_ROLE_LABELS], keepers);
  assert.deepEqual([...roles.assignableRoleLabels('system_admin')], keepers);
  const f = fixture();
  const response = await f.handlers.GET(f.request);
  assert.deepEqual([...response.body.assignable_roles], keepers);
  assert.equal(f.mutations.length, 0);
  for (const caller of ['Chief Engineer', 'General Manager']) {
    assert.deepEqual([...roles.assignableRoleLabels(caller)], keepers.filter(x => !['Chief Engineer', 'General Manager'].includes(x)));
  }
});

for (const role of [...retired, 'engineer', 'Manager', 'Assistant GM', 'Housekeeping', 'system_admin', 'System Administrator']) {
  test(`new assignment rejects retired/internal label ${role} without writes`, async () => {
    const f = fixture({ email: 'synthetic@example.invalid', full_name: 'Synthetic', role, password: 'synthetic-only-password' });
    assert.equal((await f.handlers.POST(f.request)).status, 403);
    assert.equal(f.mutations.length, 0);
    const update = fixture({ id: 'synthetic-target', role });
    assert.equal((await update.handlers.PATCH(update.request)).status, 403);
    assert.equal(update.mutations.length, 0);
  });
}

for (const role of keepers) test(`administrator can create and explicitly assign ${role}`, async () => {
  const f = fixture({ email: 'synthetic@example.invalid', full_name: 'Synthetic', role, password: 'synthetic-only-password' });
  assert.equal((await f.handlers.POST(f.request)).status, 200);
  const profile = f.mutations.find(x => x.table === 'profiles').value;
  const membership = f.mutations.find(x => x.table === 'hotel_members').value;
  assert.equal(profile.role, roles.profileRoleForStorage(role));
  assert.equal(membership.role, roles.membershipRole(role));
  const update = fixture({ id: 'synthetic-target', role });
  assert.equal((await update.handlers.PATCH(update.request)).status, 200);
  assert.equal(update.mutations[0].args.p_new_role, roles.profileRoleForStorage(role));
});

test('legacy aliases retain access and unrelated account edits retain stored roles', async () => {
  for (const [label, family] of [['Engineering Manager', 'engineer'], ['Regional Maintenance', 'engineer'],
    ['Sales Manager', 'front_desk'], ['Assistant GM', 'assistant_manager'], ['Executive Housekeeper', 'housekeeping'],
    ['system_admin', 'system_admin'], ['System Administrator', 'system_admin']]) {
    assert.equal(roles.roleKey(label), family);
    assert.notEqual(roles.landingPath(label), null);
  }
  for (const role of retired) {
    const f = fixture({ id: 'synthetic-target', full_name: 'Renamed' }, role);
    assert.equal((await f.handlers.PATCH(f.request)).status, 200);
    assert.equal(f.mutations[0].args.p_new_role, null);
    assert.equal(f.mutations[0].args.p_expected_role, role);
  }
});

test('existing System Administrator retains full capability and cannot be demoted through user management', async () => {
  const profile = { id: 'synthetic-admin', role: 'system_admin', active: true };
  const principal = { identity: { id: profile.id }, profile, membership: { active: true, role: 'admin' }, permissions: [] };
  for (const capability of ['manage_users', 'manage_assets', 'edit_tickets', 'review_tickets', 'close_tickets', 'reopen', 'view_pm', 'operate_integrations']) {
    assert.equal(access.allows(principal, capability), true, capability);
  }
  assert.equal(display.accountRoleDisplayName(profile), 'System Administrator');
  const f = fixture({ id: 'synthetic-target', role: 'Front Desk' }, 'system_admin');
  assert.equal((await f.handlers.PATCH(f.request)).status, 403);
  assert.equal(f.mutations.length, 0);
  const subordinate = fixture({ role: 'Chief Engineer', email: 'synthetic@example.invalid', full_name: 'Synthetic' }, 'front_desk', 'Chief Engineer');
  assert.equal((await subordinate.handlers.POST(subordinate.request)).status, 403);
});
