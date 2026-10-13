import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';

// Execute the real route and its pure dependencies, with a query-aware in-memory DB.
const cache = new Map();
function load(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, console, require(name) {
    if (name in mocks) return mocks[name];
    const resolved = name.startsWith('@/') ? path.resolve('src', name.slice(2) + '.ts') : path.resolve(path.dirname(file), name + '.ts');
    if (!cache.has(resolved)) cache.set(resolved, load(resolved));
    return cache.get(resolved);
  } });
  return exports;
}
const hotel = 'test-hotel';
const pool = 'cb55f308-8393-435f-8866-f10ab8892e9c';
const guest = '19b0680d-eaf8-4b7b-ae0f-b05713210450';
const hall = '67432cbc-40f7-4740-b4c0-2d3a618c884b';
const room127 = 'f397b974-cbbc-43da-b255-0177c3517ea3';
const supplies = '25489914-f3ce-42cb-bf56-f912ac2ab77a';
const bowl = '1fd015c4-79d5-4f56-b0e2-0c609b133e5f';
const fridge = '00000000-0000-0000-0000-000000000001';
const actor = '00000000-0000-0000-0000-000000000099';
// Only source facts provided for this task; these are regression fixtures, not import payloads.
const fixtures = [
  ['IMP-0003|CUR-003|AC-6282', pool, 'Pool Room Door #1 Battery Plate', 'Doors/Locks', 'Low'],
  ['IMP-0005|CUR-005|AC-8478', pool, 'Repair scuffed paint on pool door', 'General', 'Medium'],
  ['IMP-0060|CUR-063|WO-2026-0957', guest, 'Fridge making loud noises', 'Appliances', 'Medium'],
  ['IMP-0061|CUR-064|AC-7211', guest, 'Reading Light Out', 'Electrical', 'Low'],
  ['IMP-0082|CUR-086|AC-3697', room127, 'Replace missing kitchen utensils in 127', 'General', 'High'],
  ['IMP-0083|CUR-087|AC-3696', room127, 'Replace missing mixing bowl in 127', 'General', 'Medium'],
].map(([ids, location_id, issue, category, priority], i) => ({
  external_id: `CMPRI-final-20260915-${ids.split('|')[0]}`, location_id, issue, category, priority,
  status: 'Open', asset_id: null,
  notes: `  Source provenance: ${ids}${i === 1 ? '; original category: Finishes' : ''}\nFixture note with spacing preserved.  `,
}));
const comparators = [
  { id: supplies, display_id: '#076', location_id: room127, issue: 'Replace missing kitchen supplies in 127', import_external_id: 'CMPRI-final-20260915-IMP-0081', notes: 'AC-3698' },
  { id: bowl, display_id: '#074', location_id: room127, issue: 'Replace missing cereal bowl in 127', import_external_id: 'CMPRI-final-20260915-IMP-0079', notes: 'AC-3694' },
].map(row => ({ ...row, hotel_id: hotel, status: 'Open', asset_id: null, import_source: 'Spreadsheet' }));
function fixture(options = {}) {
  const db = {
    locations: [[pool, 'Pool Area', null], [guest, 'Guest Room 112', '112'], [hall, 'Hall 112', '112'], [room127, 'Room 127', '127']].map(([id, name, room_number]) => ({ id, name, room_number, active: true, hotel_id: hotel })),
    assets: [{ id: fridge, name: 'Refrigerator', asset_type: 'Appliances', location_id: guest, active: true, hotel_id: hotel }],
    work_orders: structuredClone(options.existing ?? []),
  };
  const writes = [], reads = [];
  const admin = { from(table) {
    const filters = [];
    let insert;
    const query = {
      select() { return query; }, eq(key, value) { filters.push([key, value]); return query; }, order() { return query; }, limit() { return query; },
      insert(rows) { writes.push(structuredClone(rows)); insert = rows; return query; },
      then(resolve, reject) {
        if (insert) {
          const saved = insert.map((row, i) => ({ ...row, id: `saved-${db.work_orders.length + i}` }));
          db.work_orders.push(...saved);
          return Promise.resolve({ data: saved, error: null }).then(resolve, reject);
        }
        reads.push({ table, filters });
        return Promise.resolve({ data: db[table].filter(row => filters.every(([key, value]) => row[key] === value)), error: options.readError ? { message: 'unavailable' } : null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const route = load(path.resolve('src/app/api/work-orders/import/route.ts'), {
    'next/server': { NextResponse: { json: (body, init) => ({ body: JSON.parse(JSON.stringify(body)), status: init?.status ?? 200 }) } },
    '@/lib/constants': { HOTEL_ID: hotel },
    '@/lib/server/auth': { requireCapability: async (_request, capability) => {
      assert.equal(capability, 'edit_tickets');
      return options.denied ? null : { admin, principal: { identity: { id: actor }, profile: { full_name: 'Reviewer' } } };
    } },
  });
  return { db, reads, writes, run: (rows, extra = {}) => route.POST({ json: async () => ({ source: 'Spreadsheet', rows, ...extra }) }) };
}
const review = (row, id, reason) => ({ ...row, reviewed_keep_separate: { candidate_ids: [id], reason } });
const reviewed = () => fixtures.map((row, i) => i === 4 ? review(row, supplies, 'AC-3697 utensils are distinct from AC-3698 kitchen supplies.') : i === 5 ? review(row, bowl, 'AC-3696 mixing bowl is distinct from AC-3694 cereal bowl.') : row);

test('six source-approved fixtures preserve fields, explicit null and full provenance in preview and save', async () => {
  // Validate each against its reviewed persisted comparator; no blanket batch waiver.
  for (const [i, input] of reviewed().entries()) {
    const f = fixture({ existing: comparators });
    const before = structuredClone(f.db);
    const preview = await f.run([input], { validate_only: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.would_import, 1, JSON.stringify(preview.body));
    assert.equal(preview.body.imported, 0);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.db, before);
    const row = preview.body.rows[0];
    for (const field of ['issue', 'category', 'priority', 'status', 'location_id', 'asset_id']) assert.equal(row[field], fixtures[i][field]);
    assert.ok(row.notes.startsWith(fixtures[i].notes));
    assert.equal(row.import_external_id, fixtures[i].external_id);
    assert.equal(row.import_source, 'Spreadsheet');
    assert.equal(row.imported_by_user_id, actor);
    assert.notEqual(row.location_id, hall);
    if (i >= 4) {
      const audit = JSON.parse(row.notes.split('[CMPRI import keep-separate review] ')[1]);
      assert.equal(audit.actor_user_id, actor);
      assert.equal(audit.actor_name, 'Reviewer');
      assert.ok(Number.isFinite(Date.parse(audit.reviewed_at)));
      assert.deepEqual(audit.candidate_ids, input.reviewed_keep_separate.candidate_ids);
      assert.equal(audit.reason, input.reviewed_keep_separate.reason);
    } else assert.equal(row.notes, fixtures[i].notes);
    const saved = await f.run([input]);
    assert.equal(saved.body.imported, 1);
    assert.equal(f.writes.length, 1);
    const inserted = f.writes[0][0];
    for (const field of ['issue', 'category', 'priority', 'status', 'location_id', 'asset_id', 'import_source', 'import_external_id']) assert.equal(inserted[field], row[field]);
    assert.ok(inserted.notes.startsWith(fixtures[i].notes));
    assert.deepEqual(f.db.work_orders.slice(0, 2), before.work_orders);
    const retry = await f.run([input]);
    assert.equal(retry.body.imported, 0);
    assert.equal(retry.body.skipped.length, 1);
    assert.equal(f.writes.length, 1);
  }
});

test('Pool Area fuzzy collision remains blocked without a persisted UUID review', async () => {
  const f = fixture({ existing: comparators });
  const result = await f.run(reviewed(), { validate_only: true });
  assert.equal(result.body.would_import, 5);
  assert.equal(result.body.skipped[0].row, 2);
  assert.match(result.body.skipped[0].reason, /Likely duplicate/);
  assert.equal(f.writes.length, 0);
});

test('ambiguous 112 is rejected without UUID; exact guest UUID overrides text', async () => {
  const f = fixture();
  const { location_id, ...row } = fixtures[2];
  assert.match((await f.run([{ ...row, location: '112' }])).body.error, /ambiguous/);
  assert.equal(f.writes.length, 0);
  const result = await f.run([{ ...row, location: '112', location_id }], { validate_only: true });
  assert.equal(result.body.rows[0].location_id, guest);
});

test('asset tri-state: omitted inference, null remains null, valid exact-location UUID selected', async () => {
  const f = fixture();
  const { asset_id, ...row } = fixtures[2];
  for (const [input, expected] of [[row, fridge], [{ ...row, asset_id }, null], [{ ...row, asset_id: fridge.toUpperCase() }, fridge]]) {
    const result = await f.run([input], { validate_only: true });
    assert.equal(result.body.rows[0].asset_id, expected);
  }
  assert.equal(f.writes.length, 0);
});

test('UUIDs fail closed for malformed, null location, inactive, other tenant and wrong-location equipment', async () => {
  for (const field of ['location_id', 'asset_id']) {
    for (const value of ['bad', '', 42, undefined, ...(field === 'location_id' ? [null] : [])]) {
      const f = fixture();
      assert.equal((await f.run([{ ...fixtures[2], [field]: value }])).status, 400);
      assert.equal(f.writes.length, 0);
    }
    for (const alteration of [{ active: false }, { hotel_id: 'other-hotel' }, ...(field === 'asset_id' ? [{ location_id: hall }] : [])]) {
      const f = fixture();
      Object.assign(f.db[field === 'asset_id' ? 'assets' : 'locations'].find(row => row.id === (field === 'asset_id' ? fridge : guest)), alteration);
      assert.equal((await f.run([{ ...fixtures[2], [field]: field === 'asset_id' ? fridge : guest }])).status, 400);
      assert.equal(f.writes.length, 0);
    }
  }
});

test('unreviewed duplicates remain blocked; only named fuzzy candidate can be waived', async () => {
  const f = fixture({ existing: comparators });
  const result = await f.run(fixtures.slice(4), { validate_only: true });
  assert.equal(result.body.would_import, 0);
  assert.equal(result.body.skipped.length, 2);
  const second = { ...comparators[0], id: '00000000-0000-0000-0000-000000000002' };
  f.db.work_orders.push(second);
  const partial = await f.run([reviewed()[4]], { validate_only: true });
  assert.equal(partial.body.would_import, 0);
  assert.equal(partial.body.skipped[0].existing_work_order_id, second.id);
  assert.equal(f.writes.length, 0);
});

test('review cannot bypass exact source identity or same-batch identity', async () => {
  const f = fixture({ existing: [{ ...comparators[0], import_external_id: fixtures[4].external_id }] });
  assert.equal((await f.run([reviewed()[4]])).body.imported, 0);
  assert.equal(f.writes.length, 0);
  const g = fixture();
  const result = await g.run([fixtures[0], { ...fixtures[2], external_id: fixtures[0].external_id }]);
  assert.equal(result.body.imported, 1);
  assert.equal(result.body.skipped.length, 1);
});

test('invalid and forged reviews, malformed preview flags, and lookup failure cause zero writes', async () => {
  for (const review of [null, true, { candidate_ids: [supplies], reason: '' }, { candidate_ids: ['bad'], reason: 'x' }, { candidate_ids: [bowl], reason: 'x' }, { candidate_ids: [supplies, supplies], reason: 'x' }, { candidate_ids: [supplies], reason: 'x', actor_user_id: actor }]) {
    const f = fixture({ existing: comparators });
    assert.equal((await f.run([{ ...fixtures[4], reviewed_keep_separate: review }], { validate_only: true })).status, 400);
    assert.equal(f.writes.length, 0);
  }
  for (const flag of ['true', 'false', null, 1]) {
    const f = fixture();
    assert.equal((await f.run(fixtures, { validate_only: flag })).status, 400);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ readError: true });
  assert.equal((await f.run(fixtures, { validate_only: true })).status, 503);
  assert.equal(f.writes.length, 0);
});

test('permission denial precedes data reads and all successful reads are tenant scoped', async () => {
  const f = fixture({ denied: true });
  assert.equal((await f.run(fixtures, { validate_only: true })).status, 403);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  const g = fixture();
  await g.run(fixtures, { validate_only: true });
  assert.equal(g.reads.length, 3);
  for (const read of g.reads) assert.ok(read.filters.some(([key, value]) => key === 'hotel_id' && value === hotel));
});

test('both reviewed Room 127 items stay distinct without changing existing tickets', async () => {
  const f = fixture({ existing: comparators });
  const before = structuredClone(f.db.work_orders);
  const result = await f.run(reviewed().slice(4), { validate_only: true });
  assert.equal(result.body.would_import, 2);
  assert.deepEqual(result.body.rows.map(row => row.issue), fixtures.slice(4).map(row => row.issue));
  assert.deepEqual(f.db.work_orders, before);
  assert.equal(f.writes.length, 0);
});

test('unique string matching still works; a late invalid row aborts the entire batch', async () => {
  const f = fixture();
  const { location_id, ...row } = fixtures[4];
  const preview = await f.run([{ ...row, location: 'Room 127' }], { validate_only: true });
  assert.equal(preview.body.rows[0].location_id, location_id);
  const invalid = await f.run([fixtures[0], { ...fixtures[2], asset_id: 'bad' }]);
  assert.equal(invalid.status, 400);
  assert.equal(f.writes.length, 0);
});

test('force cannot waive fuzzy candidates or allow cross-tenant reviews', async () => {
  const f = fixture({ existing: comparators });
  const result = await f.run([{ ...fixtures[4], force: true }], { force: true, validate_only: true });
  assert.equal(result.body.would_import, 0);
  f.db.work_orders[0].hotel_id = 'other-hotel';
  assert.equal((await f.run([reviewed()[4]], { validate_only: true })).status, 400);
  assert.equal(f.writes.length, 0);
});
