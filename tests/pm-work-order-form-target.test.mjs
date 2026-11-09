import test from 'node:test';
import assert from 'node:assert/strict';
import { pmRoomNumber, workOrderFormTarget } from '../src/lib/pm/work-order-form-target.ts';

const room = { name: 'Room 101', room_number: '101' };
const resolve = (linked, location = room, workOrderRoom = null) => workOrderFormTarget(linked, location, ['101', '102'], 'room-form', '2026-10-01', workOrderRoom);

test('an explicitly linked form retains its original period and location', () => {
  const linked = { templateId: 'public-restrooms', periodStart: '2025-01-01', scopeKey: 'area:lobby' };
  assert.deepEqual(resolve(linked), linked);
  assert.deepEqual(resolve(linked, undefined, '102'), linked);
});

test('an inactive or missing location falls back to the authorized work-order room', () => {
  const expected = { templateId: 'room-form', periodStart: '2026-10-01', scopeKey: 'room:102' };
  assert.deepEqual(resolve(null, null, 'Room 102'), expected);
  assert.deepEqual(resolve(null, { name: 'Inactive', room_number: null }, '102'), expected);
  assert.equal(resolve(null, null, 'Storage 102'), null);
  assert.equal(resolve(null, null, 'Room 999'), null);
});

test('work-order room labels are accepted only when they exactly identify a catalogued room', () => {
  assert.equal(pmRoomNumber('  room 102  ', ['101', '102']), '102');
  assert.equal(pmRoomNumber('102', ['101', '102']), '102');
  assert.equal(pmRoomNumber('Storage 102', ['101', '102']), null);
  assert.equal(pmRoomNumber('102 / 101', ['101', '102']), null);
  assert.equal(pmRoomNumber('999', ['101', '102']), null);
  assert.equal(pmRoomNumber(null, ['101', '102']), null);
});

test('an unlinked guest-room work order opens the current room form', () => {
  const expected = { templateId: 'room-form', periodStart: '2026-10-01', scopeKey: 'room:101' };
  assert.deepEqual(resolve(null), expected);
  assert.deepEqual(resolve(null, { name: 'Room 101', room_number: null }), expected);
});

test('an unlinked non-room location does not guess a form', () => {
  assert.equal(resolve(null, { name: 'Lobby', room_number: null }), null);
  assert.equal(resolve(null, { name: 'Storage 101', room_number: null }), null);
  assert.equal(resolve(null, { name: 'Room 999', room_number: '999' }), null);
});
