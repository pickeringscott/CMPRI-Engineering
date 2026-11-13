import {loadTs,ticketReadDependency} from './helpers/load-ts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { projectLinkedFormReviews } from '../src/lib/pm/linked-form-review.ts';

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
    proposed_cells: [],
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
      const filters = {};
      const query = {
        select: () => query,
        match: () => query,
        eq: (column, value) => { filters[column] = value; return query; },
        maybeSingle: async () => ({
          data: config.pending && (!config.pending.submitted_by || config.pending.submitted_by === filters.submitted_by)
            ? config.pending
            : null,
          error: null,
        }),
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
      if (name === '@/lib/work-order-read-policy' || name === '@/lib/server/work-order-reader') return ticketReadDependency(name,()=>true);
      if (name === '@/lib/uuid') return loadTs('src/lib/uuid.ts');
      if (name === '@/lib/pm/work-order-form-target') return loadTs('src/lib/pm/work-order-form-target.ts');
      if (name === '@/lib/pm/linked-form-review') return { projectLinkedFormReviews };
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'hotel-id' };
      if (name === '@/lib/server/access') return { allows: () => config.canEdit !== false };
      if (name === '@/lib/server/auth') return {
        requireUser: async () => config.auth === null ? null : {
          principal: {
            identity: { id: 'actor-id', email: 'engineer@example.test' },
            profile: {
              full_name: 'Engineer',
              role: config.role || 'Maintenance Technician',
              secondary_roles: config.secondaryRoles || [],
            },
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
          checklist: config.checklist || [{ id: 'daily-task', label: 'Check Fire Panel for Troubles' }],
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
      if (name === '@/lib/server/roles') {
        const roleKey = value => {
          const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
          return ['systemadmin', 'systemadministrator', 'administrator', 'admin'].includes(normalized)
            ? 'system_admin'
            : normalized;
        };
        return {
          roleKey,
          profileHasRole: (profile, role) => [profile.role, ...(profile.secondary_roles || [])]
            .some(value => roleKey(value) === role),
        };
      }
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

test('technician PM saves create CMPRI-only proposals without workbook cell changes', async () => {
  const f = fixture();
  const response = await f.handler(f.request);
  assert.equal(response.status, 201);
  assert.equal(response.body.entry.status, 'pending');
  assert.equal(response.body.entry.can_edit_entry, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.entry.proposed_cells)), []);
  assert.equal(f.calls.some(call => call.table === 'cmpri_pm_proposals'), true);
  assert.equal(f.calls.some(call => call.table === 'cmpri_pm_entries'), false);
});

test('routine saves persist only the one changed checklist item', async () => {
  const f = fixture({
    checklist: [{ id: 'daily-task' }, { id: 'daily-sibling' }],
    body: {
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
    },
  });
  const response = await f.handler(f.request);
  const inserted = f.calls.find(call => call.insert)?.insert;
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(JSON.stringify(inserted.payload.responses)), { 'daily-task': true });
});

test('routine saves merge one changed item and preserve existing sibling responses', async () => {
  const f = fixture({
    checklist: [{ id: 'daily-task' }, { id: 'daily-sibling' }],
    pending: {
      id: 'own-pending-proposal',
      revision: 2,
      submitted_by: 'actor-id',
      payload: { responses: { 'daily-task': true, 'daily-sibling': true } },
    },
    body: {
      templateId: 'workbook:daily',
      periodStart: '2026-01-05',
      scopeKey: 'property',
      responses: { 'daily-task': false },
      formData: {},
      notes: '',
      deficiencyNotes: '',
      completedOn: null,
      isComplete: false,
      workOrderId: null,
      expectedRevision: 2,
    },
  });
  const response = await f.handler(f.request);
  const update = f.calls.find(call => call.update)?.update;
  assert.equal(response.status, 200);
  assert.equal(response.body.entry.can_edit_entry, true);
  assert.deepEqual(JSON.parse(JSON.stringify(update.payload.responses)), {
    'daily-task': false,
    'daily-sibling': true,
  });
});

test('routine API rejects multi-item checkbox saves before database access', async () => {
  const f = fixture({
    checklist: [{ id: 'daily-task' }, { id: 'daily-sibling' }],
    body: {
      templateId: 'workbook:daily',
      periodStart: '2026-01-05',
      scopeKey: 'property',
      responses: { 'daily-task': true, 'daily-sibling': false },
      formData: {},
      notes: '',
      deficiencyNotes: '',
      completedOn: null,
      isComplete: false,
      workOrderId: null,
      expectedRevision: 0,
    },
  });
  const response = await f.handler(f.request);
  assert.equal(response.status, 400);
  assert.match(response.body.error, /exactly one routine checklist item/);
  assert.equal(f.calls.some(call => call.table === 'cmpri_pm_proposals'), false);
});

test('PM proposal saves do not resolve or access Google Sheets', async () => {
  const f = fixture();
  const response = await f.handler(f.request);
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.entry.proposed_cells)), []);
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

test('a secondary System Administrator role can submit PM proposals', async () => {
  const f = fixture({ role: 'Engineer', secondaryRoles: ['system_admin'], canEdit: false });
  const response = await f.handler(f.request);
  assert.equal(response.status, 201);
  assert.equal(response.body.entry.status, 'pending');
});

test("a user cannot edit another submitter's pending PM proposal", async () => {
  const f = fixture({
    pending: { id: 'another-users-proposal', revision: 3, submitted_by: 'other-user-id' },
    body: {
      templateId: 'workbook:daily',
      periodStart: '2026-01-05',
      scopeKey: 'property',
      responses: { 'daily-task': false },
      formData: {},
      notes: '',
      deficiencyNotes: '',
      completedOn: null,
      isComplete: false,
      workOrderId: null,
      expectedRevision: 3,
    },
  });
  const response = await f.handler(f.request);
  assert.equal(response.status, 409);
  assert.equal(f.calls.some(call => call.insert), false);
  assert.equal(f.calls.some(call => call.update), false);
});
