import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const proposalId = '123e4567-e89b-42d3-a456-426614174000';

function fixture(config = {}) {
  const calls = [];
  const proposal = {
    id: proposalId,
    status: 'pending',
    revision: 1,
    proposed_cells: [{
      sheet: 'JAN',
      row: 7,
      column: 10,
      label: 'Check Fire Panel for Troubles',
      kind: 'checkbox',
      expectedValue: 'FALSE',
      proposedValue: 'TRUE',
    }],
  };
  const database = {
    from(table) {
      assert.equal(table, 'cmpri_pm_proposals');
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        maybeSingle: async () => ({ data: { ...proposal }, error: null }),
        update: values => {
          calls.push({ update: values });
          Object.assign(proposal, values);
          proposal.revision += 1;
          const updateQuery = {
            eq: () => updateQuery,
            select: () => updateQuery,
            maybeSingle: async () => ({ data: { ...proposal }, error: null }),
          };
          return updateQuery;
        },
      };
      return query;
    },
  };
  const exports = {};
  const source = ts.transpileModule(readFileSync(path.join(root, 'app/api/preventive-maintenance/review/route.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports,
    Date,
    Number,
    String,
    Array,
    Object,
    Error,
    JSON,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'hotel-id' };
      if (name === '@/lib/server/auth') return {
        requireUser: async () => config.auth === null ? null : {
          principal: {
            identity: { id: 'reviewer-id' },
            profile: { role: config.role || 'System Administrator', secondary_roles: config.secondaryRoles || [] },
          },
          admin: database,
        },
      };
      if (name === '@/lib/server/roles') {
        const roleKey = value => {
          const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
          return ['systemadmin', 'systemadministrator', 'administrator', 'admin'].includes(normalized)
            ? 'system_admin'
            : normalized;
        };
        return {
          profileHasRole: (profile, role) => [profile.role, ...(profile.secondary_roles || [])]
            .some(value => roleKey(value) === role),
        };
      }
      if (name === '@/lib/server/integrations-safe-mode') return { integrationErrorStatus: () => 503 };
      if (name === '@/lib/server/live-pm') return {
        livePmWritesEnabled: () => config.writesEnabled === true,
        applyLivePmChanges: async cells => {
          calls.push({ apply: cells });
          if (config.applyError) throw new Error(config.applyError);
          return { written: cells.length };
        },
      };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return {
    handler: exports.PATCH,
    calls,
    request: body => ({ json: async () => body }),
  };
}

test('only a System Administrator may review PM proposals', async () => {
  const f = fixture({ role: 'Maintenance Technician' });
  const response = await f.handler(f.request({ proposalId, decision: 'approve', expectedRevision: 1 }));
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('a secondary System Administrator role can review PM proposals', async () => {
  const f = fixture({ role: 'Engineer', secondaryRoles: ['system_admin'] });
  const response = await f.handler(f.request({ proposalId, decision: 'reject', expectedRevision: 1 }));
  assert.equal(response.status, 200);
  assert.equal(response.body.proposal.status, 'rejected');
});

test('review approval cannot write unless the independent live-PM gate is enabled', async () => {
  const f = fixture();
  const response = await f.handler(f.request({ proposalId, decision: 'approve', expectedRevision: 1 }));
  assert.equal(response.status, 409);
  assert.equal(f.calls.some(call => call.update), false);
  assert.equal(f.calls.some(call => call.apply), false);
});

test('rejecting a proposal records the decision without writing to the workbook', async () => {
  const f = fixture();
  const response = await f.handler(f.request({ proposalId, decision: 'reject', expectedRevision: 1 }));
  assert.equal(response.status, 200);
  assert.equal(response.body.proposal.status, 'rejected');
  assert.equal(f.calls.some(call => call.apply), false);
});

test('approval reserves, applies, and records a proposal only after explicit confirmation', async () => {
  const f = fixture({ writesEnabled: true });
  const response = await f.handler(f.request({ proposalId, decision: 'approve', expectedRevision: 1 }));
  assert.equal(response.status, 200);
  assert.equal(response.body.proposal.status, 'approved');
  assert.deepEqual(f.calls.filter(call => call.update).map(call => call.update.status), ['processing', 'approved']);
  assert.equal(f.calls.filter(call => call.apply).length, 1);
});
