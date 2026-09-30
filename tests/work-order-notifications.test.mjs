import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mergeWorkOrderNotifications,
  unseenWorkOrderNotifications,
  technicianViewNotificationsForEngineer,
  workOrderNotificationCursorKey,
  workOrderNotificationsForRecipient,
  readDismissedWorkOrderViewNotifications,
  saveDismissedWorkOrderViewNotifications,
} from '../src/lib/dashboard/work-order-notifications.ts';

function historyEvent(id, patch = {}) {
  return {
    id,
    work_order_id: `work-order-${id}`,
    actor_user_id: 'actor',
    old_status: 'Open',
    new_status: 'Open',
    changed_fields: {},
    snapshot: { display_id: `WO-${id}`, technician_name: '' },
    recorded_at: '2026-09-28T20:00:00.000Z',
    ...patch,
  };
}

test('technician alerts only for another user assigning work to them', () => {
  const events = [
    historyEvent('self-claim', {
      actor_user_id: 'technician-id',
      changed_fields: { technician_name: 'Morgan Lee' },
      snapshot: { display_id: 'WO-1', technician_name: 'Morgan Lee' },
    }),
    historyEvent('assigned-by-coworker', {
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'Morgan Lee' },
      snapshot: { display_id: 'WO-2', technician_name: 'Morgan Lee' },
    }),
    historyEvent('assigned-to-other', {
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'Taylor Smith' },
      snapshot: { display_id: 'WO-3', technician_name: 'Taylor Smith' },
    }),
  ];
  const result = workOrderNotificationsForRecipient(events, {
    id: 'technician-id',
    name: 'Morgan Lee',
    role: 'technician',
  }, new Map());
  assert.deepEqual(result.map(({ id, message }) => [id, message]), [
    ['assigned-by-coworker', 'WO-2 was assigned to you.'],
  ]);
});

test('engineers are alerted on every status change and technician self-claims', () => {
  const events = [
    historyEvent('created', { old_status: null, new_status: 'Open' }),
    historyEvent('status-change', { old_status: 'Open', new_status: 'In Progress' }),
    historyEvent('self-claim', {
      actor_user_id: 'technician-id',
      changed_fields: { technician_name: 'Morgan Lee' },
      snapshot: { display_id: 'WO-2', technician_name: 'Morgan Lee' },
    }),
    historyEvent('engineer-assignment', {
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'Taylor Smith' },
      snapshot: { display_id: 'WO-3', technician_name: 'Taylor Smith' },
    }),
  ];
  const actors = new Map([
    ['technician-id', { full_name: 'Morgan Lee', role: 'Maintenance Technician' }],
    ['engineer-id', { full_name: 'Alex Engineer', role: 'Engineer' }],
  ]);
  const result = workOrderNotificationsForRecipient(events, {
    id: 'engineer-id',
    name: 'Alex Engineer',
    role: 'engineer',
  }, actors);
  assert.deepEqual(result.map(({ id, message }) => [id, message]), [
    ['status-change', 'WO-status-change status changed: Open → In Progress'],
    ['self-claim', 'WO-2 was claimed by Morgan Lee.'],
  ]);
});

test('notification helpers de-duplicate repeated polling responses', () => {
  const notification = {
    id: 'event-1',
    work_order_id: 'order-1',
    message: 'WO-1 status changed: Open → Completed',
    recorded_at: '2026-09-28T20:00:00.000Z',
  };
  const seen = new Set();
  const first = unseenWorkOrderNotifications(seen, [notification]);
  const second = unseenWorkOrderNotifications(seen, [notification]);
  assert.deepEqual(first, [notification]);
  assert.deepEqual(second, []);
  assert.deepEqual(mergeWorkOrderNotifications(first, [notification]), [notification]);
});

test('technician first views create an engineer-only awaiting-satisfaction notification', () => {
  const result = technicianViewNotificationsForEngineer([
    {
      id: 'view-1',
      work_order_id: 'order-1',
      work_order_display_id: 'WO-1',
      technician_name: 'Morgan Lee',
      viewed_at: '2026-09-28T20:00:00.000Z',
    },
  ]);
  assert.deepEqual(result, [{
    id: 'technician-view:view-1',
    work_order_id: 'order-1',
    message: 'WO-1 viewed awaiting satisfying.',
    recorded_at: '2026-09-28T20:00:00.000Z',
  }]);
});

test('engineer and technician notification cursors are independent', () => {
  assert.notEqual(
    workOrderNotificationCursorKey('shared-user', 'engineer'),
    workOrderNotificationCursorKey('shared-user', 'technician'),
  );
});

test('engineer dismissals persist technician-view notices for the engineer only', () => {
  const values = new Map();
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
  try {
    saveDismissedWorkOrderViewNotifications('engineer-id', ['technician-view:view-1']);
    assert.deepEqual(Array.from(readDismissedWorkOrderViewNotifications('engineer-id')), ['technician-view:view-1']);
    assert.equal(readDismissedWorkOrderViewNotifications('technician-id').size, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('technician dashboard excludes CMPRI AI and shows due date beneath ordered ticket metadata', () => {
  const dashboard = readFileSync(new URL('../src/app/technician/page.tsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /DashboardAssistant/);
  assert.match(dashboard, /Status → \{statusText\}[\s\S]*Category → \{categoryText\}[\s\S]*Severity\/Priority → \{priorityText\}[\s\S]*Due Date → \{dueLabel\}/);
  assert.match(dashboard, /data-cmpri-modal-href="\/engineering\/pool-log"/);
  assert.match(dashboard, /<Link href="\/work-orders"[^>]*>Create a Work Order<\/Link>/);
});

test('notification endpoint authorizes dashboard recipients and scopes audit records to the property', () => {
  const route = readFileSync(new URL('../src/app/api/work-orders/notifications/route.ts', import.meta.url), 'utf8');
  assert.match(route, /requireUser\(request\)/);
  assert.match(route, /allows\(auth\.principal, "view_dashboard"\)/);
  assert.match(route, /\.eq\("hotel_id", HOTEL_ID\)/);
  assert.match(route, /\.gt\("recorded_at",/);
  assert.match(route, /role === "engineer"/);
  assert.match(route, /resolved_notification_ids/);
});

test('first technician view is recorded once and rendered as a locked timeline note', () => {
  const detailRoute = readFileSync(new URL('../src/app/api/work-orders/[id]/route.ts', import.meta.url), 'utf8');
  const ticket = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(detailRoute, /cmpri_work_order_technician_views/);
  assert.match(detailRoute, /ignoreDuplicates: true/);
  assert.match(ticket, /Technician first viewed this work order/);
  assert.match(ticket, /entry\.locked &&/);
});
