import test from 'node:test';
import assert from 'node:assert/strict';
import { openOverlay, closeTopOverlay, shouldLockScroll, topOverlay } from '../src/lib/ui/overlay-stack.ts';
import { filterKpiWorkOrders } from '../src/lib/dashboard/kpi-filters.ts';
import { normalizeProfilePreferences } from '../src/lib/profile-preferences.ts';
import { canEditEquipment, canReadEquipment } from '../src/lib/server/roles.ts';

test('overlay stack opens, unwinds top-first, and locks lower scrolling', () => {
  let stack = [];
  assert.equal(shouldLockScroll(stack), false);
  stack = openOverlay(stack, { id: 'list', kind: 'work-order-list' });
  stack = openOverlay(stack, { id: 'ticket', kind: 'work-order' });
  assert.equal(shouldLockScroll(stack), true);
  assert.deepEqual(topOverlay(stack), { id: 'ticket', kind: 'work-order' });
  stack = closeTopOverlay(stack);
  assert.deepEqual(topOverlay(stack), { id: 'list', kind: 'work-order-list' });
  stack = closeTopOverlay(stack);
  assert.equal(shouldLockScroll(stack), false);
});

test('KPI filters return only matching work orders', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const orders = [
    { id: 'open', status: 'Open', priority: 'Low', due_by: '2026-09-30' },
    { id: 'progress', status: 'In Progress', priority: 'Medium', due_by: '2026-09-30' },
    { id: 'urgent', status: 'Open', priority: 'Urgent', due_by: '2026-09-30' },
    { id: 'overdue', status: 'Open', priority: 'Low', due_by: '2026-09-20' },
    { id: 'closed', status: 'Closed', priority: 'High', due_by: '2026-09-20' },
  ];
  assert.deepEqual(filterKpiWorkOrders(orders, 'open', now).map((order) => order.id), ['open', 'progress', 'urgent', 'overdue']);
  assert.deepEqual(filterKpiWorkOrders(orders, 'progress', now).map((order) => order.id), ['progress']);
  assert.deepEqual(filterKpiWorkOrders(orders, 'priority', now).map((order) => order.id), ['urgent']);
  assert.deepEqual(filterKpiWorkOrders(orders, 'overdue', now).map((order) => order.id), ['overdue']);
});

test('equipment role visibility keeps technicians read-only', () => {
  assert.equal(canReadEquipment('Maintenance Technician'), true);
  assert.equal(canEditEquipment('Maintenance Technician'), false);
  assert.equal(canReadEquipment('Front Desk'), false);
  assert.equal(canEditEquipment('Chief Engineer'), true);
});

test('profile preferences normalize and persist supported values', () => {
  const saved = normalizeProfilePreferences({
    language: 'es',
    appearance: 'light',
    notifications: { new_work_orders: false, status_changes: true, mentions: false },
  });
  assert.deepEqual(saved, {
    language: 'es',
    appearance: 'light',
    notifications: { new_work_orders: false, status_changes: true, mentions: false },
  });
  assert.equal(normalizeProfilePreferences({ language: 'fr' }).language, 'en');
});
