import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  mergeWorkOrderNotifications,
  unseenWorkOrderNotifications,
  technicianViewNotificationsForEngineer,
  workOrderNotificationCursorKey,
  workOrderNotificationsForRecipient,
  readDismissedWorkOrderViewNotifications,
  saveDismissedWorkOrderViewNotifications,
  unreadWorkOrderNotificationCount,
} from '../src/lib/dashboard/work-order-notifications.ts';
import { receivesOrdinaryWorkOrderNotifications, receivesPoolClosedNotifications } from '../src/lib/server/roles.ts';

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

test('technicians hear about work assigned to them, reassignment after close, and engineer claims', () => {
  const events = [
    historyEvent('self-claim', {
      event_type: 'claimed',
      actor_user_id: 'technician-id',
      changed_fields: { technician_name: 'Morgan Lee', previous_technician_name: '', actor_role: 'Technician' },
    }),
    historyEvent('assigned-by-engineer', {
      event_type: 'assigned',
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'morgan lee ', previous_technician_name: '', actor_role: 'Engineer', after_close: false },
      snapshot: { display_id: 'WO-2' },
    }),
    historyEvent('reopened-to-me', {
      event_type: 'assigned',
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'Morgan Lee', previous_technician_name: '', actor_role: 'Engineer', after_close: true },
      snapshot: { display_id: 'WO-3' },
    }),
    historyEvent('assigned-to-other', {
      event_type: 'assigned',
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'Taylor Smith', previous_technician_name: '', actor_role: 'Engineer', after_close: true },
    }),
    historyEvent('engineer-claim', {
      event_type: 'claimed',
      actor_user_id: 'engineer-id',
      changed_fields: { technician_name: 'Alex Engineer', previous_technician_name: 'Taylor Smith', actor_role: 'Engineer' },
      snapshot: { display_id: 'WO-5' },
    }),
    historyEvent('coworker-claim', {
      event_type: 'claimed',
      actor_user_id: 'tech-2',
      changed_fields: { technician_name: 'Taylor Smith', previous_technician_name: '', actor_role: 'Technician' },
    }),
    historyEvent('status-change', { event_type: 'status_changed', actor_user_id: 'engineer-id', old_status: 'Open', new_status: 'In Progress' }),
  ];
  const result = workOrderNotificationsForRecipient(events, { id: 'technician-id', name: 'Morgan Lee', role: 'technician' });
  assert.deepEqual(result.map(({ id, message }) => [id, message]), [
    ['assigned-by-engineer', 'WO-2 was assigned to you.'],
    ['reopened-to-me', 'WO-3 was reopened and reassigned to you.'],
    ['engineer-claim', 'WO-5: Claimed by Engineer'],
  ]);
});

test('engineers are alerted on status changes and claims by anyone else', () => {
  const events = [
    historyEvent('created', { event_type: 'created', old_status: null, new_status: 'Open' }),
    historyEvent('status-change', { event_type: 'status_changed', actor_name: 'Morgan Lee', actor_user_id: 'technician-id', old_status: 'Open', new_status: 'In Progress' }),
    historyEvent('closed', { event_type: 'closed', actor_name: 'Pat Admin', actor_user_id: 'admin-id', old_status: 'Completed', new_status: 'Closed' }),
    historyEvent('own-change', { event_type: 'status_changed', actor_user_id: 'engineer-id', old_status: 'Open', new_status: 'Completed' }),
    historyEvent('self-claim', {
      event_type: 'claimed',
      actor_name: 'Morgan Lee',
      actor_user_id: 'technician-id',
      changed_fields: { technician_name: 'Morgan Lee' },
      snapshot: { display_id: 'WO-2' },
    }),
    historyEvent('assignment', {
      event_type: 'assigned',
      actor_user_id: 'other-engineer',
      changed_fields: { technician_name: 'Taylor Smith' },
    }),
  ];
  const result = workOrderNotificationsForRecipient(events, { id: 'engineer-id', name: 'Alex Engineer', role: 'engineer' });
  assert.deepEqual(result.map(({ id, message }) => [id, message]), [
    ['history:status-change', 'WO-status-change status changed: Open \u2192 In Progress by Morgan Lee.'],
    ['history:closed', 'WO-closed status changed: Completed \u2192 Closed by Pat Admin.'],
    ['history:self-claim', 'WO-2 was claimed by Morgan Lee.'],
  ]);
});

