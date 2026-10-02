import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openOverlay, closeTopOverlay, shouldLockScroll, topOverlay } from '../src/lib/ui/overlay-stack.ts';
import { filterKpiWorkOrders } from '../src/lib/dashboard/kpi-filters.ts';
import { disableProfileNotifications, normalizeProfilePreferences } from '../src/lib/profile-preferences.ts';
import { dashboardTitleForRole, roleDisplayName } from '../src/lib/account-display.ts';
import { assignableRoleLabels, canEditEquipment, canManageTargetRole, canReadEquipment, isFrontDesk, isSubmitOnlyRole, landingPath, profileHasRole, roleAllows } from '../src/lib/server/roles.ts';

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
  assert.equal(landingPath('Front Desk Manager'), '/work-orders');
  assert.equal(landingPath('Lead Housekeeper'), '/work-orders');
  assert.equal(roleAllows('Front Desk Manager', 'submit'), true);
  assert.equal(roleAllows('Front Desk Manager', 'view_dashboard'), false);
  assert.equal(roleAllows('Front Desk Manager', 'manage_users'), false);
  assert.equal(roleAllows('Front Desk Manager', 'edit_tickets'), false);
  assert.equal(isFrontDesk('Front Desk Manager'), true);
  assert.equal(isSubmitOnlyRole('Front Desk Manager'), isSubmitOnlyRole('Assistant General Manager'));
  assert.equal(canManageTargetRole('General Manager', 'Front Desk Manager'), true);
  assert.ok(assignableRoleLabels('General Manager').includes('Front Desk Manager'));
  for (const capability of ['submit', 'view_dashboard', 'edit_tickets', 'review_tickets', 'manage_users', 'submit_feedback', 'view_profiles']) {
    assert.equal(roleAllows('Front Desk Manager', capability), roleAllows('Assistant General Manager', capability));
  }
  assert.equal(roleAllows('Lead Housekeeper', 'submit'), true);
  assert.equal(roleAllows('Lead Housekeeper', 'view_dashboard'), false);
});

test('dashboard titles and account labels match assigned roles', () => {
  assert.equal(dashboardTitleForRole('engineer'), 'Engineer Dashboard');
  assert.equal(dashboardTitleForRole('manager'), 'General Manager Dashboard');
  assert.equal(dashboardTitleForRole('Front Desk'), 'Front Desk Dashboard');
  assert.equal(dashboardTitleForRole('Front Desk Manager'), 'Front Desk Manager Dashboard');
  assert.equal(dashboardTitleForRole('housekeeping'), 'Lead Housekeeper Dashboard');
  assert.equal(dashboardTitleForRole('technician'), 'Maintenance Technician Dashboard');
  assert.equal(roleDisplayName('system_admin'), 'System Administrator');
  assert.equal(roleDisplayName('system_admin', ['engineer']), 'System Administrator + Engineer');
  assert.equal(profileHasRole({ role: 'system_admin', secondary_roles: ['engineer'] }, 'engineer'), true);
  assert.equal(profileHasRole({ role: 'system_admin' }, 'engineer'), false);
  assert.equal(profileHasRole({ role: 'system_admin/engineering' }, 'system_admin'), true);
});

test('shared account summary shows only a large gold name for Front Desk and Housekeeping', () => {
  const source = readFileSync(new URL('../src/components/AccountSummary.tsx', import.meta.url), 'utf8');
  assert.match(source, /const submitOnly = \["Front Desk", "Front Desk Manager", "Lead Housekeeper"\]\.includes\(displayRole\)/);
  assert.match(source, /text-\[14pt\] font-semibold tracking-tight text-amber-400/);
  assert.match(source, /text-\[14pt\] font-semibold tracking-tight text-slate-100/);
  assert.match(source, /text-\[9pt\] font-medium text-sky-200\/90/);
  assert.match(source, /!submitOnly && user\.email/);
  assert.match(source, /!submitOnly && <span className="text-\[9pt\] font-medium text-sky-200\/90">/);
});

