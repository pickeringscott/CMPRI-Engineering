import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadTs} from './helpers/load-ts.mjs';

const page = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('Obtain a server timestamp')) effect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
function timerFixture(overrides = {}) {
  let now = 0, saves = 0, puts = 0, next = 0;
  const timers = new Map();
  const context = {
    createHasUnsavedChanges: true, locationId: 'room', issue: 'Leak', loading: false,
    draftBusy: false, createState: 'idle', mainWorkOrderCreated: false, pendingPhotoUploads: [],
    activeDraftId: '', pendingDraftSave: {current: null}, currentDraftKey: 'fields', lastSavedDraftKey: '',
    draftIdleReceipt: {current: ''}, draftFields: {location_id: 'room', issue: 'Leak'},
    getValidSession: async () => ({access_token: 'token'}),
    fetch: async () => { puts++; return {ok: true, json: async () => ({inactivity_receipt: 'signed'})}; },
    saveDraft: () => { saves++; },
    window: {setTimeout(fn, delay) {const id = ++next; timers.set(id, {fn, at: now + delay}); return id;}, clearTimeout(id) {timers.delete(id);}},
    ...overrides,
  };
  vm.createContext(context);
  const run = () => vm.runInContext(ts.transpileModule(`(${effect})()`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  return {context, run, counts: () => ({saves, puts}), advance(ms) {now += ms; for (const [id, timer] of timers) if (timer.at <= now) {timers.delete(id); timer.fn();}}};
}
const flush = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};

test('inactivity saves only at 30 minutes and every edit restarts the clock', async () => {
  assert.ok(effect);
  const f = timerFixture();
  const cleanup = f.run(); await flush();
  f.advance(29 * 60 * 1000);
  assert.equal(f.counts().saves, 0);
  cleanup();
  f.context.issue = 'Edited leak';
  const cleanupEdit = f.run(); await flush();
  f.advance(29 * 60 * 1000);
  assert.equal(f.counts().saves, 0);
  f.advance(60 * 1000);
  assert.equal(f.counts().saves, 1);
  cleanupEdit();
});

test('blank, submitted, submitting, attachment-retry, and unchanged restored forms never start draft creation', async () => {
  for (const overrides of [{issue: ''}, {locationId: ''}, {createState: 'created'}, {createState: 'creating'}, {mainWorkOrderCreated: true}, {pendingPhotoUploads: [{}]}, {loading: true}, {activeDraftId: 'saved', lastSavedDraftKey: 'fields'}]) {
    const f = timerFixture(overrides); f.run(); await flush(); f.advance(31 * 60 * 1000);
    assert.deepEqual(f.counts(), {saves: 0, puts: 0});
  }
});

test('cancelled timers ignore a late server response', async () => {
  let resolve;
  const f = timerFixture({fetch: () => new Promise(done => {resolve = done;})});
  const cleanup = f.run(); await flush(); cleanup();
  resolve({ok: true, json: async () => ({inactivity_receipt: 'late'})}); await flush();
  f.advance(31 * 60 * 1000);
  assert.equal(f.counts().saves, 0);
  assert.equal(f.context.draftIdleReceipt.current, '');
});

function inboxFixture(isEngineer) {
  const drafts = [{id: 'draft-id', room: '101', issue: 'Leak', revision: 1, updated_at: '2026-11-16T10:00:00Z', hotel_id: 'hotel'}];
  const inbox = [];
  const admin = {from(table) {
    const filters = []; let insert, update;
    const q = {
      select() {return q;}, eq(k, v) {filters.push(row => row[k] === v); return q;},
      is(k, v) {filters.push(row => (row[k] ?? null) === v); return q;},
      in(k, values) {filters.push(row => values.includes(row[k])); return q;},
      like(k, value) {filters.push(row => row[k].startsWith(value.slice(0, -1))); return q;},
      not() {return q;}, order() {return q;}, limit() {return q;},
      upsert(rows) {insert = rows; return q;}, update(value) {update = value; return q;},
      then(resolve) {
        const rows = table === 'cmpri_work_order_drafts' ? drafts : inbox;
        if (insert) for (const row of insert) if (!inbox.some(existing => existing.notification_key === row.notification_key)) inbox.push(row);
        const matched = rows.filter(row => filters.every(filter => filter(row)));
        if (update) matched.forEach(row => Object.assign(row, update));
        resolve({data: insert || matched, error: null});
      },
    }; return q;
  }};
  const route = loadTs('src/app/api/dashboard/notifications/route.ts', {
    'next/server': {NextResponse: {json: (body, options) => ({body, status: options?.status || 200})}},
    '@/lib/constants': {HOTEL_ID: 'hotel'},
    '@/lib/server/auth': {requireUser: async () => ({admin, principal: {identity: {id: 'actor'}, profile: {role: isEngineer ? 'Chief Engineer' : 'Maintenance Technician'}}})},
    '@/lib/server/roles': {profileIsChiefEngineerOrSystemAdmin: () => isEngineer, profileHasRole: () => !isEngineer, receivesWorkOrderNotifications: () => true},
    '@/lib/notifications/web-push': {dispatchWebPushNotifications: async () => {}},
    '@/lib/notifications/event-eligibility': {receivesEventPush: () => false},
    '@/lib/dashboard/work-order-notifications': {unrecordedDashboardNotifications: (candidates, keys) => candidates.filter(row => !keys.includes(row.id))},
  });
  return {drafts, inbox, get: () => route.GET({})};
}

test('engineering receives one Draft notification per saved revision and submission clears it', async () => {
  const f = inboxFixture(true);
  let response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.body.notifications.length, 1);
  assert.match(response.body.notifications[0].message, /Draft — awaiting approval: 101 — Leak/);
  assert.equal(response.body.notifications[0].target_path, '/work-orders?draftId=draft-id&reviewDraft=1');
  await f.get(); assert.equal(f.inbox.length, 1);
  f.drafts[0].revision++;
  response = await f.get(); assert.equal(response.body.notifications.length, 1);
  assert.ok(f.inbox[0].cleared_at);
  f.drafts.splice(0);
  response = await f.get(); assert.equal(response.body.notifications.length, 0);
  assert.equal((await inboxFixture(false).get()).body.notifications.length, 0);
});

test('manual and AI creation paths are absent and photos participate in timer resets', () => {
  assert.doesNotMatch(page, /onClick=\{\(\) => void saveDraft\(/);
  const writes = readFileSync(new URL('../src/lib/server/cmpri-mcp-writes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(writes, /work_order_drafts\.create/);
  assert.match(page, /staffFirstName, photos, loading, draftBusy/);
  assert.match(page, /Draft — awaiting approval/);
});


test('starting an inactivity clock does not invalidate work-order lists', () => {
  const {mutationTopics} = loadTs('src/lib/data-cache/policy.ts');
  assert.equal(mutationTopics('/api/work-orders/drafts', 'PUT').length, 0);
  assert.ok(mutationTopics('/api/work-orders/drafts', 'POST').includes('orders'));
  assert.ok(mutationTopics('/api/work-orders/drafts', 'PATCH').includes('orders'));
});
