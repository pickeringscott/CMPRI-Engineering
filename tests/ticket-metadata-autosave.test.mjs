import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createTicketWriteQueue } from '../src/lib/work-orders/write-queue.ts';

const source = readFileSync('src/app/work-orders/[id]/page.tsx', 'utf8');
const ast = ts.createSourceFile('ticket.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let method = '';
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'saveMetadataSelection') method = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(method);
const code = ts.transpileModule(`${method}\nexports.save = saveMetadataSelection;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const row = { id: 'ticket', revision: 1, asset_id: null, category: 'General', priority: 'Medium', technician_name: '', status: 'Open', due_by: null, issue: 'Issue' };
  const fields = { asset_id: '', category: 'General', priority: 'Medium', technician_name: '', status: 'Open', due_by: '' };
  let server = { ...row }, release, hold = false, fail = false, changeServer = () => {};
  const requests = [], messages = [], posts = [];
  const fingerprint = { assetId: '', category: 'General', priority: 'Medium', technicianName: '', status: 'Open', dueBy: '', issue: 'Unrelated draft baseline' };
  const ctx = { exports: {}, order: row, orderRef: { current: row }, ticketReady: true, canEditField: () => true,
    metadataSelectionVersion: { current: {} }, metadataSaveCount: { current: 0 }, assetSelectionChanged: { current: false },
    ticketWrites: { current: createTicketWriteQueue() }, assets: [{ id: 'asset', category: 'HVAC' }], cmpriSession: { user: { role: 'Chief Engineer' } },
    categoryForAsset: asset => asset.category, priorityForCategory: () => 'High', roleKey: s => s.toLowerCase().replaceAll(' ', '_'),
    setManualResult: () => {}, setMetadataSaving: value => ctx.saving = value, setMessage: value => messages.push(value),
    setOrder: value => ctx.orderRef.current = value, setInitialFingerprint: update => ctx.fingerprint = update(ctx.fingerprint),
    fingerprint: JSON.stringify(fingerprint), getValidSession: async () => ({ access_token: 'token' }),
    embedded: true, modalToken: 'nonce', window: { location: { origin: 'https://test.example' }, parent: { postMessage: value => posts.push(value) } },
    workOrderListSnapshot: value => value,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (hold) { hold = false; await new Promise(resolve => release = resolve); }
      if (fail) throw Error('connection lost');
      assert.equal(body.expected_revision, server.revision);
      const { expected_revision, ...update } = body;
      server = { ...server, ...update, revision: server.revision + 1 };
      changeServer(server);
      return { ok: true, json: async () => ({ workOrder: { ...server } }) };
    },
  };
  for (const [key, setter] of Object.entries({ asset_id: 'setAssetId', category: 'setCategory', priority: 'setPriority', technician_name: 'setTechnicianName', status: 'setStatus', due_by: 'setDueBy' })) {
    ctx[setter] = next => { fields[key] = typeof next === 'function' ? next(fields[key]) : next; };
  }
  vm.runInNewContext(code, ctx);
  return { ctx, fields, requests, messages, posts, save: ctx.exports.save, hold: () => hold = true, release: () => release(), fail: value => fail = value, changeServer: fn => changeServer = fn, server: () => server };
}

test('rapid selections save in order, including returning to the original value, without closing', async () => {
  const f = fixture(); f.hold();
  const a = f.save('status', 'Closed'); await tick();
  const b = f.save('status', 'In Progress');
  const c = f.save('status', 'Open');
  f.release(); await Promise.all([a, b, c]);
  assert.deepEqual(f.requests.map(x => [x.expected_revision, x.status]), [[1, 'Closed'], [2, 'In Progress'], [3, 'Open']]);
  assert.equal(f.fields.status, 'Open'); assert.equal(f.server().status, 'Open');
  assert.equal(f.posts.length, 3); assert.ok(f.posts.every(x => x.type === 'cmpri-work-order-loaded'));
  assert.equal(JSON.parse(f.ctx.fingerprint).issue, 'Unrelated draft baseline');
  assert.equal(f.ctx.metadataSaveCount.current, 0);
});

test('equipment selection saves inferred fields together and leaves unrelated draft fields intact', async () => {
  const f = fixture(); await f.save('asset_id', 'asset');
  assert.deepEqual(f.requests[0], { expected_revision: 1, asset_id: 'asset', category: 'HVAC', priority: 'High' });
  assert.equal(f.fields.category, 'HVAC'); assert.equal(JSON.parse(f.ctx.fingerprint).issue, 'Unrelated draft baseline');
});

test('failure retains the selected draft, confirmed revision, and an actionable error', async () => {
  const f = fixture(); f.fail(true); await f.save('priority', 'High');
  assert.equal(f.fields.priority, 'High'); assert.equal(f.ctx.orderRef.current.revision, 1);
  assert.equal(JSON.parse(f.ctx.fingerprint).priority, 'Medium');
  assert.match(f.messages.at(-1), /retained.*Save Changes/); assert.equal(f.posts.length, 0);
});

test('server dependent changes are reflected without overwriting a newer user selection', async () => {
  const f = fixture(); f.hold();
  let first = true;
  f.changeServer(row => { if (first) { row.priority = 'Urgent'; first = false; } });
  const a = f.save('status', 'Closed'); await tick();
  const b = f.save('priority', 'Low'); f.release(); await Promise.all([a, b]);
  assert.equal(f.fields.priority, 'Low'); assert.equal(f.server().priority, 'Low');
  assert.equal(f.requests[1].expected_revision, 2);
});
