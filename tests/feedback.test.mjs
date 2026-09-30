import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { roleAllows } from '../src/lib/server/roles.ts';

const source = readFileSync(new URL('../src/app/api/feedback/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const HOTEL_ID = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
const APP_VERSION = 'CMPRI 2.0';

function fixture({ role = 'Front Desk', denied = [], rows = [], adminUnavailable = false } = {}) {
  const inserted = [];
  const updates = [];
  const deleted = [];
  const profile = { full_name: 'Feedback Reporter', role };
  const principal = { identity: { id: 'reporter-id' }, profile };
  const db = {
    from(table) {
      const query = { table, filters: [], operation: 'select', data: null };
      query.select = (_columns, options) => { query.countOnly = options?.head === true && options?.count === 'exact'; return query; };
      query.eq = (field, value) => { query.filters.push([field, value]); return query; };
      query.order = (field, config) => { query.ordering = [field, config]; return query; };
      query.limit = (value) => { query.limitValue = value; return query; };
      query.insert = (value) => { query.operation = 'insert'; query.data = value; inserted.push(value); return query; };
      query.update = (value) => { query.operation = 'update'; query.data = value; updates.push(value); return query; };
      query.delete = () => { query.operation = 'delete'; return query; };
      query.single = async () => ({ data: { id: 'feedback-new', created_at: '2026-09-27T12:00:00.000Z', status: query.data?.status || 'New' }, error: null });
      query.maybeSingle = async () => {
        if (query.operation === 'update') return { data: { ...rows[0], ...query.data }, error: null };
        if (query.operation === 'delete') {
          const index = rows.findIndex((row) => query.filters.every(([field, value]) => row[field] === value));
          if (index === -1) return { data: null, error: null };
          const [removed] = rows.splice(index, 1);
          deleted.push(removed.id);
          return { data: { id: removed.id }, error: null };
        }
        const found = rows.find((row) => query.filters.every(([field, value]) => row[field] === value));
        return { data: found || null, error: null };
      };
      query.then = (resolve, reject) => {
        const matching = rows.filter((row) => query.filters.every(([field, value]) => row[field] === value));
        if (query.ordering) matching.sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (query.countOnly) return Promise.resolve({ count: matching.length, error: null }).then(resolve, reject);
        return Promise.resolve({ data: matching.slice(0, query.limitValue || matching.length), error: null }).then(resolve, reject);
      };
      return query;
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === '@/lib/constants') return { APP_TITLE: 'CMPRI', BUILD_VERSION: '2.0', HOTEL_ID };
      if (name === '@/lib/server/auth') return { requireCapability: async (_request, capability) => denied.includes(capability) ? null : { principal, admin: db } };
      if (name === '@/lib/server/supabase-admin') return { createSupabaseAdmin: () => adminUnavailable ? null : db };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  const request = (body = {}, path = '/api/feedback') => ({
    json: async () => body,
    nextUrl: new URL(`https://feedback.test${path}`),
  });
  return { handlers: exports, inserted, updates, deleted, request, db, rows };
}

test('feedback permissions do not grant work-order editing or queue access to submit-only roles', () => {
  for (const role of ['Front Desk', 'Lead Housekeeper']) {
    assert.equal(roleAllows(role, 'submit_feedback'), true);
    assert.equal(roleAllows(role, 'review_feedback'), false);
    assert.equal(roleAllows(role, 'edit_tickets'), false);
  }
  assert.equal(roleAllows('Chief Engineer', 'submit_feedback'), true);
  assert.equal(roleAllows('Chief Engineer', 'review_feedback'), true);
  assert.equal(roleAllows('Engineer', 'review_feedback'), true);
  assert.equal(roleAllows('Engineering Manager', 'review_feedback'), false);
  assert.equal(roleAllows('Regional Maintenance', 'review_feedback'), false);
  assert.equal(roleAllows('system_admin', 'review_feedback'), true);
  assert.equal(roleAllows('General Manager', 'review_feedback'), false);
});

test('feedback submission records server identity, role, version, and New status separately', async () => {
  const f = fixture({ role: 'Lead Housekeeper' });
  const result = await f.handlers.POST(f.request({ feedback_type: 'Bug', description: 'Profile setting does not persist.', page_route: '/profile' }));
  assert.equal(result.status, 201);
  assert.deepEqual({ ...f.inserted[0] }, {
    hotel_id: HOTEL_ID,
    user_id: 'reporter-id',
    user_name: 'Feedback Reporter',
    user_role: 'Lead Housekeeper',
    feedback_type: 'Bug',
    description: 'Profile setting does not persist.',
    page_route: '/profile',
    app_version: APP_VERSION,
    status: 'New',
  });
  assert.equal(f.db.from('user_feedback').table, 'user_feedback');
  assert.equal('work_orders' in f.inserted[0], false);
});

test('feedback submission accepts lowercase bug and the MCP type alias', async () => {
  const f = fixture({ role: 'Engineer' });
  const result = await f.handlers.POST(f.request({ type: ' bug ', description: 'The MCP write failed.', page_route: '/work-orders' }));
  assert.equal(result.status, 201);
  assert.equal(f.inserted[0].feedback_type, 'Bug');
});

test('invalid type, blank text, invalid route, and unauthorized submit are rejected', async () => {
  for (const body of [
    { feedback_type: 'Other', description: 'text', page_route: '/profile' },
    { feedback_type: 'Problem', description: '  ', page_route: '/profile' },
    { feedback_type: 'Problem', description: 'text', page_route: '//outside.invalid' },
  ]) {
    const f = fixture();
    assert.equal((await f.handlers.POST(f.request(body))).status, 400);
    assert.equal(f.inserted.length, 0);
  }
  const denied = fixture({ role: 'Front Desk', denied: ['submit_feedback'] });
  assert.equal((await denied.handlers.POST(denied.request({ feedback_type: 'Problem', description: 'text', page_route: '/' }))).status, 403);
  assert.equal(denied.inserted.length, 0);
  const missingAdmin = fixture({ role: 'Front Desk', adminUnavailable: true });
  assert.equal((await missingAdmin.handlers.POST(missingAdmin.request({ feedback_type: 'Problem', description: 'text', page_route: '/' }))).status, 503);
  assert.equal(missingAdmin.inserted.length, 0);
});

test('submit-only users cannot list or change feedback status', async () => {
  const f = fixture({ role: 'Front Desk', denied: ['review_feedback'] });
  assert.equal((await f.handlers.GET(f.request())).status, 403);
  assert.equal((await f.handlers.PATCH(f.request({ id: 'feedback-id', status: 'Resolved' }))).status, 403);
  assert.equal(f.updates.length, 0);
});

test('submit-only users cannot delete feedback', async () => {
  const f = fixture({ role: 'Front Desk', denied: ['review_feedback'] });
  const result = await f.handlers.DELETE(f.request({}, '/api/feedback?id=feedback-id'));
  assert.equal(result.status, 403);
  assert.equal(f.deleted.length, 0);
});

test('reviewers can delete a feedback submission by id', async () => {
  const rows = [{ id: 'target', hotel_id: HOTEL_ID, created_at: '2026-09-27T10:00:00Z', status: 'New' }];
  const f = fixture({ role: 'Chief Engineer', rows });
  const result = await f.handlers.DELETE(f.request({}, '/api/feedback?id=target'));
  assert.equal(result.status, 200);
  assert.deepEqual(f.deleted, ['target']);
  assert.equal(f.rows.length, 0);
});

test('deleting a missing or blank feedback id is rejected', async () => {
  const f = fixture({ role: 'Chief Engineer', rows: [] });
  assert.equal((await f.handlers.DELETE(f.request({}, '/api/feedback?id='))).status, 400);
  assert.equal((await f.handlers.DELETE(f.request({}, '/api/feedback'))).status, 400);
  const missing = await f.handlers.DELETE(f.request({}, '/api/feedback?id=nonexistent'));
  assert.equal(missing.status, 404);
});

test('review queue is newest first and status changes record reviewed/resolved times', async () => {
  const rows = [
    { id: 'old', hotel_id: HOTEL_ID, created_at: '2026-09-26T10:00:00Z', status: 'New' },
    { id: 'new', hotel_id: HOTEL_ID, created_at: '2026-09-27T10:00:00Z', status: 'New' },
  ];
  const f = fixture({ role: 'Chief Engineer', rows });
  const listed = await f.handlers.GET(f.request());
  assert.deepEqual(listed.body.feedback.map((row) => row.id), ['new', 'old']);
  const updated = await f.handlers.PATCH(f.request({ id: 'old', status: 'Resolved' }));
  assert.equal(updated.status, 200);
  assert.equal(f.updates[0].status, 'Resolved');
  assert.ok(f.updates[0].reviewed_at);
  assert.ok(f.updates[0].resolved_at);
});

test('reviewer badge count returns only the number of New submissions', async () => {
  const f = fixture({ role: 'Chief Engineer', rows: [
    { id: 'new-1', hotel_id: HOTEL_ID, created_at: '2026-09-27T10:00:00Z', status: 'New' },
    { id: 'resolved', hotel_id: HOTEL_ID, created_at: '2026-09-27T09:00:00Z', status: 'Resolved' },
  ] });
  const result = await f.handlers.GET(f.request({}, '/api/feedback?mode=count'));
  assert.equal(result.body.count, 1);
  assert.equal('feedback' in result.body, false);
});

test('migration enables own-row/reviewer RLS, status constraints, and newest-first indexes', () => {
  const sql = readFileSync(new URL('../supabase/migrations_archive/20260927100000_cmpri_user_feedback.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.user_feedback/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /user_id = auth\.uid\(\)/);
  assert.match(sql, /user_feedback_read_reviewers/);
  assert.match(sql, /user_feedback_update_reviewers/);
  assert.match(sql, /GRANT ALL ON public\.user_feedback TO service_role/);
  assert.match(sql, /GRANT SELECT, UPDATE ON public\.user_feedback TO authenticated/);
  assert.doesNotMatch(sql, /CREATE POLICY user_feedback_submit_own/);
  assert.match(sql, /'engineer', 'chiefengineer'/);
  assert.doesNotMatch(sql, /'engineeringmanager'|'regionalmaintenance'/);
  assert.match(sql, /DEFAULT 'New'/);
  assert.match(sql, /'New', 'Reviewed', 'Planned', 'Resolved'/);
  assert.match(sql, /created_at DESC/);
  assert.doesNotMatch(sql, /work_orders/);
});

test('hardening migration restricts reviewer updates to status/review columns and scopes delete to reviewers', () => {
  const sql = readFileSync(new URL('../supabase/migrations_archive/20260927140000_cmpri_user_feedback_hardening.sql', import.meta.url), 'utf8');
  assert.match(sql, /REVOKE UPDATE ON public\.user_feedback FROM authenticated/);
  assert.match(sql, /GRANT UPDATE \(status, reviewed_at, resolved_at\) ON public\.user_feedback TO authenticated/);
  assert.match(sql, /GRANT DELETE ON public\.user_feedback TO authenticated/);
  assert.match(sql, /CREATE POLICY user_feedback_delete_reviewers/);
  assert.match(sql, /FOR DELETE TO authenticated/);
  assert.match(sql, /'engineer', 'chiefengineer'/);
});

test('feedback entry is in Profile and reviewer-only count is on Engineering, not submit-only dashboards', () => {
  const profile = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  const engineering = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const workOrders = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  const feedback = readFileSync(new URL('../src/app/feedback/page.tsx', import.meta.url), 'utf8');
  assert.match(profile, /Report a Problem \/ Suggestion/);
  assert.match(engineering, /hasCapability\(cmpriSession, "review_feedback"\)[\s\S]*Feedback/);
  assert.doesNotMatch(workOrders, /Feedback \(/);
  assert.match(feedback, /aria-label|aria-labelledby/);
  assert.match(feedback, /originatingRoute\(\)/);
  assert.doesNotMatch(feedback, /w-\[66%\]|w-2\/3/);
});
