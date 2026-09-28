import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openOverlay, closeTopOverlay, shouldLockScroll, topOverlay } from '../src/lib/ui/overlay-stack.ts';
import { filterKpiWorkOrders } from '../src/lib/dashboard/kpi-filters.ts';
import { normalizeProfilePreferences } from '../src/lib/profile-preferences.ts';
import { dashboardTitleForRole, roleDisplayName } from '../src/lib/account-display.ts';
import { canEditEquipment, canReadEquipment, landingPath, roleAllows } from '../src/lib/server/roles.ts';

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
  assert.equal(landingPath('Front Desk'), '/work-orders');
  assert.equal(landingPath('Lead Housekeeper'), '/work-orders');
  assert.equal(roleAllows('Lead Housekeeper', 'submit'), true);
  assert.equal(roleAllows('Lead Housekeeper', 'view_dashboard'), false);
});

test('dashboard titles and account labels match assigned roles', () => {
  assert.equal(dashboardTitleForRole('engineer'), 'Engineer Dashboard');
  assert.equal(dashboardTitleForRole('manager'), 'General Manager Dashboard');
  assert.equal(dashboardTitleForRole('Front Desk'), 'Front Desk Dashboard');
  assert.equal(dashboardTitleForRole('housekeeping'), 'Lead Housekeeper Dashboard');
  assert.equal(dashboardTitleForRole('technician'), 'Maintenance Technician Dashboard');
  assert.equal(roleDisplayName('system_admin'), 'System Administrator');
});

test('shared account summary hides only Front Desk and Housekeeping role pills', () => {
  const source = readFileSync(new URL('../src/components/AccountSummary.tsx', import.meta.url), 'utf8');
  assert.match(source, /displayRole !== "Front Desk" && displayRole !== "Lead Housekeeper"/);
  assert.match(source, /\{showRole && <span className="rounded-full/);
  assert.match(source, /user\.email && <span>/);
});

test('sign-in More toggle reveals password access without exposing test account data', () => {
  const source = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /More…/);
  assert.match(source, /aria-controls="password-access"/);
  assert.match(source, /aria-expanded=\{showPasswordAccess\}/);
  assert.match(source, /\{showPasswordAccess && \(/);
  assert.match(source, /id="password-access"/);
  assert.match(source, /aria-label="Email"/);
  assert.match(source, /aria-label="Password"/);
  assert.doesNotMatch(source, /test-account|TEST_ACCOUNT|Front Desk Demo/i);
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
    notification_mode: 'both',
    notifications: { new_work_orders: false, status_changes: true, mentions: false },
  });
  assert.equal(normalizeProfilePreferences({ language: 'fr' }).language, 'en');
});

test('profile connection toggle is in the header before Dashboard without an OpenAI panel', () => {
  const source = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  const header = source.slice(source.indexOf('<div className="flex items-center justify-between gap-4 border-b'), source.indexOf('{message && <div role="status"'));
  assert.match(header, /Disconnect AI/);
  assert.match(header, /Connect AI/);
  assert.ok(header.indexOf('Disconnect AI') < header.indexOf('>{tx("Dashboard", "Panel")}</ModalDashboardLink>'));
  assert.doesNotMatch(source, /<h2[^>]*>OpenAI Connection<\/h2>/);
  assert.equal((source.match(/setPersonalAiConnection\(data\.personal_ai\.connected \? "disconnect" : "connect"\)/g) || []).length, 1);
});

test('housekeeping profile promotes language and appearance and omits notifications', () => {
  const source = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  assert.ok(source.indexOf('{tx("Personal Preferences"') < source.indexOf('{tx("Profile", "Perfil")}</h2>'));
  assert.match(source, /roleDisplayName\(data\?\.profile\.role \|\| ""\) === "Lead Housekeeper"/);
  assert.match(source, /!isHousekeeping && <div/);
  assert.match(source, /!isHousekeeping && <fieldset/);
  assert.match(source, /isHousekeeping \? "Housekeeping" : roleDisplayName\(data\.profile\.role \|\| "Unknown"\)/);
});

test('submit-only profile dashboard link returns Front Desk and Housekeeping directly to work orders', () => {
  const source = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  const modalLink = readFileSync(new URL('../src/components/ModalDashboardLink.tsx', import.meta.url), 'utf8');
  assert.match(source, /\["Front Desk", "Lead Housekeeper"\]\.includes\(roleDisplayName\(data\?\.profile\.role \|\| ""\)\)/);
  assert.match(source, /<ModalDashboardLink href=\{profileDashboardHref\}/);
  assert.match(modalLink, /href=\{href\} onClick=\{closeModal\}/);
  assert.match(modalLink, /type: "cmpri-modal-dashboard"/);
});

test('authorized Housekeeping render replaces the Engineering fallback and preserves shared assistant width', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const assistant = readFileSync(new URL('../src/components/DashboardAssistant.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(dashboard, /if \(!cmpriSession\)\s*\{\s*return/);
  assert.match(dashboard, /isHousekeepingDashboard \? "CMPRI Housekeeping" : "CMPRI Engineering"/);
  assert.match(assistant, /cmpri-dashboard-assistant/);
  assert.match(styles, /\.cmpri-dashboard-assistant\s*\{\s*width: min\(66vw, 72rem\)/);
  assert.match(styles, /\.cmpri-dashboard-assistant\s*\{\s*width: calc\(100vw - 16px\)/);
});

test('submit-only work-order dashboards omit the extra dashboard heading', () => {
  const source = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /cmpriSession && !embedded && \([\s\S]*?!isSubmitOnlyUser && <h1/);
  assert.match(source, /<AccountSummary user=\{cmpriSession\.user\} \/>/);
  assert.match(source, /dashboardTitleForRole\(cmpriSession\.user\.role\)/);
});

test('work-order top bar separates photo-file selection from camera capture', () => {
  const source = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /htmlFor="work-order-photo-file"[^>]*title="Choose a photo file"/);
  assert.match(source, /id="work-order-photo-file" type="file" accept="image\/\*" onChange=\{\(event\) => \{ setPhoto/);
  assert.match(source, /htmlFor="work-order-photo-camera"[^>]*title="Take a photo"/);
  assert.match(source, /id="work-order-photo-camera" type="file" accept="image\/\*" capture="environment" onChange=\{\(event\) => \{ setPhoto/);
});

test('profile exposes user management only through the shared capability policy', () => {
  const source = readFileSync(new URL('../src/app/api/profile/route.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ allows \} from "@\/lib\/server\/access"/);
  assert.equal((source.match(/can_manage_users: allows\(auth\.principal, "manage_users"\)/g) || []).length, 3);
  assert.doesNotMatch(source, /roleAllows/);
});
