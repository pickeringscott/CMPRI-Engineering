import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));

function fixture(config = {}) {
  const calls = [];
  const modulePath = path.join(root, 'app/api/preventive-maintenance/route.ts');
  const exports = {};
  const source = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const payload = {
    responses: { 'daily-task': true },
    form_data: {},
    notes: '',
    deficiency_notes: '',
    completed_on: null,
    is_complete: false,
    completed_by_name: null,
    work_order_id: null,
  };
  const inserted = {
    id: 'proposal-id',
    template_id: 'workbook:daily',
    period_start: '2026-01-05',
    scope_key: 'property',
    payload,
    proposed_cells: [{ sheet: 'JAN', row: 7, column: 10, expectedValue: 'FALSE', proposedValue: 'TRUE' }],
    status: 'pending',
    submitted_by_name: 'Engineer',
    revision: 1,
    updated_at: '2026-01-05T12:00:00.000Z',
  };
  const database = {
    from(table) {
      calls.push({ table });
      if (table === 'work_orders') {
        const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
        return query;
      }
      if (table !== 'cmpri_pm_proposals') throw new Error(`Unexpected table ${table}`);
      const query = {
        select: () => query,
        match: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: config.pending || null, error: null }),
        insert: values => {
          calls.push({ insert: values });
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        update: values => {
          calls.push({ update: values });
          return query;
        },
      };
      return query;
    },
  };
  vm.runInNewContext(source, {
    exports,
    Date,
    URL,
    URLSearchParams,
    Error,
    Number,
    String,
    Array,
    Object,
    JSON,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'hotel-id' };
      if (name === '@/lib/server/access') return { allows: () => config.canEdit !== false };
      if (name === '@/lib/server/auth') return {
        requireUser: async () => config.auth === null ? null : {
          principal: {
            identity: { id: 'actor-id', email: 'engineer@example.test' },
            profile: { full_name: 'Engineer', role: 'Maintenance Technician' },
          },
          admin: database,
        },
      };
      if (name === '@/lib/pm/catalog') return {
        findPmTemplate: id => id === 'workbook:daily' ? {
          id,
          title: 'Daily Maintenance Checklist',
          cadence: 'daily',
          scope: 'property',
          kind: 'routine',
          checklist: [{ id: 'daily-task', label: 'Check Fire Panel for Troubles' }],
          fields: [],
        } : null,
        PM_ROOM_NUMBERS: ['101'],
        pmWeekDates: week => Array.from({ length: 7 }, (_, index) => {
          const date = new Date(`${week}T12:00:00Z`);
          date.setUTCDate(date.getUTCDate() + index);
          return date.toISOString().slice(0, 10);
        }),
        validPmPeriod: () => true,
      };
      if (name === '@/lib/server/integrations-safe-mode') return { integrationErrorStatus: () => 503 };
      if (name === '@/lib/server/live-pm') return {
        resolveLivePmChanges: async () => [{ sheet: 'JAN', row: 7, column: 10, expectedValue: 'FALSE', proposedValue: 'TRUE' }],
      };
      if (name === '@/lib/server/roles') return { roleKey: value => String(value).toLowerCase() };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const body = config.body ?? {
    templateId: 'workbook:daily',
    periodStart: '2026-01-05',
    scopeKey: 'property',
    responses: { 'daily-task': true },
    formData: {},
    notes: '',
    deficiencyNotes: '',
    completedOn: null,
    isComplete: false,
    workOrderId: null,
    expectedRevision: 0,
  };
  const request = { json: async () => body };
  return { handler: exports.POST, calls, request };
}

test('technician PM saves create pending workbook proposals and never update the live sheet', async () => {
  const f = fixture();
  const response = await f.handler(f.request);
  assert.equal(response.status, 201);
  assert.equal(response.body.entry.status, 'pending');
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.entry.proposed_cells)), [{
    sheet: 'JAN',
    row: 7,
    column: 10,
    expectedValue: 'FALSE',
    proposedValue: 'TRUE',
  }]);
  assert.equal(f.calls.some(call => call.table === 'cmpri_pm_proposals'), true);
  assert.equal(f.calls.some(call => call.table === 'cmpri_pm_entries'), false);
});

test('technician PM proposal creation rejects invalid checkbox responses before persistence', async () => {
  const f = fixture({ body: {
    templateId: 'workbook:daily',
    periodStart: '2026-01-05',
    scopeKey: 'property',
    responses: { 'daily-task': 'yes' },
    formData: {},
    notes: '',
    deficiencyNotes: '',
    completedOn: null,
    isComplete: false,
    workOrderId: null,
    expectedRevision: 0,
  } });
  const response = await f.handler(f.request);
  assert.equal(response.status, 400);
  assert.equal(f.calls.some(call => call.insert), false);
});
