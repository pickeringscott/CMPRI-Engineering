import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  clampWindowRect,
  defaultWindowRect,
  desktopFrameHref,
  desktopLayoutStorageKey,
  desktopWindowKeyForHref,
  isDesktopRoute,
  moveWindowRect,
  raiseWindow,
  readDesktopLayouts,
  resizeWindowRect,
  saveDesktopLayout,
  windowLayoutKey,
} from '../src/lib/ui/desktop-windows.ts';
import {
  dashboardNotificationScanStart,
  newWorkOrderNotification,
  sanitizeImportedDashboardNotifications,
  shouldWriteDashboardNotificationCursor,
  unrecordedDashboardNotifications,
  DASHBOARD_NOTIFICATION_POLL_MS,
} from '../src/lib/dashboard/work-order-notifications.ts';

const desktop = { width: 1600, height: 900 };
const origin = 'https://cmpri.example';

test('work-order list remains a valid client component', () => {
  const source = readFileSync(new URL('../src/components/desktop/WorkOrderListWindow.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('WorkOrderListWindow.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(ast.parseDiagnostics.length, 0, 'work-order list must parse without errors');
  const directive = ast.statements[0];
  assert.ok(ts.isExpressionStatement(directive) && ts.isStringLiteral(directive.expression));
  assert.equal(directive.expression.text, 'use client');
});

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

test('desktop windows stay fully on the desktop and regrow within it', () => {
  assert.deepEqual(clampWindowRect({ x: 1500, y: 850, width: 500, height: 400 }, desktop), { x: 1100, y: 500, width: 500, height: 400 });
  assert.deepEqual(clampWindowRect({ x: -40, y: -10, width: 5000, height: 50 }, desktop), { x: 0, y: 0, width: 1600, height: 200 });
  assert.deepEqual(clampWindowRect({ x: 200, y: 100, width: 800, height: 600 }, { width: 500, height: 700 }), { x: 0, y: 0, width: 500, height: 700 });
  assert.deepEqual(moveWindowRect({ x: 100, y: 100, width: 400, height: 300 }, 5000, -5000, desktop), { x: 1200, y: 0, width: 400, height: 300 });
});

test('resizing keeps the opposite edge anchored and respects the minimum size', () => {
  const start = { x: 400, y: 200, width: 600, height: 400 };
  assert.deepEqual(resizeWindowRect(start, 'w', -100, 0, desktop), { x: 300, y: 200, width: 700, height: 400 });
  assert.deepEqual(resizeWindowRect(start, 'nw', 1000, 1000, desktop), { x: 680, y: 400, width: 320, height: 200 });
  assert.deepEqual(resizeWindowRect(start, 'se', 5000, 5000, desktop), { x: 400, y: 200, width: 1200, height: 700 });
  assert.deepEqual(resizeWindowRect(start, 'n', -500, -500, desktop), { x: 400, y: 0, width: 600, height: 600 });
});

test('new windows center and cascade, and raising moves a window to the top only', () => {
  const first = defaultWindowRect(desktop, { width: 1000, height: 700 }, 0);
  const second = defaultWindowRect(desktop, { width: 1000, height: 700 }, 1);
  assert.equal(second.x - first.x, 28);
  assert.equal(second.y - first.y, 28);
  assert.ok(first.x + first.width <= desktop.width && first.y + first.height <= desktop.height);
  assert.deepEqual(raiseWindow(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  const openedOnPhone = defaultWindowRect({ width: 400, height: 700 }, { width: 1000, height: 700 });
  assert.deepEqual(openedOnPhone, { x: 0, y: 0, width: 1000, height: 700 }, 'desired size survives compact mode');
  assert.deepEqual(clampWindowRect(openedOnPhone, { width: 400, height: 700 }), { x: 0, y: 0, width: 400, height: 700 });
});

test('window layouts are remembered per user and work-order windows share a layout', () => {
  const storage = memoryStorage();
  saveDesktopLayout(storage, 'user-a', '/engineering/pool-log', { x: 10, y: 20, width: 700, height: 500 });
  saveDesktopLayout(storage, 'user-a', windowLayoutKey('/work-orders/abc'), { x: 1, y: 2, width: 900, height: 600 });
  assert.deepEqual(readDesktopLayouts(storage, 'user-a')['/engineering/pool-log'], { x: 10, y: 20, width: 700, height: 500 });
  assert.deepEqual(readDesktopLayouts(storage, 'user-a')['/work-orders/:id'], { x: 1, y: 2, width: 900, height: 600 });
  assert.deepEqual(readDesktopLayouts(storage, 'user-b'), {});
  assert.equal(windowLayoutKey('/work-orders'), '/work-orders');
  storage.setItem(desktopLayoutStorageKey('user-c'), '{"bad":{"x":"1"},"ok":{"x":1,"y":1,"width":400,"height":300}}');
  assert.deepEqual(Object.keys(readDesktopLayouts(storage, 'user-c')), ['ok']);
});

test('desktop routes open same-origin screens as embedded windows', () => {
  assert.equal(desktopWindowKeyForHref('/engineering/pool-log?date=2026-01-01', origin), '/engineering/pool-log');
  assert.equal(isDesktopRoute('/management/rooms', origin), true);
  assert.equal(isDesktopRoute('https://elsewhere.example/x', origin), false);
  assert.equal(isDesktopRoute('/api/work-orders', origin), false);
  assert.equal(isDesktopRoute('mailto:a@b.c', origin), false);
  assert.equal(desktopFrameHref('/feedback?route=%2Fengineering', 'tok', origin), '/feedback?route=%2Fengineering&embedded=1&modalToken=tok');
});

test('server inbox records each notification once and a cleared one never returns', () => {
  const view = { id: 'technician-view:1', work_order_id: 'wo-1', message: 'Tech viewed WO-1', recorded_at: '2026-09-28T20:00:00.000Z' };
  const created = newWorkOrderNotification({ id: 'wo-2', display_id: 'WO-2', room: '101', issue: 'Leak', created_at: '2026-09-28T21:00:00.000Z' });
  assert.equal(created.id, 'new-order:wo-2');
  assert.match(created.message, /WO-2/);
  assert.deepEqual(unrecordedDashboardNotifications([view, created, view], []).map((item) => item.id), ['technician-view:1', 'new-order:wo-2']);
  // Recorded keys include cleared rows, so re-scans and technician actions never re-add or remove them.
  assert.deepEqual(unrecordedDashboardNotifications([view, created], ['technician-view:1']).map((item) => item.id), ['new-order:wo-2']);
  assert.equal(unrecordedDashboardNotifications([view, created], ['technician-view:1', 'new-order:wo-2']).length, 0);
});

test('server notification cursor starts now, then re-scans an overlap window', () => {
  const now = '2026-09-30T12:00:00.000Z';
  assert.equal(DASHBOARD_NOTIFICATION_POLL_MS, 1000, 'new work orders are checked every second');
  assert.equal(dashboardNotificationScanStart(null, now), now);
  assert.equal(dashboardNotificationScanStart('2026-09-30T11:59:00.000Z', now), '2026-09-30T11:54:00.000Z');
  assert.equal(dashboardNotificationScanStart('2026-09-30T13:00:00.000Z', now), '2026-09-30T11:55:00.000Z', 'a future cursor cannot hide events');
  assert.equal(shouldWriteDashboardNotificationCursor(null, now), true);
  assert.equal(shouldWriteDashboardNotificationCursor('2026-09-30T11:59:30.000Z', now), false);
  assert.equal(shouldWriteDashboardNotificationCursor('2026-09-30T11:59:00.000Z', now), true);
});

test('only well-formed local notifications are imported into the server inbox', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const accepted = sanitizeImportedDashboardNotifications([
    { id: `new-order:${uuid}`, work_order_id: uuid, message: ' New WO-1 ', recorded_at: '2026-09-28T20:00:00Z' },
    { id: `new-order:${uuid}`, work_order_id: uuid, message: 'dup', recorded_at: '2026-09-28T20:00:00Z' },
    { id: 'other:1', work_order_id: uuid, message: 'x', recorded_at: '2026-09-28T20:00:00Z' },
    { id: 'technician-view:2', work_order_id: 'not-a-uuid', message: 'x', recorded_at: '2026-09-28T20:00:00Z' },
    { id: 'technician-view:3', work_order_id: uuid, message: 'x'.repeat(900), recorded_at: 'bad' },
    'junk',
  ]);
  assert.deepEqual(accepted, [{ id: `new-order:${uuid}`, work_order_id: uuid, target_path: null, message: 'New WO-1', recorded_at: '2026-09-28T20:00:00.000Z' }]);
  assert.deepEqual(sanitizeImportedDashboardNotifications('nope'), []);
});

test('dashboard notifications live in the database, scoped to the signed-in user', () => {
  const route = readFileSync(new URL('../src/app/api/dashboard/notifications/route.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20260930190000_cmpri_dashboard_notifications.sql', import.meta.url), 'utf8');
  const roomOpsMigration = readFileSync(new URL('../supabase/migrations/20260930210000_cmpri_room_ops_notifications.sql', import.meta.url), 'utf8');
  const goLiveMigration = readFileSync(new URL('../supabase/migrations/20261005170000_cmpri_go_live_permissions_and_notifications.sql', import.meta.url), 'utf8');
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  assert.match(migration, /unique \(hotel_id, recipient_user_id, notification_key\)/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.cmpri_dashboard_notifications from anon, authenticated;/);
  assert.match(route, /requireUser\(request\)/);
  assert.equal((route.match(/\.eq\("recipient_user_id", userId\)/g) || []).length, 3, 'every inbox read/write is scoped to the requester');
  assert.match(route, /\.update\(update\)/);
  assert.match(route, /body\.action === "read"[\s\S]*read_at: new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(route, /\.delete\(/);
  assert.match(route, /target_path: notification\.target_path \|\| null/);
  assert.doesNotMatch(dashboard, /saveDashboardInbox|addEventListener\("storage"|detectNewOrders/);
  assert.match(dashboard, /if \(notification\.target_path\) openRoute\(notification\.target_path, "Daily Room Ops"\)/);
  assert.match(roomOpsMigration, /alter column work_order_id drop not null/);
  assert.match(roomOpsMigration, /add column if not exists target_path text/);
  assert.match(goLiveMigration, /add column if not exists read_at timestamptz/i);
  assert.match(goLiveMigration, /where cleared_at is null and read_at is null/i);
  assert.match(goLiveMigration, /'\/engineering\/pool-log'/);
  assert.match(migration, /clears them/);
  assert.doesNotMatch(dashboard, /setInterval/);
  assert.match(dashboard, /subscribeResources/);
  assert.match(dashboard, /void loadDashboard\(true\)/);
});

test('engineering dashboard is a desktop of floating windows under a fixed top bar', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const windowFrame = readFileSync(new URL('../src/components/desktop/DesktopWindow.tsx', import.meta.url), 'utf8');
  const listWindow = readFileSync(new URL('../src/components/desktop/WorkOrderListWindow.tsx', import.meta.url), 'utf8');
  const workOrderDetail = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
  const modalHost = readFileSync(new URL('../src/components/GlobalModalHost.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.doesNotMatch(windowFrame, /minimi[sz]e|maximi[sz]e/i);
  assert.match(windowFrame, /data-cmpri-window-close="true"/);
  assert.equal((windowFrame.match(/<button\b/g) || []).length, 1, 'close is the only window control');
  assert.match(dashboard, /cmpri-desktop-topbar relative z-\[200\]/);
  assert.match(dashboard, /<ApprovedDashboardMenus groups=\{visibleLauncherGroups\}/);
  assert.match(dashboard, /title=\{launcher\.label\}/);
  assert.match(dashboard, /shrink-0 whitespace-nowrap rounded border px-[12] py-0\.5/);
  assert.match(dashboard, /const zIndex = 10 \+ Math\.max\(0, zOrder\.indexOf\(entry\.key\)\)/);
  assert.match(dashboard, /raise\(entry\.key, true\)/);
  assert.match(dashboard, /aria-label=\{bellLabel\}/);
  assert.match(dashboard, /onClick=\{openApprovals\}/);
  assert.doesNotMatch(dashboard, /WorkOrderNotificationBanner|resolved_notification_ids/);
  assert.doesNotMatch(dashboard, /Awaiting Approval|KPI/, 'KPI cards live in the work order list window');
  assert.match(listWindow, /Pending/);
  assert.match(listWindow, /compactLabel/);
  assert.match(listWindow, /@md:hidden/);
  assert.match(listWindow, /@md:inline/);
  assert.match(listWindow, /aria-label=\{\`\$\{card\.label\}:/);
  assert.match(listWindow, /overflow-hidden bg-slate-950/);
  assert.match(workOrderDetail, /<WorkOrderAttachmentHistory items=\{workOrderImages\}/);
  assert.match(workOrderDetail, /<WorkOrderMediaComposer/);
  assert.match(workOrderDetail, /checkoutLabel\(roomOperationalContext\.checkoutDate, roomOperationalContext\.checkoutTime\)/);
  assert.match(workOrderDetail, /<summary className="list-item cursor-pointer">[\s\S]*?Suggested Troubleshooting/);
  assert.match(workOrderDetail, /<summary className="cursor-pointer text-sm font-semibold">Closure Details\{pendingField\("actionRootCause"\)\}<\/summary>/);
  assert.match(modalHost, /isWorkOrderDetail \? 94 : 66/);
  assert.match(styles, /html\.cmpri-desktop-interacting iframe \{\s*pointer-events: none !important;/);
  assert.match(styles, /container-type: inline-size;/);
});

test('approval modal removes only redundant controls and hides only an empty approval list', () => {
 const source=readFileSync(new URL('../src/components/desktop/WorkOrderApprovalsWindow.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/aria-label="Signed-in account"|Sound on|Sound off|No work orders are waiting/);
 assert.match(source,/awaitingApproval.length > 0 && <ul aria-label="Work orders awaiting approval"/);
 assert.match(source,/<span className="font-bold text-slate-400">\{awaitingApproval.length\}/);
 assert.match(source,/onClick=\{onClearAll\}/);
 assert.match(source,/onClick=\{\(\) => onClear\(notification.id\)\}/);
 const list=readFileSync(new URL('../src/components/desktop/WorkOrderListWindow.tsx',import.meta.url),'utf8');
 assert.equal((list.match(/text-\[calc\(0.78em\+3px\)\]/g)||[]).length,2);
});
