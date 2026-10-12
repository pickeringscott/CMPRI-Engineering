import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedVisibleRows, matchesVisibleRows } from './rls-expectations.mjs';
const hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
const rows = Array.from({ length: 28 }, (_, index) => ({ id: String(index), hotel_id, status: index < 20 ? 'Open' : 'Pending Verification' }));
test('manager fixtures see 20 Open rows and exclude eight pending rows', () => {
  for (const role of ['manager', 'assistant_manager', 'front_desk_manager']) {
    const expected = expectedVisibleRows(role, rows);
    assert.equal(expected.length, 20);
    assert.equal(matchesVisibleRows(rows.slice(0, 20), expected), true);
    assert.equal(matchesVisibleRows(rows, expected), false);
  }
});
test('manager policy excludes Completed and Closed but includes In Progress', () => {
  const statuses = ['Open', 'In Progress', 'Pending Verification', 'Completed', 'Closed'].map(status => ({ status }));
  assert.deepEqual(expectedVisibleRows('manager', statuses).map(row => row.status), ['Open', 'In Progress']);
});
test('technician and chief see all fixture rows; desk and housekeeping see none', () => {
  for (const role of ['technician', 'chief_engineer']) assert.equal(expectedVisibleRows(role, rows).length, 28);
  for (const role of ['front_desk', 'housekeeping']) assert.deepEqual(expectedVisibleRows(role, rows), []);
});
test('matching rejects incorrect identities, statuses, hotels, duplicates and missing rows', () => {
  assert.equal(matchesVisibleRows(rows, rows), true);
  for (const change of [{ id: 'unexpected' }, { status: 'Closed' }, { hotel_id: 'another-hotel' }]) {
    assert.equal(matchesVisibleRows([{ ...rows[0], ...change }, ...rows.slice(1)], rows), false);
  }
  assert.equal(matchesVisibleRows([rows[1], ...rows.slice(1)], rows), false);
  assert.equal(matchesVisibleRows(rows.slice(1), rows), false);
  assert.throws(() => expectedVisibleRows('unexpected', rows));
});
