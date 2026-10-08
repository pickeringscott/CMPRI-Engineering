import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function resolutionModule() {
  const source = readFileSync(new URL('../src/lib/server/work-order-notification-resolution.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(name) {
      if (name === '@/lib/constants') return { HOTEL_ID: 'cmpri-hotel' };
      if (name === '@/lib/server/roles') return {
        profileHasRole: (profile, role) => role === 'engineer' && profile.role === 'Chief Engineer',
      };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return exports;
}

test('Engineering review tracking does not mark Technician notifications read or cleared', async () => {
  const calls = [];
  const admin = {
    from(table) {
      let operation = '';
      let mutation;
      const filters = [];
      const query = {
        upsert(value) { operation = 'upsert'; mutation = value; return query; },
        select() { operation = 'select'; return query; },
        update(value) { operation = 'update'; mutation = value; return query; },
        eq(key, value) { filters.push(['eq', key, value]); return query; },
        is(key, value) { filters.push(['is', key, value]); return query; },
        in(key, value) { filters.push(['in', key, value]); return query; },
        then(resolve, reject) {
          calls.push({ table, operation, mutation, filters });
          const data = table === 'cmpri_dashboard_notifications' && operation === 'select'
            ? [{ recipient_user_id: 'technician-user' }, { recipient_user_id: 'chief-user' }]
            : table === 'profiles' && operation === 'select'
              ? [{ id: 'technician-user', role: 'Maintenance Technician' }, { id: 'chief-user', role: 'Chief Engineer' }]
              : null;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const { recordEngineeringWorkOrderView, isEngineeringWorkOrderActor } = resolutionModule();
  assert.equal(isEngineeringWorkOrderActor({ role: 'Chief Engineer' }), true);
  assert.equal(isEngineeringWorkOrderActor({ role: 'Maintenance Technician' }), false);

  await recordEngineeringWorkOrderView(admin, { id: 'work-order-1', display_id: 'WO-1' }, { id: 'engineer-user' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'cmpri_work_order_engineering_views');
  assert.equal(calls[0].operation, 'upsert');
});