test('dashboard title bars keep CMPRI Engineering and place account controls beneath the user name', () => {
  const engineering = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const workOrders = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  const headerStart = engineering.indexOf('<header className="cmpri-desktop-topbar');
  const engineeringHeader = engineering.slice(headerStart, engineering.indexOf('</header>', headerStart));
  assert.match(engineering, /text-\[14pt\] font-bold leading-none tracking-tight/);
  assert.match(engineering, /<span className="text-amber-300">\{isHousekeepingDashboard \? "Housekeeping" : "Engineering"\}<\/span>/);
  assert.match(engineering, /max-w-\[18rem\] truncate text-\[14pt\] font-semibold tracking-tight text-slate-100/);
  assert.match(engineering, /mt-1 text-\[9pt\] font-medium text-sky-200\/90">\{displayRole\}/);
  assert.ok(engineeringHeader.indexOf('text-[14pt] font-semibold tracking-tight text-slate-100') < engineeringHeader.indexOf('count={notificationCount}'));
  assert.match(engineeringHeader, /pt-\[8pt\]/);
  assert.match(engineering, /const notificationCount = inbox\.length \+ awaitingApproval\.length/);
  const notificationBell = readFileSync(new URL('../src/components/DashboardNotificationBell.tsx', import.meta.url), 'utf8');
  assert.match(notificationBell, /className="size-4" fill="none"/);
  assert.match(notificationBell, /grid size-5 shrink-0 place-items-center rounded-md border border-sky-400\/50/);
  assert.match(notificationBell, /absolute -right-1\.5 -top-1\.5 inline-flex h-3\.5 min-w-3\.5[\s\S]*?text-\[7pt\][\s\S]*?>\{count\}/);
  assert.doesNotMatch(engineeringHeader, /bg-purple-400|absolute -bottom-1 -right-1/);
  const accountGroup = engineering.slice(engineering.indexOf('label: "Account"'), engineering.indexOf('],', engineering.indexOf('label: "Account"')));
  assert.ok(accountGroup.indexOf('label: "Manage Profile"') < accountGroup.indexOf('label: "Connect ChatGPT"'));
  assert.match(styles, /\.cmpri-desktop-topbar button \{\s*font-size: 9pt !important/);
  assert.match(engineeringHeader, /nav aria-label="Open dashboard windows" className="[^"]*gap-0\.5/);
  assert.match(engineeringHeader, /role="group"[\s\S]*?className="[^"]*gap-0\.5[^"]*p-0\.5/);
  assert.match(engineeringHeader, /hidden px-0\.5 text-\[9pt\] font-bold uppercase/);
  assert.match(engineeringHeader, /rounded border px-1 py-0\.5 font-semibold/);
  assert.match(engineering, /const LAUNCHER_CLOSE_WINDOW_MS = 5_000/);
  assert.match(engineering, /windowOpenedAtRef\.current\.set\(entry\.key, Date\.now\(\)\)/);
  assert.match(engineering, /clickedAt - openedAt <= LAUNCHER_CLOSE_WINDOW_MS\)\s*\{\s*requestCloseWindow\(key\)/);
  assert.match(engineering, /launchWindow\(key, clickedAt, \(\) => openRoute\(href/);
  assert.match(engineering, /launcher\.label\.replace/);
  assert.doesNotMatch(engineering, /dashboardTitleForRole\(session\.user\.role\)/);
  assert.match(workOrders, /text-\[14pt\] font-bold leading-none tracking-tight/);
  assert.doesNotMatch(workOrders, /dashboardTitleForRole\(cmpriSession\.user\.role\)/);
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
  assert.deepEqual(disableProfileNotifications(saved), {
    ...saved,
    notification_mode: 'in_app',
    notifications: { new_work_orders: false, status_changes: false, mentions: false },
  });
});

test('profile preferences use the same layout and submit-only users can manage their ChatGPT connection', () => {
  const source = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /const isSubmitOnlyProfile = \["Front Desk", "Front Desk Manager", "Lead Housekeeper"\]/);
  assert.match(source, /<section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">\s*<h2 className="text-xl font-bold">\{tx\("Personal Preferences"/);
  assert.match(source, /<label className="grid gap-1 text-sm text-slate-300">\{tx\("Language"/);
  assert.match(source, /<label className="grid gap-1 text-sm text-slate-300">\{tx\("Appearance"/);
  assert.match(source, /<section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">[\s\S]*?ChatGPT Connection/);
  assert.match(source, /!isSubmitOnlyProfile && <label[\s\S]*?Sign-in email/);
  assert.match(source, /href="\/profile\/ai-connection"/);
  assert.doesNotMatch(source, /setPersonalAiConnection|Disconnect AI|Connect AI/);
});

test('Front Desk and Housekeeping get profile sign-out and ChatGPT connection status', () => {
  const source = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /isSubmitOnlyProfile && <button type="button" onClick=\{\(\) => void signOut\(\)\} aria-label=/);
  assert.match(source, /className="grid size-8 place-items-center rounded-lg border border-red-400/);
  assert.match(source, /<section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">/);
  assert.match(source, /!isHousekeeping && <div/);
  assert.match(source, /!isHousekeeping && <fieldset/);
  assert.match(source, /isHousekeeping \? "Housekeeping" : displayedRole \|\| "Unknown"/);
  const profileApi = readFileSync(new URL('../src/app/api/profile/route.ts', import.meta.url), 'utf8');
  assert.match(profileApi, /preferencesForRole\(auth\.principal\.profile\.role/);
  assert.match(profileApi, /chatgptConnectionForUser\(auth\.admin, auth\.principal\.identity\.id\)/);
  assert.match(profileApi, /preferencesForRole\(auth\.principal\.profile\.role/);
});

test('submit-only profile dashboard link returns Front Desk and Housekeeping directly to work orders', () => {
  const source = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  const modalLink = readFileSync(new URL('../src/components/ModalDashboardLink.tsx', import.meta.url), 'utf8');
  assert.match(source, /\["Front Desk", "Front Desk Manager", "Lead Housekeeper"\]\.includes\(roleDisplayName\(data\?\.profile\.role \|\| ""\)\)/);
  assert.match(source, /<ModalDashboardLink href=\{profileDashboardHref\}/);
  assert.match(modalLink, /<button type="button" data-cmpri-modal-dashboard="true"/);
  assert.doesNotMatch(modalLink, /<a\b/);
  assert.match(modalLink, /type: "cmpri-modal-dashboard"/);
});

test('authorized Housekeeping render replaces the Engineering fallback and shared dashboard no longer embeds an assistant', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(dashboard, /if \(!cmpriSession\)\s*\{\s*return/);
  assert.match(dashboard, /isHousekeepingDashboard \? "Housekeeping" : "Engineering"/);
  assert.match(dashboard, /<main data-cmpri-modal-ignore="true" className="cmpri-desktop-root flex h-dvh w-full min-w-0 flex-col overflow-hidden/);
  assert.doesNotMatch(dashboard, /lg:w-\[66vw\]/);
  assert.doesNotMatch(layout, /DashboardAssistant/);
  assert.doesNotMatch(styles, /cmpri-dashboard-assistant/);
});

test('work-order dashboards use 66% desktop width except Front Desk and Housekeeping', () => {
  const source = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /const isSubmitOnlyUser = \["front desk", "front desk manager", "frontdesk", "frontdeskmanager", "housekeeping", "lead housekeeper", "leadhousekeeper", "executive housekeeper", "executivehousekeeper"\]/);
  assert.match(source, /<div className=\{`mx-auto w-full max-w-none \$\{isSubmitOnlyUser \? "" : "lg:w-\[66vw\]"\}`\}>/);
});

test('work-order dashboards show the CMPRI Engineering title without a role-specific heading', () => {
  const source = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /cmpriSession && !embedded && \([\s\S]*?text-\[14pt\] font-bold leading-none tracking-tight/);
  assert.match(source, /<AccountSummary user=\{cmpriSession\.user\} \/>/);
  assert.doesNotMatch(source, /dashboardTitleForRole\(cmpriSession\.user\.role\)/);
});

test('work-order top bar separates photo-file selection from camera capture', () => {
  const source = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /htmlFor="work-order-photo-file"[^>]*title="Choose a photo file"/);
  assert.match(source, /id="work-order-photo-file" type="file" accept="image\/\*" onChange=\{\(event\) => \{ setPhoto/);
  assert.match(source, /htmlFor="work-order-photo-camera"[^>]*title="Take a photo"[^>]*\$\{isSubmitOnlyUser \? "md:hidden" : ""\}/);
  assert.match(source, /id="work-order-photo-camera" type="file" accept="image\/\*" capture="environment" onChange=\{\(event\) => \{ setPhoto/);
  assert.match(source, /\{!isSubmitOnlyUser && <button type="button" onClick=\{\(\) => void signOut\(\)\}/);
});

test('profile exposes user management only through the shared capability policy', () => {
  const source = readFileSync(new URL('../src/app/api/profile/route.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ allows \} from "@\/lib\/server\/access"/);
  assert.equal((source.match(/can_manage_users: allows\(auth\.principal, "manage_users"\)/g) || []).length, 3);
  assert.doesNotMatch(source, /roleAllows/);
});