test('engineer dashboard inbox records status and claim history for engineers only', () => {
  const route = readFileSync(new URL('../src/app/api/dashboard/notifications/route.ts', import.meta.url), 'utf8');
  assert.match(route, /const isEngineer = roleKey\(auth\.principal\.profile\.role\) === "engineer";/);
  assert.match(route, /if \(isEngineer\) \{[\s\S]*from\("cmpri_work_order_history"\)[\s\S]*\.in\("event_type", \["status_changed", "closed", "reopened", "claimed"\]\)[\s\S]*engineerHistoryNotifications\(history, userId\)/);
  const migration = readFileSync(new URL('../supabase/migrations/20260930220000_cmpri_work_order_history_notifications.sql', import.meta.url), 'utf8');
  assert.match(migration, /'actor_role', coalesce\(v_actor_role, ''\), 'after_close', v_after_close/);
  assert.match(migration, /v_after_close := old\.status::text = 'Closed' or/);
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

test('CMPRI notifications use the exact ordinary and pool-closure role lists', () => {
  for (const role of ['Chief Engineer', 'Engineer', 'Maintenance Technician', 'Technician']) {
    assert.equal(receivesOrdinaryWorkOrderNotifications(role), true, role);
  }
  for (const role of ['General Manager', 'Assistant General Manager', 'Front Desk Manager', 'System Administrator', 'Front Desk', 'Housekeeping', 'Senior Management']) {
    assert.equal(receivesOrdinaryWorkOrderNotifications(role), false, role);
  }
  for (const role of ['Chief Engineer', 'Engineer', 'Maintenance Technician', 'Engineering Manager', 'Regional Maintenance', 'General Manager', 'Assistant General Manager', 'Front Desk Manager']) {
    assert.equal(receivesPoolClosedNotifications({ role }), true, role);
  }
  for (const role of ['System Administrator', 'Front Desk', 'Housekeeping', 'Senior Management']) {
    assert.equal(receivesPoolClosedNotifications({ role }), false, role);
  }
  assert.equal(receivesPoolClosedNotifications({ role: 'Front Desk', secondary_roles: ['Chief Engineer'] }), false);
});

test('read notifications immediately leave the unread count without being cleared', () => {
  const items = [
    { id: 'unread-1', work_order_id: null, target_path: '/engineering/pool-log', message: 'Pool closed', recorded_at: '2026-10-05T12:00:00Z' },
    { id: 'read-1', work_order_id: 'order-1', message: 'Assigned', recorded_at: '2026-10-05T11:00:00Z', is_read: true },
    { id: 'unread-2', work_order_id: 'order-2', message: 'New order', recorded_at: '2026-10-05T10:00:00Z', is_read: false },
  ];
  assert.equal(unreadWorkOrderNotificationCount(items), 2);
  assert.equal(unreadWorkOrderNotificationCount(items.map((item) => ({ ...item, is_read: true }))), 0);
});

test('opening a dashboard notification marks it read before navigation and the badge counts only unread items', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  assert.match(dashboard, /function openNotification\(notification: WorkOrderNotification\) \{\s*void markNotificationRead\(notification\);[\s\S]*?if \(notification\.target_path\)/);
  assert.match(dashboard, /function openApprovals\(\) \{[\s\S]*?inbox\.forEach\(\(notification\) => \{\s*if \(!notification\.is_read\) void markNotificationRead\(notification\);\s*\}\)/);
  assert.match(dashboard, /const unreadCount = unreadWorkOrderNotificationCount\(inbox\)/);
  assert.match(dashboard, /count=\{notificationCount\}/);
  assert.doesNotMatch(dashboard, /const notificationCount = inbox\.length/);
});

test('Technician inbox reads are separate from active notification resolution', () => {
  const dashboard = readFileSync(new URL('../src/app/technician/page.tsx', import.meta.url), 'utf8');
  const openInbox = dashboard.slice(dashboard.indexOf('async function toggleInbox()'), dashboard.indexOf('const assignedOrders'));
  assert.match(openInbox, /markServerDashboardNotificationsRead\(dashboardTokenRef\.current, unreadIds\)/);
  assert.doesNotMatch(openInbox, /clearServerDashboardNotifications/);
  assert.match(dashboard, /Active notifications · \{dashboardInbox\.length\}/);
});

test('notification read API updates only the signed-in recipient and unread row', async () => {
  const source = readFileSync(new URL('../src/app/api/dashboard/notifications/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const principal = { identity: { id: 'recipient-user' }, profile: { role: 'Front Desk Manager', active: true } };
  const admin = {
    from(table) {
      let mutation;
      const filters = [];
      const query = {
        update(value) { mutation = value; return query; },
        eq(key, value) { filters.push(['eq', key, value]); return query; },
        is(key, value) { filters.push(['is', key, value]); return query; },
        in(key, value) { filters.push(['in', key, value]); return query; },
        then(resolve, reject) {
          calls.push({ table, mutation, filters });
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'cmpri-hotel' };
      if (name === '@/lib/server/access') return { allows: (_user, capability) => capability === 'receive_pool_closed_notifications' };
      if (name === '@/lib/server/auth') return { requireUser: async () => ({ principal, admin }) };
      if (name === '@/lib/server/roles') return {
        receivesAnyNotifications: () => true,
        receivesOrdinaryWorkOrderNotifications,
        profileHasRole: () => false,
        roleKey: () => 'front_desk_manager',
      };
      if (name === '@/lib/notifications/web-push') return { dispatchWebPushNotifications: async () => undefined, isWebPushEligibleProfile: () => false };
      if (name === '@/lib/notifications/schedule') return { isWebPushEligibleProfile: () => false };
      if (name === '@/lib/dashboard/work-order-notifications') return {
        dashboardNotificationScanStart: () => '',
        engineerHistoryNotifications: () => [],
        newWorkOrderNotification: () => ({}),
        sanitizeImportedDashboardNotifications: () => [],
        shouldWriteDashboardNotificationCursor: () => false,
        technicianViewNotificationsForEngineer: () => [],
        unrecordedDashboardNotifications: () => [],
      };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  const response = await exports.POST({
    json: async () => ({ action: 'read', ids: ['pool-closed:local'] }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'cmpri_dashboard_notifications');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].mutation)), { read_at: calls[0].mutation.read_at });
  assert.deepEqual(calls[0].filters.map(([operator, column, value]) => [
    operator, column, Array.isArray(value) ? [...value] : value,
  ]), [
    ['eq', 'hotel_id', 'cmpri-hotel'],
    ['eq', 'recipient_user_id', 'recipient-user'],
    ['is', 'cleared_at', null],
    ['in', 'notification_key', ['pool-closed:local']],
    ['is', 'read_at', null],
  ]);
  assert.equal(typeof calls[0].mutation.read_at, 'string');
  assert.equal(Date.parse(calls[0].mutation.read_at) > 0, true);
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
