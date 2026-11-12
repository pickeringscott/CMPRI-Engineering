import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as checklistDomain from '../src/lib/work-orders/troubleshooting-checklist.ts';
import * as taskReview from '../src/lib/pm/task-review.ts';
import * as access from '../src/lib/server/access.ts';
import * as readers from '../src/lib/server/work-order-reader.ts';
import * as readPolicy from '../src/lib/work-order-read-policy.ts';
import * as policy from '../src/lib/server/work-order-troubleshooting.ts';
import * as knowledge from '../src/lib/manual-knowledge.ts';
import { isUuid } from '../src/lib/uuid.ts';
import { roleKey } from '../src/lib/server/roles.ts';

const hotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
const otherHotel = '00000000-0000-4000-8000-000000000002';
const ticketId = '00000000-0000-4000-8000-000000000003';
const assetId = '00000000-0000-4000-8000-000000000004';
const workerId = '00000000-0000-4000-8000-000000000005';
const secondId = '00000000-0000-4000-8000-000000000006';
const asset = { id: assetId, hotel_id: hotel, active: true, manufacturer: 'ACME', model_family: 'ColdOne', model_number: 'C1', documentation_key: 'manual-c1', documentation_revision_id: null, documentation_verified_at: '2026-11-08T12:00:00Z', pdf_import_links: [] };
const manual = {
  manufacturer: 'ACME', model_family: 'ColdOne', model_number: 'C1',
  source: { verified: true, title: 'ACME service manual', type: 'Service manual', source_file_name: 'c1.pdf', file_url: 'https://private.example/c1.pdf?token=first', source_kind: 'asset-upload', storage_path: `${hotel}/${assetId}/c1.pdf`, sha256: 'a'.repeat(64), registered_file_id: 'registered-c1', registered_updated_at: '2026-11-08T12:00:00Z' },
  symptom_rules: [
    { match: ['not cooling'], steps: ['Inspect the filter.', 'Check the cooling demand.'], source_pages: [12], source_url: 'https://private.example/c1.pdf?token=first' },
    { match: ['not heating'], steps: ['Inspect the heating element.'], source_pages: [20] },
    { match: [], steps: ['Generic steps must not appear.'] },
  ],
  error_codes: [{ code: 'E-42', problem: 'Cooling sensor fault', action: 'Check the sensor connection.', source_pages: [30] }],
  general_checks: ['A generic check must not appear.'],
};
const originalTicket = { id: ticketId, hotel_id: hotel, issue: 'Air conditioner not cooling', reporter_notes: '', asset_id: assetId, revision: 7, status: 'In Progress', created_by: workerId, technician_name: '', notes: 'Existing repair notes.' };
const routeSource = readFileSync(new URL('../src/app/api/work-orders/[id]/troubleshooting/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exitCompiled = ts.transpileModule(readFileSync(new URL('../src/app/api/work-orders/[id]/troubleshooting/exit/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function principal(role = 'Maintenance Technician', id = workerId, name = 'First Technician') {
  return { identity: { id, email: `${id}@example.test` }, profile: { id, email: `${id}@example.test`, role, secondary_roles: [], active: true, full_name: name }, hotelId: hotel,
    membership: { user_id: id, hotel_id: hotel, role: 'admin', active: true }, permissions: [{ role: roleKey(role), permission: 'manage_work_orders', allowed: true }] };
}

function fixture(initial = {}) {
  const state = { principal: principal(), ticket: structuredClone(originalTicket), asset: structuredClone(asset), manual: structuredClone(manual), ledger: [], visits: [], events: [], writes: [], guideReads: 0, authenticated: true, race: null, failFinalize: false, providerCalls: 0, pendingReadFailure: false, failPendingAfterSave: false, ...initial };
  let serial = 100;
  const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const sessions = new Map();
  const visitForActor = () => { if (!sessions.has(state.principal.identity.id)) sessions.set(state.principal.identity.id, uuid()); return sessions.get(state.principal.identity.id); };
  const admin = {
    from(table) {
      const filters = [];
      const rows = () => table === 'work_orders' ? [state.ticket] : table === 'assets' ? [state.asset] : table === 'cmpri_work_order_troubleshooting_checks' ? state.ledger : table === 'cmpri_work_order_troubleshooting_visits' ? state.visits : table === 'cmpri_work_order_troubleshooting_events' ? state.events : [];
      const matching = () => structuredClone(rows().filter(row => filters.every(filter => filter(row))));
      let updateFields;
      const query = { update(fields) { updateFields = fields; return query; }, select() { return query; }, eq(key, value) { filters.push(row => row[key] === value); return query; }, is(key, value) { filters.push(row => (row[key] ?? null) === value); return query; }, gt(key, value) { filters.push(row => row[key] > value); return query; }, order() { return query; }, limit() { return query; }, async maybeSingle() { const row = matching()[0] || null; if (row && updateFields && table === "work_orders") { Object.assign(state.ticket, updateFields); state.ticket.revision++; return { data: structuredClone(state.ticket), error: null }; } return { data: row, error: null }; }, then(resolve, reject) { return Promise.resolve(table === 'cmpri_work_order_troubleshooting_visits' && state.pendingReadFailure ? { data: null, error: Error('Unavailable') } : { data: matching(), error: null }).then(resolve, reject); } };
      return query;
    },
    rpc(name, input) {
      if (name === 'cmpri_finalize_work_order_troubleshooting') {
        let visit = state.visits.find(row => row.id === input.p_visit_id);
        if (visit && (visit.actor_id !== input.p_actor || visit.work_order_id !== input.p_work_order || visit.hotel_id !== input.p_hotel)) return Promise.resolve({ data: null, error: { code: '42501' } });
        if (state.failFinalize) return Promise.resolve({ data: null, error: { code: 'XX000' } });
        if (!visit) { visit = { id: input.p_visit_id, actor_id: input.p_actor, work_order_id: input.p_work_order, hotel_id: input.p_hotel, event_count: 0 }; state.visits.push(visit); }
        if (visit.finalized_at) return Promise.resolve({ data: { finalized: true, already_finalized: true, event_count: visit.event_count, work_order_revision: visit.work_order_revision, note: visit.note_text }, error: null });
        const events = state.events.filter(event => event.visit_id === visit.id);
        const summary = events.map(event => `${event.after_state.status === 'empty' ? 'Cleared' : event.after_state.status === 'approved' ? 'Verified' : 'Checked'}: ${event.step_label}`).join('; ');
        visit.note_text = events.length ? `CMPRI2|2026-11-09T00:00:00Z|${state.principal.profile.full_name}|${state.principal.profile.role}|note|Troubleshooting checklist visit: ${summary}` : null;
        if (visit.note_text) { state.ticket.notes += `\n${visit.note_text}`; state.ticket.revision++; }
        visit.finalized_at = '2026-11-09T00:00:00Z'; visit.work_order_revision = state.ticket.revision;
        return Promise.resolve({ data: { finalized: true, already_finalized: false, event_count: visit.event_count, work_order_revision: visit.work_order_revision, note: visit.note_text }, error: null });
      }
      assert.equal(name, 'cmpri_save_work_order_troubleshooting');
      return { async maybeSingle() {
        if (state.race) { const race = state.race; state.race = null; race(state); }
        if (state.ticket.revision !== input.p_work_order_revision || state.ticket.hotel_id !== input.p_hotel) return { error: { code: '40001', message: 'The work order changed.' } };
        const context = Object.fromEntries(['id','manufacturer','model_family','model_number','serial_number','documentation_key','documentation_revision_id','documentation_verified_at','pdf_import_links'].map(key => [key, state.asset[key] ?? null]));
        if (JSON.stringify(context) !== JSON.stringify(input.p_asset_context)) return { error: { code: '40001', message: 'Equipment guidance changed.' } };
        if (state.events.some(event => event.mutation_id === input.p_mutation_id)) return { error: { code: '40001', message: 'Mutation already used.' } };
        const existing = state.ledger.find(row => row.context_key === input.p_context_key && row.hotel_id === input.p_hotel && row.work_order_id === input.p_work_order);
        if ((existing?.revision || 0) !== input.p_expected_revision) return { error: { code: existing ? '40001' : '23505', message: 'Checklist changed.' } };
        let visit = state.visits.find(row => row.id === input.p_visit_id);
        if (visit && (visit.finalized_at || visit.actor_id !== input.p_actor || visit.work_order_id !== input.p_work_order)) return { error: { code: '40001', message: 'This visit is no longer available.' } };
        if (!visit) { visit = { id: input.p_visit_id, hotel_id: input.p_hotel, work_order_id: input.p_work_order, actor_id: input.p_actor, created_at: '2026-11-08T23:00:00Z', finalized_at: null, event_count: 0 }; state.visits.push(visit); }
        const row = { hotel_id: input.p_hotel, work_order_id: input.p_work_order, context_key: input.p_context_key, revision: (existing?.revision || 0) + 1, task_states: structuredClone(input.p_task_states), updated_by: input.p_actor };
        if (existing) Object.assign(existing, row); else state.ledger.push(row);
        state.writes.push(structuredClone(input));
        state.events.push({ mutation_id: input.p_mutation_id, visit_id: input.p_visit_id, hotel_id: input.p_hotel, work_order_id: input.p_work_order, actor_id: input.p_actor, step_label: input.p_step_label, source: structuredClone(input.p_source), before_state: structuredClone(input.p_before_state), after_state: structuredClone(input.p_after_state), request: { context_key: input.p_context_key, expected_revision: input.p_expected_revision, item_id: input.p_item_id, action: input.p_action, visit_id: input.p_visit_id } });
        visit.event_count++; visit.last_event_at = '2026-11-08T23:30:00Z';
        if (state.failPendingAfterSave) state.pendingReadFailure = true;
        return { data: structuredClone(row), error: null };
      } };
    },
  };
  const exports = {};
  class NextRequest extends Request {}
  const dependencies = { Response, URL, Error, crypto: { randomUUID: uuid }, fetch: () => { state.providerCalls++; throw Error('Troubleshooting must never call an AI provider or outbound fetch.'); }, require(name) {
    if (name === 'node:crypto') return { createHash };
    if (name === 'next/server') return { NextRequest, NextResponse: { json: (body, init) => Response.json(body, init) } };
    if (name === '@/lib/constants') return { HOTEL_ID: hotel };
    if (name === '@/lib/uuid') return { isUuid };
    if (name === '@/lib/server/auth') return { requireUser: async () => state.authenticated ? { principal: state.principal, admin } : null };
    if (name === '@/lib/server/access') return access;
    if (name === '@/lib/server/work-order-reader') return readers;
    if (name === '@/lib/work-order-read-policy') return readPolicy;
    if (name === '@/lib/server/work-order-troubleshooting') return policy;
    if (name === '@/lib/manual-knowledge') return knowledge;
    if (name === '@/lib/pm/task-review') return taskReview;
    if (name === '@/lib/work-orders/troubleshooting-checklist') return checklistDomain;
    if (name === '@/lib/server/uploaded-asset-guide') return { loadUploadedAssetGuide: async (_admin, savedAsset) => {
      state.guideReads++; assert.equal(savedAsset.id, state.ticket.asset_id);
      return { manualKnowledge: state.manual, documentation_status: state.manual?.source?.verified ? 'verified' : 'no_guidance', documentation_reason: 'Synthetic attached source.', documentation_warnings: [] };
    } };
    throw new Error(`Unexpected dependency ${name}`);
  } };
  vm.runInNewContext(compiled, { exports, ...dependencies });
  const exitExports = {}; vm.runInNewContext(exitCompiled, { exports: exitExports, ...dependencies });
  async function run(method, body, id = ticketId, isExit = false) {
    const request = new Request(`https://cmpri.example/api/work-orders/${id}/troubleshooting`, { method, headers: { Authorization: 'Bearer local-test', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const response = await (isExit ? exitExports : exports)[method](request, { params: Promise.resolve({ id }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { state, uuid, get: id => run('GET', undefined, id), patch: body => run('PATCH', { visitId: visitForActor(), mutationId: uuid(), ...body }), restart: body => run('POST', body), exit: body => run('POST', { visitId: visitForActor(), ...body }, ticketId, true) };
}

test('only issue-matched verified actions and explicit reported diagnostic codes become allowed steps', () => {
  const derive = checklistDomain.deriveTroubleshootingChecklistContext;
  const input = { issue: originalTicket.issue, reporter_notes: '', asset };
  const result = derive(input, manual);
  assert.deepEqual(result.steps.map(step => step.label), ['Inspect the filter.', 'Check the cooling demand.']);
  assert.deepEqual(result.steps[0].sourcePages, [12]);
  assert.equal(derive(input, { ...manual, source: { ...manual.source, verified: false } }).contextIdentity, null);
  assert.equal(derive(input, { ...manual, source: { ...manual.source, source_kind: undefined } }).contextIdentity, null, 'catalog knowledge is never a checklist source');
  assert.ok(derive({ ...input, asset: { ...asset, model_family: 'Other', model_number: 'Other' } }, manual).contextIdentity, 'a user-selected manual is not rejected by model-name inference');
  assert.equal(derive({ ...input, issue: 'Room 142 temperature 42 degrees' }, manual).steps.length, 0);
  assert.equal(derive({ ...input, issue: 'Reported fault code E42' }, manual).steps[0].label, 'Check the sensor connection.');
  assert.equal(derive({ ...input, reporter_notes: 'Reported fault code E42' }, manual).steps.length, 3);
  for (const issue of ['No error code E42 is displayed; the unit is noisy.', 'Error code E42 is not present.', 'Error code E42 isn’t displayed.', 'If error code E42 appears, call maintenance.', 'Not seeing any error code E42.', "I don't see error code E42; it is only noisy.", "I can't see code E42.", "Code E42 isn't on the screen.", 'We cannot see error code E42.', 'It is not the error code E42.', 'Fault code E42 was not found.', 'Fault code E42 has not been observed.', "Fault code E42 hasn't occurred."]) {
    assert.equal(derive({ ...input, issue }, manual).steps.some(step => step.kind === 'error-code'), false, issue);
  }
  const later = { ...manual, error_codes: [...manual.error_codes, { code: 'F10', problem: 'Different reported fault', action: 'Inspect the specified F10 circuit.' }] };
  assert.equal(derive({ ...input, issue: 'No error code E42 is displayed, but code F10 is present.' }, later).steps.find(step => step.kind === 'error-code').code, 'F10');
});

test('plain-language issues select only explicit uploaded manual actions without requiring diagnostic codes', async () => {
  const h = fixture();
  h.state.manual.symptom_rules = [
    { match: ['Water leak'], steps: ['Inspect the hose connections.'], source_pages: [4] },
    { match: ['No heat'], steps: ['Check the heater supply.'], source_pages: [8] },
  ];
  h.state.ticket.issue = 'Water all over the floor';
  const leak = await h.get();
  assert.deepEqual(leak.body.steps.map(step => step.label), ['Inspect the hose connections.']);
  assert.equal((await h.patch({ contextKey: leak.body.contextKey, expectedRevision: 0, itemId: leak.body.steps[0].id })).status, 200);
  h.state.ticket.issue = "It won't get hot"; h.state.ticket.revision++;
  const heat = await h.get();
  assert.deepEqual(heat.body.steps.map(step => step.label), ['Check the heater supply.']);
  assert.notEqual(heat.body.contextKey, leak.body.contextKey); assert.deepEqual(heat.body.taskStates, {});
  assert.equal((await h.patch({ contextKey: leak.body.contextKey, expectedRevision: 1, itemId: 'step-1' })).status, 409);
  h.state.ticket.issue = 'It is broken'; h.state.ticket.revision++;
  const vague = await h.get();
  assert.deepEqual(vague.body.steps, []); assert.equal(vague.body.reason, 'No matching instructions in the attached document.');
  assert.equal(h.state.providerCalls, 0);
});

test('stable context excludes rotating links and changes with issue, equipment, documentation and matched source content', () => {
  const derive = checklistDomain.deriveTroubleshootingChecklistContext;
  const input = { issue: originalTicket.issue, reporter_notes: '', asset };
  const first = derive(input, manual).contextIdentity;
  const rotated = structuredClone(manual); rotated.source.file_url += '-new'; rotated.symptom_rules[0].source_url += '-new';
  assert.equal(derive(input, rotated).contextIdentity, first);
  for (const changed of [ { ...input, issue: 'It is not cooling today' }, { ...input, reporter_notes: 'Reported code E42' }, { ...input, asset: { ...asset, id: secondId } }, { ...input, asset: { ...asset, documentation_key: 'other' } }, { ...input, asset: { ...asset, documentation_revision_id: secondId } } ]) assert.notEqual(derive(changed, manual).contextIdentity, first);
  const changed = structuredClone(manual); changed.symptom_rules[0].steps[0] = 'Inspect the actual cooling filter.';
  assert.notEqual(derive(input, changed).contextIdentity, first);
  for (const source of [{ ...manual.source, sha256: 'b'.repeat(64) }, { ...manual.source, storage_path: `${hotel}/${assetId}/different.pdf` }, { ...manual.source, registered_file_id: 'another-registration' }, { ...manual.source, registered_updated_at: '2026-11-09T00:00:00Z' }]) assert.notEqual(derive(input, { ...manual, source }).contextIdentity, first);
});

test('checklist role gate uses exact Chief identity and PM capabilities, with assignment and property restrictions', () => {
  for (const role of ['Chief Engineer', 'System Administrator', 'Maintenance Technician']) assert.equal(policy.troubleshootingChecklistAccess(principal(role), originalTicket).canEdit, true, role);
  for (const role of ['engineer', 'Regional Engineer', 'General Manager', 'Front Desk', 'Lead Housekeeper']) assert.equal(policy.troubleshootingChecklistAccess(principal(role), originalTicket).canEdit, false, role);
  assert.equal(policy.troubleshootingChecklistAccess(principal(), { ...originalTicket, technician_name: 'Someone Else' }).canEdit, true);
  assert.equal(policy.troubleshootingChecklistAccess(principal(), { ...originalTicket, hotel_id: otherHotel }).canEdit, false);
  const denied = principal(); denied.permissions = [];
  assert.equal(policy.troubleshootingChecklistAccess(denied, originalTicket).canEdit, false);
});

test('technician saves durable PM state, chief reviews it, and another technician cannot change its ownership', async () => {
  const h = fixture(); const opened = await h.get();
  assert.equal(opened.status, 200); assert.equal(opened.body.revision, 0);
  assert.match(opened.headers.get('cache-control'), /no-store/);
  const contextKey = opened.body.contextKey;
  const checked = await h.patch({ contextKey, expectedRevision: 0, itemId: 'step-1' });
  assert.equal(checked.status, 200); assert.equal(checked.body.revision, 1);
  assert.deepEqual(checked.body.taskStates['step-1'], { status: 'needs', workerId, workerName: 'First Technician', workerChecked: true });
  assert.equal(taskReview.taskVisual(checked.body.taskStates['step-1'], checked.body.actor), 'approved');
  h.state.principal = principal('Maintenance Technician', secondId, 'Second Technician');
  assert.equal((await h.patch({ contextKey, expectedRevision: 1, itemId: 'step-1' })).status, 403);
  h.state.principal = principal('Chief Engineer', secondId, 'Chief Reviewer');
  const pending = await h.get(); assert.equal(taskReview.taskVisual(pending.body.taskStates['step-1'], pending.body.actor), 'needs');
  const approved = await h.patch({ contextKey, expectedRevision: 1, itemId: 'step-1' });
  assert.equal(approved.status, 200); assert.equal(approved.body.taskStates['step-1'].status, 'approved');
  assert.equal(approved.body.taskStates['step-1'].reviewedBy, 'Chief Reviewer');
  assert.equal((await h.get()).body.taskStates['step-1'].workerId, workerId, 'reopening retains completion ownership');
  assert.equal(h.state.ticket.revision, 7); assert.equal(h.state.ticket.status, 'In Progress');
});

test('managers and submission-only accounts can read but cannot save checklist marks or impersonate reviewers', async () => {
  for (const role of ['General Manager', 'engineer']) {
    const h = fixture({ principal: principal(role) }); const opened = await h.get();
    assert.equal(opened.status, 200); assert.equal(opened.body.canEdit, false);
    assert.equal((await h.patch({ contextKey: opened.body.contextKey, expectedRevision: 0, itemId: 'step-1' })).status, 403);
    assert.equal(h.state.writes.length, 0);
  }
  const frontDesk = fixture({ principal: principal('Front Desk') });
  assert.equal((await frontDesk.get()).body.contextKey, null, 'submission-only users do not receive equipment reference text');
  const knownContext = createHash('sha256').update(checklistDomain.deriveTroubleshootingChecklistContext({ issue: originalTicket.issue, reporter_notes: '', asset }, manual).contextIdentity).digest('hex');
  assert.equal((await frontDesk.patch({ contextKey: knownContext, expectedRevision: 0, itemId: 'step-1' })).status, 403, 'submission-only users cannot mark new completions');
  const h = fixture(); const opened = await h.get();
  for (const extra of [{ actor: { role: 'chief' } }, { taskStates: { 'step-1': { status: 'approved' } } }, { label: 'Unverified instruction' }]) assert.equal((await h.patch({ contextKey: opened.body.contextKey, expectedRevision: 0, itemId: 'step-1', ...extra })).status, 400);
  assert.equal((await h.patch({ contextKey: opened.body.contextKey, expectedRevision: 0, itemId: 'step-999' })).status, 400);
  assert.equal(h.state.writes.length, 0);
});

test('stable completion owner can clear an approved check in a new session after reassignment, closure and role changes', async () => {
  for (const action of ['clear', 'toggle']) for (const role of ['General Manager', 'Front Desk']) {
    const h = fixture(); const opened = await h.get(); const contextKey = opened.body.contextKey;
    await h.patch({contextKey, expectedRevision: 0, itemId: 'step-1'});
    h.state.principal = principal('Chief Engineer', secondId, 'Chief Reviewer');
    await h.patch({contextKey, expectedRevision: 1, itemId: 'step-1'});
    h.state.ticket = {...h.state.ticket, status: 'Closed', technician_name: 'New Assignee', created_by: secondId, revision: 8};
    h.state.principal = principal(role, workerId, 'Renamed Returning Worker');
    const reopened = await h.get();
    assert.equal(reopened.status, 200); assert.equal(reopened.body.canEdit, false);
    assert.equal(reopened.body.canClearOwn, true); assert.equal(reopened.body.canClearAll, false);
    if (role === 'Front Desk') { assert.equal(reopened.body.contextIdentity, null); assert.deepEqual(reopened.body.steps, [], 'lost guide-read access does not expose equipment instructions'); }
    const cleared = await h.patch({contextKey, expectedRevision: 2, itemId: 'step-1', action});
    assert.equal(cleared.status, 200, action);
    assert.deepEqual(cleared.body.taskStates['step-1'], {status: 'empty'});
    assert.equal(h.state.writes.at(-1).p_actor, workerId);
    assert.equal(h.state.ticket.revision, 8); assert.equal(h.state.ticket.status, 'Closed');
    assert.equal((await h.patch({contextKey, expectedRevision: 3, itemId: 'step-1'})).status, 403, 'manager cannot add a new check');
  }
});

test('Chief Engineer and System Administrator can clear any pending or approved check despite assignment/edit gates', async () => {
  for (const role of ['Chief Engineer', 'System Administrator']) for (const approved of [false, true]) {
    const h = fixture(); const opened = await h.get(); const contextKey = opened.body.contextKey;
    await h.patch({contextKey, expectedRevision: 0, itemId: 'step-1'});
    h.state.principal = principal(role, secondId, 'Authorized Reviewer');
    let expectedRevision = 1;
    if (approved) {
      assert.equal((await h.patch({contextKey, expectedRevision, itemId: 'step-1'})).body.taskStates['step-1'].status, 'approved');
      expectedRevision++;
    }
    h.state.principal.permissions = [];
    if (role === 'System Administrator') h.state.principal.membership.role = 'viewer';
    h.state.ticket = {...h.state.ticket, technician_name: 'Other Worker', status: 'Closed'};
    const reopened = await h.get(); assert.equal(reopened.body.canClearAll, true);
    if (role === 'System Administrator') assert.equal(reopened.body.canEdit, false, 'clearing remains allowed even when ordinary editing is not');
    const cleared = await h.patch({contextKey, expectedRevision, itemId: 'step-1', ...(approved ? {} : {action: 'clear'})});
    assert.equal(cleared.status, 200, `${role}/${approved}`);
    assert.deepEqual(cleared.body.taskStates['step-1'], {status: 'empty'});
  }
});

test('authorized technicians can clear a prior check while managers cannot and unsupported actions are rejected', async () => {
  const h = fixture(); const opened = await h.get(); const contextKey = opened.body.contextKey;
  await h.patch({contextKey, expectedRevision: 0, itemId: 'step-1'});
  h.state.principal = principal('General Manager', secondId, 'Manager');
  assert.equal((await h.patch({contextKey, expectedRevision: 1, itemId: 'step-1', action: 'clear'})).status, 403);
  h.state.principal = principal('Maintenance Technician', secondId, 'Another Technician');
  assert.equal((await h.patch({contextKey, expectedRevision: 1, itemId: 'step-1', action: 'clear'})).status, 200);
  assert.equal((await h.patch({contextKey, expectedRevision: 2, itemId: 'step-1', action: 'approve'})).status, 400);
  assert.equal(h.state.writes.length, 2);
  assert.deepEqual(h.state.ledger[0].task_states['step-1'], {status: 'empty'});
});

test('a different technician can start a separate checklist without erasing prior checks or notes', async () => {
  const h = fixture(); const first = await h.get();
  assert.equal((await h.patch({contextKey:first.body.contextKey, expectedRevision:0, itemId:'step-1'})).status, 200);
  await h.exit(); const oldNotes = h.state.ticket.notes;
  h.state.principal = principal('Maintenance Technician', secondId, 'Second Technician');
  const previous = await h.get();
  const result = await h.restart({action:'start_new',contextKey:previous.body.contextKey,expectedRevision:previous.body.revision});
  assert.equal(result.status,200);
  const fresh = await h.get();
  assert.notEqual(fresh.body.contextKey,first.body.contextKey); assert.deepEqual(fresh.body.taskStates,{});
  assert.equal(h.state.ledger[0].task_states['step-1'].workerId,workerId); assert.equal(h.state.ticket.notes,oldNotes);
});

test('other-property, inactive and unauthenticated accounts cannot load or mutate checklist state', async () => {
  const h = fixture({ ticket: { ...originalTicket, hotel_id: otherHotel } });
  assert.equal((await h.get()).status, 404); assert.equal(h.state.guideReads, 0);
  h.state.ticket = structuredClone(originalTicket); h.state.principal.membership.active = false;
  assert.equal((await h.get()).status, 403);
  h.state.authenticated = false; assert.equal((await h.get()).status, 401);
  assert.equal(h.state.writes.length, 0);
});

test('issue or manual context changes retain history and reject stale taps rather than transferring checkmarks', async () => {
  const h = fixture(); const first = await h.get();
  await h.patch({ contextKey: first.body.contextKey, expectedRevision: 0, itemId: 'step-1' });
  h.state.ticket.issue = 'Air conditioner not heating'; h.state.ticket.revision++;
  const changed = await h.get(); assert.notEqual(changed.body.contextKey, first.body.contextKey); assert.deepEqual(changed.body.taskStates, {});
  const stale = await h.patch({ contextKey: first.body.contextKey, expectedRevision: 1, itemId: 'step-1' });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'context_changed');
  assert.equal(h.state.ledger.length, 1); assert.equal(h.state.ledger[0].task_states['step-1'].workerId, workerId);
  h.state.ticket.issue = originalTicket.issue;
  assert.equal((await h.get()).body.taskStates['step-1'].workerId, workerId, 'prior context history remains available when exactly restored');
});

test('concurrent taps use compare-and-swap and reload merges independent checklist marks', async () => {
  const h = fixture(); const first = await h.get(); const contextKey = first.body.contextKey;
  const results = await Promise.all([h.patch({ contextKey, expectedRevision: 0, itemId: 'step-1' }), h.patch({ contextKey, expectedRevision: 0, itemId: 'step-2' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200,409]);
  assert.equal(h.state.writes.length, 1);
  const current = await h.get(); const missing = current.body.taskStates['step-1'] ? 'step-2' : 'step-1';
  const merged = await h.patch({ contextKey, expectedRevision: current.body.revision, itemId: missing });
  assert.equal(merged.status, 200); assert.equal(Object.keys(merged.body.taskStates).length, 2);
  assert.equal(h.state.ticket.revision, 7);
});

test('ticket or equipment changes during save are rejected atomically by the ledger RPC', async () => {
  for (const race of [state => { state.ticket.revision++; state.ticket.issue = 'A new issue'; }, state => { state.asset.documentation_key = 'changed-document'; }, state => { state.asset.serial_number = 'different-serial'; }]) {
    const h = fixture(); const opened = await h.get(); h.state.race = race;
    const response = await h.patch({ contextKey: opened.body.contextKey, expectedRevision: 0, itemId: 'step-1' });
    assert.equal(response.status, 409); assert.equal(response.body.code, 'context_changed');
    assert.equal(h.state.writes.length, 0); assert.equal(h.state.ledger.length, 0);
  }
});

test('a Chief cycles blank to red to green to blank and retains stable ownership across sessions', async () => {
  const h = fixture({ principal: principal('Chief Engineer') }); const opened = await h.get(); const contextKey = opened.body.contextKey;
  const checked = await h.patch({ contextKey, expectedRevision: 0, itemId: 'step-1' });
  assert.equal(checked.status, 200); assert.equal(checked.body.taskStates['step-1'].status, 'needs');
  assert.equal(checklistDomain.troubleshootingTaskVisual(checked.body.taskStates['step-1'], checked.body.canSeePendingReview), 'needs');
  assert.equal(checked.body.taskStates['step-1'].workerId, workerId); assert.equal(checked.body.taskStates['step-1'].workerChecked, true);
  const verified = await h.patch({ contextKey, expectedRevision: 1, itemId: 'step-1' });
  assert.equal(verified.body.taskStates['step-1'].status, 'approved');
  assert.equal(checklistDomain.troubleshootingTaskVisual(verified.body.taskStates['step-1'], verified.body.canSeePendingReview), 'approved');
  const blank = await h.patch({ contextKey, expectedRevision: 2, itemId: 'step-1' });
  assert.deepEqual(blank.body.taskStates['step-1'], { status: 'empty' });
  assert.equal(checklistDomain.troubleshootingTaskVisual(blank.body.taskStates['step-1'], blank.body.canSeePendingReview), 'empty');
  await h.patch({ contextKey, expectedRevision: 3, itemId: 'step-1' });
  await h.patch({ contextKey, expectedRevision: 4, itemId: 'step-1' });
  h.state.principal = principal('General Manager', workerId, 'Returning Chief'); h.state.ticket.status = 'Closed'; h.state.ticket.technician_name = 'Other Worker';
  const cleared = await h.patch({ contextKey, expectedRevision: 5, itemId: 'step-1', action: 'clear' });
  assert.equal(cleared.status, 200); assert.deepEqual(cleared.body.taskStates['step-1'], { status: 'empty' });
});

test('only actual Chief identities see pending red while other authorized viewers see completion green', () => {
  const pending = { status: 'needs', workerChecked: true, workerId };
  for (const role of ['Maintenance Technician', 'General Manager', 'System Administrator', 'engineer']) {
    const permissions = policy.troubleshootingChecklistAccess(principal(role), originalTicket);
    assert.equal(permissions.canSeePendingReview, false, role);
    assert.equal(checklistDomain.troubleshootingTaskVisual(pending, permissions.canSeePendingReview), 'approved', role);
  }
  const chief = policy.troubleshootingChecklistAccess(principal('Chief Engineer'), originalTicket);
  assert.equal(chief.canSeePendingReview, true);
  assert.equal(checklistDomain.troubleshootingTaskVisual(pending, chief.canSeePendingReview), 'needs');
});

test('a newly attached preferred PDF starts a new checklist context without transferring old completions', async () => {
  const h = fixture(); const originalContext = (await h.get()).body.contextKey;
  await h.patch({ contextKey: originalContext, expectedRevision: 0, itemId: 'step-1' });
  h.state.manual.source = { ...h.state.manual.source, source_file_name: 'Later attached service manual.pdf', storage_path: `${hotel}/${assetId}/later-source.pdf`, registered_file_id: 'later-file-registration', registered_updated_at: '2030-01-02T03:04:05Z', sha256: 'c'.repeat(64) };
  h.state.asset.pdf_import_links = [{ object_id: 'later-file-registration', storage_path: h.state.manual.source.storage_path, preferred: true, sha256: h.state.manual.source.sha256 }];
  const replaced = await h.get();
  assert.notEqual(replaced.body.contextKey, originalContext); assert.equal(replaced.body.revision, 0); assert.deepEqual(replaced.body.taskStates, {});
  const stale = await h.patch({ contextKey: originalContext, expectedRevision: 1, itemId: 'step-1' });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'context_changed');
  assert.equal(h.state.ledger[0].task_states['step-1'].workerId, workerId, 'the earlier context remains retained rather than copied');
  assert.equal(h.state.providerCalls, 0);
});

test('every checkbox change is journaled immediately and combined into one exit note even when the final state is unchecked', async () => {
  const h = fixture(); const contextKey = (await h.get()).body.contextKey;
  await h.patch({ contextKey, expectedRevision: 0, itemId: 'step-1' });
  await h.patch({ contextKey, expectedRevision: 1, itemId: 'step-1', action: 'clear' });
  assert.equal(h.state.ticket.notes, originalTicket.notes, 'individual changes do not append notes');
  assert.equal(h.state.ticket.revision, 7); assert.equal(h.state.events.length, 2);
  assert.equal(h.state.events[0].step_label, 'Inspect the filter.');
  assert.equal(h.state.events[0].source.sha256, manual.source.sha256); assert.deepEqual(h.state.events[0].source.source_pages, [12]);
  assert.equal(JSON.stringify(h.state.events[0].source).includes('token='), false, 'journal provenance excludes rotating access URLs');
  const result = await h.exit(); assert.equal(result.status, 200); assert.equal(result.body.eventCount, 2); assert.equal(result.body.alreadyFinalized, false);
  assert.match(h.state.ticket.notes, /Checked: Inspect the filter\..*Cleared: Inspect the filter\./);
  assert.equal(h.state.ticket.notes.split('\n').filter(line => line.startsWith('CMPRI2|')).length, 1);
  assert.equal(h.state.ticket.revision, 8);
  const duplicate = await h.exit(); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.alreadyFinalized, true);
  assert.equal(h.state.ticket.notes.split('\n').filter(line => line.startsWith('CMPRI2|')).length, 1); assert.equal(h.state.ticket.revision, 8);
});

test('same mutation IDs recover lost responses without duplicate changes while altered retries are refused', async () => {
  const h = fixture(); const contextKey = (await h.get()).body.contextKey;
  const body = { contextKey, expectedRevision: 0, itemId: 'step-1', visitId: h.uuid(), mutationId: h.uuid() };
  const saved = await h.patch(body); assert.equal(saved.status, 200);
  const retried = await h.patch(body); assert.equal(retried.status, 200); assert.equal(retried.body.replayed, true);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.events.length, 1);
  const altered = await h.patch({ ...body, itemId: 'step-2' }); assert.equal(altered.status, 409); assert.equal(altered.body.code, 'mutation_changed');
  assert.equal(h.state.writes.length, 1);
});

test('pending visits survive failed exit and are recovered only by their owning account across sessions', async () => {
  const h = fixture(); const contextKey = (await h.get()).body.contextKey;
  await h.patch({ contextKey, expectedRevision: 0, itemId: 'step-1' });
  const pending = (await h.get()).body.pendingVisits; assert.equal(pending.length, 1); assert.equal(pending[0].eventCount, 1);
  h.state.failFinalize = true; assert.equal((await h.exit({ visitId: pending[0].visitId })).status, 503); assert.equal(h.state.ticket.notes, originalTicket.notes);
  h.state.principal = principal('Chief Engineer', secondId, 'Other Account');
  assert.deepEqual((await h.get()).body.pendingVisits, []); assert.equal((await h.exit({ visitId: pending[0].visitId })).status, 403);
  h.state.principal = principal('General Manager', workerId, 'Returning Worker'); h.state.failFinalize = false;
  assert.equal((await h.get()).body.pendingVisits[0].visitId, pending[0].visitId);
  const saved = await h.exit({ visitId: pending[0].visitId }); assert.equal(saved.status, 200); assert.equal(saved.body.eventCount, 1);
  assert.deepEqual((await h.get()).body.pendingVisits, []);
});

test('an exit with no actions closes that visit so a delayed first checkbox change cannot escape its note', async () => {
  const h = fixture(); const contextKey = (await h.get()).body.contextKey;
  const closed = await h.exit(); assert.equal(closed.status, 200); assert.equal(closed.body.eventCount, 0);
  assert.equal((await h.patch({ contextKey, expectedRevision: 0, itemId: 'step-1' })).status, 409);
  assert.equal(h.state.writes.length, 0); assert.equal(h.state.ticket.notes, originalTicket.notes); assert.equal(h.state.ticket.revision, 7);
});

test('a post-save read failure preserves the event and a same-ID retry confirms it safely', async () => {
  const h = fixture(); const contextKey = (await h.get()).body.contextKey;
  const body = { contextKey, expectedRevision: 0, itemId: 'step-1', visitId: h.uuid(), mutationId: h.uuid() };
  h.state.failPendingAfterSave = true;
  const uncertain = await h.patch(body); assert.equal(uncertain.status, 503); assert.equal(uncertain.body.mutationSaved, true); assert.equal(h.state.events.length, 1);
  h.state.failPendingAfterSave = false; h.state.pendingReadFailure = false;
  const replay = await h.patch(body); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(h.state.events.length, 1);
});

test('strict guide GET, checkbox PATCH and combined exit note use zero AI/provider/outbound fetch calls', async () => {
  const h = fixture(); const guide = await h.get(); assert.equal(guide.status, 200);
  assert.equal((await h.patch({ contextKey: guide.body.contextKey, expectedRevision: 0, itemId: 'step-1' })).status, 200);
  assert.equal((await h.exit()).status, 200);
  assert.equal(h.state.providerCalls, 0);
  assert.equal((await h.exit({ visitId: h.uuid(), note: 'Forged note content' })).status, 400);
});

test('source illustrations attach only to their exact step and page and participate in guide context', () => {
  const media = { id: `media-${'c'.repeat(64)}`, stepLabel: 'Inspect the filter.', sourcePage: 12, caption: 'Figure 1. Filter location', width: 600, height: 400 };
  const withMedia = knowledge.normalizeManualKnowledge({ ...manual, step_media: [media,
    { ...media, id: `media-${'d'.repeat(64)}`, sourcePage: 20 },
    { ...media, id: `media-${'e'.repeat(64)}`, stepLabel: 'Inspect the heating element.', sourcePage: 20 },
    { ...media, id: 'https://external.example/image.png' },
    { ...media, id: `media-${'f'.repeat(64)}`, width: 10_000, height: 10_000 },
  ] });
  const input = { issue: 'Air conditioner not cooling', asset };
  const context = checklistDomain.deriveTroubleshootingChecklistContext(input, withMedia);
  assert.deepEqual(context.steps[0].media, [media]);
  assert.equal(context.steps[1].media, undefined);
  assert.equal(withMedia.step_media.length, 3, 'normalization rejects external image URLs and unbounded images');
  assert.notEqual(context.contextIdentity, checklistDomain.deriveTroubleshootingChecklistContext(input, manual).contextIdentity);
  const heating = checklistDomain.deriveTroubleshootingChecklistContext({ ...input, issue: "It won't get hot" }, withMedia);
  assert.equal(heating.steps.length, 1); assert.equal(heating.steps[0].media[0].id, `media-${'e'.repeat(64)}`);
  assert.ok(!heating.steps[0].media.some(item => item.id === media.id), 'a different issue cannot retain the cooling diagram');
});


test('identical steps in two manuals journal the selected step document rather than the primary source', async () => {
  const h = fixture();
  const first = { ...h.state.manual.source };
  const second = { ...first, registered_file_id: 'second-upload', storage_path: `${hotel}/${assetId}/second.pdf`, sha256: 'b'.repeat(64), source_file_name: 'Second.pdf' };
  h.state.manual.sources = [first, second];
  h.state.manual.symptom_rules = [first, second].map(source => ({ match: ['not cooling'], steps: ['Inspect the filter.'], source_pages: [12], source_document_id: source.registered_file_id, source_sha256: source.sha256 }));
  const response = await h.get();
  assert.equal(response.body.steps.length, 2);
  const selected = response.body.steps.find(step => step.source_document_id === second.registered_file_id);
  const saved = await h.patch({ contextKey: response.body.contextKey, expectedRevision: 0, itemId: selected.id });
  assert.equal(saved.status, 200);
  assert.equal(h.state.events[0].source.registered_file_id, second.registered_file_id);
  assert.equal(h.state.events[0].source.sha256, second.sha256);
  assert.equal(h.state.events[0].source.storage_path, second.storage_path);
  assert.deepEqual(h.state.events[0].source.source_pages, [12]);
});
