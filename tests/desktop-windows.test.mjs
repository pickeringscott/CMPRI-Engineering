import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  addToDashboardInbox,
  clearDashboardInbox,
  newWorkOrderNotification,
} from '../src/lib/dashboard/work-order-notifications.ts';

const desktop = { width: 1600, height: 900 };
const origin = 'https://cmpri.example';

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

test('dashboard inbox keeps notifications until the engineer clears them', () => {
  const view = { id: 'technician-view:1', work_order_id: 'wo-1', message: 'Tech viewed WO-1', recorded_at: '2026-09-28T20:00:00.000Z' };
  const created = newWorkOrderNotification({ id: 'wo-2', display_id: 'WO-2', room: '101', issue: 'Leak', created_at: '2026-09-28T21:00:00.000Z' });
  assert.equal(created.id, 'new-order:wo-2');
  assert.match(created.message, /WO-2/);
  let { inbox, added } = addToDashboardInbox([], [view, created]);
  assert.equal(added.length, 2);
  assert.deepEqual(inbox.map((item) => item.id), ['new-order:wo-2', 'technician-view:1']);
  // Re-delivery (every poll) or a technician resolving the view never removes or duplicates it.
  ({ inbox, added } = addToDashboardInbox(inbox, [view]));
  assert.equal(added.length, 0);
  assert.equal(inbox.length, 2);
  inbox = clearDashboardInbox(inbox, ['technician-view:1']);
  assert.deepEqual(inbox.map((item) => item.id), ['new-order:wo-2']);
  ({ inbox, added } = addToDashboardInbox(inbox, [view], new Set(['technician-view:1'])));
  assert.equal(added.length, 0, 'a cleared notification does not come back');
});

test('engineering dashboard is a desktop of floating windows under a fixed top bar', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const windowFrame = readFileSync(new URL('../src/components/desktop/DesktopWindow.tsx', import.meta.url), 'utf8');
  const listWindow = readFileSync(new URL('../src/components/desktop/WorkOrderListWindow.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.doesNotMatch(windowFrame, /minimi[sz]e|maximi[sz]e/i);
  assert.match(windowFrame, /data-cmpri-window-close="true"/);
  assert.equal((windowFrame.match(/<button\b/g) || []).length, 1, 'close is the only window control');
  assert.match(dashboard, /cmpri-desktop-topbar relative z-\[200\]/);
  assert.match(dashboard, /const zIndex = 10 \+ Math\.max\(0, zOrder\.indexOf\(entry\.key\)\)/);
  assert.match(dashboard, /raise\(entry\.key, true\)/);
  assert.match(dashboard, /aria-label=\{bellLabel\}/);
  assert.match(dashboard, /onClick=\{openApprovals\}/);
  assert.doesNotMatch(dashboard, /WorkOrderNotificationBanner|resolved_notification_ids\.[a-z]+\([^)]*clearDashboardInbox/);
  assert.doesNotMatch(dashboard, /Awaiting Approval|KPI/, 'KPI cards live in the work order list window');
  assert.match(listWindow, /Awaiting Approval/);
  assert.match(styles, /html\.cmpri-desktop-interacting iframe \{\s*pointer-events: none !important;/);
  assert.match(styles, /container-type: inline-size;/);
});
