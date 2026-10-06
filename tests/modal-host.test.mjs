import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/GlobalModalHost.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('GlobalModalHost.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const modalHrefNode = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'modalHref');
assert.ok(modalHrefNode, 'modalHref must be declared');
const sameOriginNode = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'isSameOriginInternal');
assert.ok(sameOriginNode, 'isSameOriginInternal must be declared');

const exports = {};
vm.runInNewContext(ts.transpileModule(`${modalHrefNode.getText(ast)}\nexports.modalHref = modalHref;\n${sameOriginNode.getText(ast)}\nexports.isSameOriginInternal = isSameOriginInternal;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports,
  URL,
  window: { location: { origin: 'https://cmpri.example' } },
  crypto: { randomUUID: () => 'modal-token' },
});

test('work-order creation routes receive embedded modal context', () => {
  const result = exports.modalHref('/work-orders');
  const url = new URL(result.href, 'https://cmpri.example');
  assert.equal(url.pathname, '/work-orders');
  assert.equal(url.searchParams.get('embedded'), '1');
  assert.equal(url.searchParams.get('modalToken'), 'modal-token');
  assert.equal(result.modalToken, 'modal-token');
});

test('work-order detail and User Management routes retain modal context', () => {
  for (const path of ['/work-orders/wo-1', '/management/users']) {
    const result = exports.modalHref(path);
    assert.equal(new URL(result.href, 'https://cmpri.example').searchParams.get('embedded'), '1');
    assert.equal(result.modalToken, 'modal-token');
  }
});

test('dashboard action screens receive modal context while ordinary routes do not', () => {
  for (const path of [
    '/profile',
    '/engineering/room-ranker',
    '/engineering/preventive-maintenance',
    '/engineering/purchasing',
    '/engineering/gss',
    '/engineering/pool-log',
    '/engineering/room-operations',
    '/engineering/enseo-assignments',
    '/engineering/parts',
    '/engineering/import-work-orders',
    '/management/equipment',
    '/management/rooms',
  ]) {
    const result = exports.modalHref(path);
    assert.equal(new URL(result.href, 'https://cmpri.example').searchParams.get('embedded'), '1', path);
    assert.equal(result.modalToken, 'modal-token', path);
  }
  const result = exports.modalHref('/technician');
  assert.equal(result.href, '/technician');
  assert.equal(result.modalToken, undefined);
});

test('global navigation preserves standard modified-click gestures', () => {
  assert.match(source, /event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
});

test('create cancellation and completion messages dismiss the matching modal', () => {
  assert.match(source, /"cmpri-work-order-cancelled", "cmpri-work-order-created"/);
  assert.match(source, /event\.data\.modalToken !== top\.modalToken/);
});

test('profile sign-out carries the embedded modal token accepted by the host', () => {
  const profile = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  assert.match(profile, /const modalToken = new URLSearchParams\(window\.location\.search\)\.get\("modalToken"\) \|\| ""/);
  assert.match(profile, /type: "cmpri-modal-sign-out", modalToken/);
  assert.match(source, /if \(event\.data\.type === "cmpri-modal-sign-out"\)/);
});

test('inner embedded forms get first refusal on Escape before the host closes', () => {
  assert.match(source, /keyEvent\.defaultPrevented/);
  assert.match(source, /cmpri-modal-cancel-request/);
  assert.match(source, /const requestModalClose = useCallback\(\(entryId: string\)/);
  assert.match(source, /if \(frameDocument\.dispatchEvent\(cancelRequest\)\) closeModal\(entryId\)/);
  assert.match(source, /requestModalClose\(entry\.id\)/);
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const workOrder = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
  const createWorkOrder = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(dashboard, /cmpri-modal-cancel-request/);
  assert.match(workOrder, /document\.addEventListener\("cmpri-modal-cancel-request", handleModalCancelRequest\)/);
  assert.match(createWorkOrder, /document\.addEventListener\("cmpri-modal-cancel-request", handleModalCancelRequest\)/);
});

test('embedded pages keep their existing actions without an injected navigation toolbar', () => {
  assert.doesNotMatch(source, /aria-label=\{`Close \$\{entry\.title\}`\}/);
  assert.doesNotMatch(source, /pageHeader\.style\.display = "none"/);
  assert.doesNotMatch(source, /h-11 shrink-0 items-center justify-end border-b/);
  assert.doesNotMatch(source, /document\.createElement\("a"\)/);
  assert.match(source, /type: "cmpri-open-modal"/);
  assert.match(source, /openNestedModal\(href, deriveTitle\(target\)\)/);
});

test('global route modals scale down from their dashboard and retain usable mobile width', () => {
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(source, /className="cmpri-modal-shell cmpri-dashboard-overlay-panel/);
  assert.match(source, /const scale = 0\.9 \*\* \(index \+ 1\)/);
  assert.match(source, /"--cmpri-modal-width": `min\(\$\{66 \* scale\}vw, \$\{72 \* scale\}rem\)`/);
  assert.match(source, /"--cmpri-modal-mobile-width": `calc\(\$\{100 \* scale\}vw - \$\{16 \* scale\}px\)`/);
  assert.match(source, /"--cmpri-modal-height": `calc\(\$\{100 \* scale\}dvh - \$\{16 \* scale\}px\)`/);
  assert.match(source, /"--cmpri-modal-mobile-height": `calc\(\$\{100 \* scale\}dvh - \$\{16 \* scale\}px\)`/);
  assert.match(styles, /\.cmpri-dashboard-overlay-panel\s*\{\s*width: var\(--cmpri-modal-width, min\(66vw, 72rem\)\)/);
  assert.match(source, /cmpri-modal-shell cmpri-dashboard-overlay-panel cmpri-modal-frame/);
  assert.match(styles, /\.cmpri-modal-shell\.cmpri-modal-frame\s*\{\s*width: var\(--cmpri-modal-width, min\(66vw, 72rem\)\) !important/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.cmpri-modal-shell\.cmpri-modal-frame\s*\{\s*width: var\(--cmpri-modal-mobile-width, calc\(100vw - 1rem\)\) !important/);
  assert.match(styles, /\.cmpri-modal-shell\.cmpri-modal-frame\s*\{[\s\S]*?padding:\s*0 !important/);
});

test('embedded and standalone modals share typography and compact spacing tokens', () => {
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(styles, /--cmpri-text-body:\s*0\.875rem/);
  assert.match(styles, /--cmpri-text-body-line-height:\s*1\.45/);
  assert.match(styles, /--cmpri-panel-padding:\s*0\.5rem/);
  assert.match(styles, /--cmpri-modal-space-unit:\s*0\.125rem/);
  assert.match(styles, /--cmpri-modal-spacing:\s*0\.25rem/);
  assert.match(styles, /--cmpri-modal-type-scale:\s*0\.9/);
  assert.match(styles, /--cmpri-modal-line-height:\s*1\.3/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main,\s*\.cmpri-modal-shell\s*\{\s*--spacing:\s*var\(--cmpri-modal-space-unit\)/);
  assert.match(styles, /--text-xs:\s*calc\(0\.75rem \* var\(--cmpri-modal-type-scale\)\)/);
  assert.match(styles, /--text-4xl:\s*calc\(2\.25rem \* var\(--cmpri-modal-type-scale\)\)/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main,\s*\.cmpri-modal-shell\s*\{[\s\S]*?padding:\s*var\(--cmpri-modal-spacing\) !important/);
  assert.match(styles, /font-size:\s*calc\(var\(--cmpri-text-body\) \* var\(--cmpri-modal-type-scale\)\);\s*line-height:\s*var\(--cmpri-modal-line-height\)/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main :is\(input, select\),\s*\.cmpri-modal-shell :is\(input, select\)\s*\{\s*min-height:\s*1\.875rem !important/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main \*,\s*\.cmpri-modal-shell \*\s*\{\s*line-height:\s*var\(--cmpri-modal-line-height\) !important/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main :is\(input, select, textarea, button, \[role="button"\]\),\s*\.cmpri-modal-shell :is\(input, select, textarea, button, \[role="button"\]\)/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main \[class\*="text-\["\],\s*\.cmpri-modal-shell \[class\*="text-\["\]/);
  assert.match(styles, /\.cmpri-modal-backdrop\s*\{\s*box-sizing:\s*border-box;\s*padding:\s*var\(--cmpri-modal-spacing\) !important/);
  assert.match(styles, /html\[data-cmpri-embedded="true"\] section\[class\*="rounded"\]\[class\*="border"\],\s*\.cmpri-modal-shell section\[class\*="rounded"\]\[class\*="border"\]/);
  assert.match(styles, /padding:\s*calc\(var\(--spacing\) \* 2\) !important/);
  assert.doesNotMatch(styles, /class~="(?:p-3|p-4|p-5|p-6|mt-4|mt-5|mt-6|mb-4|mb-5|gap-3|gap-4|gap-5|space-y-4|space-y-5)"/);
  assert.match(styles, /\.cmpri-modal-shell\s*\{[\s\S]*?width:\s*min\(66vw,\s*72rem\) !important/);
});

test('embedded KPI cards use a shared compact metric size', () => {
  const styles = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(styles, /html\[data-cmpri-embedded="true"\] main \.cmpri-modal-kpi-value,\s*\.cmpri-modal-shell \.cmpri-modal-kpi-value\s*\{\s*font-size:\s*calc\(var\(--text-xl\) \* 0\.9\) !important/);
  for (const path of [
    '../src/app/engineering/room-operations/page.tsx',
    '../src/app/engineering/parts/page.tsx',
    '../src/app/engineering/purchasing/page.tsx',
    '../src/app/engineering/preventive-maintenance/page.tsx',
    '../src/app/engineering/gss/page.tsx',
  ]) {
    const page = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(page, /cmpri-modal-kpi-value/, `${path} KPI metrics must use shared modal sizing`);
  }
});

test('sign out from an embedded modal clears modal state and redirects the host', () => {
  assert.match(source, /event\.data\.type === "cmpri-modal-sign-out"/);
  assert.match(source, /event\.data\.type === "cmpri-modal-sign-out"\) \{\s*setStack\(\[\]\);\s*window\.location\.replace\("\/"\);/);
});

test('modal navigation accepts same-origin paths but rejects external, API, and asset paths', () => {
  for (const href of ['/engineering', '/profile', 'https://cmpri.example/work-orders']) {
    assert.equal(exports.isSameOriginInternal(href), true, href);
  }
  for (const href of ['https://evil.example', '//evil.example/path', '/api/session', '/_next/static/app.js', 'javascript:alert(1)']) {
    assert.equal(exports.isSameOriginInternal(href), false, href);
  }
});

test('only the top modal layer remains interactive while nested navigation opens a new layer', () => {
  assert.match(source, /setStack\(\(current\) => \[\.\.\.current, \{/);
  assert.match(source, /inert=\{!isTop\}/);
  assert.match(source, /pointerEvents: isTop \? "auto" : "none"/);
  assert.match(source, /element\.inert = true/);
  assert.match(source, /element\.inert = inert/);
  assert.match(source, /event\.source !== frameRefs\.current\.get\(top\.id\)\?\.contentWindow/);
});

test('related work orders open above the current modal rather than replacing it', () => {
  assert.match(source, /const related = modalHref\(`\/work-orders\/\$\{encodeURIComponent\(event\.data\.targetWorkOrderId\)\}`\);[\s\S]*?setStack\(\(current\) => \[\.\.\.current, \{/);
});

test('dashboard return works for tokenless modals and respects embedded cancel guards', () => {
  assert.match(source, /event\.data\.modalToken !== ""/);
  assert.match(source, /event\.data\.type === "cmpri-modal-dashboard"\) \{\s*setStack\(\[\]\)/);
  assert.match(source, /data-cmpri-modal-dashboard='true'/);
  assert.match(source, /if \(returnToDashboard\) \{\s*if \(stack\.length === 0\) return;\s*event\.preventDefault\(\);\s*setStack\(\[\]\)/);
  assert.match(source, /button\[data-cmpri-modal-dashboard='true'\]/);
  assert.match(source, /embeddedCleanupRefs\.current\.get\(entry\.id\)/);
});

test('standalone dashboard buttons keep their navigation when no modal is open', () => {
  const handlerStart = source.indexOf('const handleClick = (event: MouseEvent) =>');
  const handlerEnd = source.indexOf('const handleKeydown =', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /if \(isDashboardAction\) \{\s*if \(stack\.length === 0\) return;\s*event\.preventDefault\(\);\s*setStack\(\[\]\);\s*return;/);
});

test('dashboard return actions are omitted from embedded modal pages', () => {
  const dashboardLink = readFileSync(new URL('../src/components/ModalDashboardLink.tsx', import.meta.url), 'utf8');
  const workOrder = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(dashboardLink, /const embedded = useEmbeddedModal\(\);\s*if \(embedded\) return null;/);
  assert.match(workOrder, /\{!embedded && \(\s*<Link href="\/engineering"[\s\S]*?← Engineering Dashboard[\s\S]*?<\/Link>\s*\)\}/);
});

test('embedded navigation is handled by the parent host without opening a child-host modal', () => {
  const handlerStart = source.indexOf('const openNestedScreen = (navigationEvent: MouseEvent) =>');
  const handlerEnd = source.indexOf('document.addEventListener("click", openNestedScreen, true)', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(source.slice(handlerStart, handlerEnd), /navigationEvent\.preventDefault\(\);\s*navigationEvent\.stopPropagation\(\);/);
  assert.match(source, /const handleClick = \(event: MouseEvent\) => \{\s*if \(window\.parent !== window\) return;/);
  assert.match(source, /type: "cmpri-open-modal",\s*href: detail\.href,[\s\S]*?modalToken: new URLSearchParams\(window\.location\.search\)/);
});

test('dashboard action pages render without duplicate outer headers when embedded', () => {
  const pages = [
    '../src/app/engineering/room-ranker/page.tsx',
    '../src/app/engineering/preventive-maintenance/page.tsx',
    '../src/app/engineering/purchasing/page.tsx',
    '../src/app/engineering/gss/page.tsx',
    '../src/app/engineering/pool-log/page.tsx',
    '../src/app/engineering/enseo-assignments/page.tsx',
    '../src/app/engineering/parts/page.tsx',
    '../src/app/engineering/import-work-orders/page.tsx',
    '../src/app/management/rooms/page.tsx',
    '../src/app/management/equipment/page.tsx',
    '../src/app/management/users/page.tsx',
    '../src/app/profile/page.tsx',
  ];
  for (const path of pages) {
    const page = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(page, /useEmbeddedModal/, `${path} detects embedded rendering`);
  }

  const users = readFileSync(new URL('../src/app/management/users/page.tsx', import.meta.url), 'utf8');
  assert.match(users, /users\.filter\(\(u\) => u\.active === true\)\.length[\s\S]*?ModalDashboardLink/);
  const equipment = readFileSync(new URL('../src/app/management/equipment/page.tsx', import.meta.url), 'utf8');
  assert.match(equipment, /\{!embedded && <header/);
  const profile = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  assert.match(profile, /<ModalDashboardLink href=\{profileDashboardHref\}/);
  assert.match(profile, /\{!isSubmitOnlyProfile && <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">[\s\S]*?ChatGPT Connection/);
  assert.match(profile, /<section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">/);
});

test('temporary user passwords are masked and excluded from normal autocomplete', () => {
  const users = readFileSync(new URL('../src/app/management/users/page.tsx', import.meta.url), 'utf8');
  assert.match(users, /type="password" autoComplete="new-password" aria-label="Temporary password"/);
});

test('Engineering Dashboard screen-launch controls are real buttons that open desktop windows', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const launchers = dashboard.slice(dashboard.indexOf('const launcherGroups'), dashboard.indexOf('function launch('));
  const navigation = dashboard.slice(dashboard.indexOf('<nav aria-label="Open dashboard windows"'), dashboard.indexOf('</nav>'));
  const routes = [
    '/engineering/room-ranker',
    '/engineering/preventive-maintenance',
    '/engineering/purchasing',
    '/engineering/gss',
    '/engineering/pool-log',
    '/engineering/room-operations',
    '/management/equipment',
    '/engineering/enseo-assignments',
    '/engineering/parts',
    '/engineering/import-work-orders',
    '/management/rooms',
    '/management/users',
    '/profile',
  ];
  for (const route of routes) {
    assert.match(launchers, new RegExp(`href: "${route.replaceAll('/', '\\/')}"`));
  }
  assert.match(dashboard, /function DashboardLauncherButton[\s\S]*?<button[\s\S]*?data-cmpri-desktop-launch=\{launcher\.key\}/);
  assert.match(dashboard, /const visibleLauncherGroups = launcherGroups[\s\S]*?group\.items\.filter\(\(item\): item is Launcher => Boolean\(item\)\)[\s\S]*?group\.items\.length > 0/);
  assert.match(navigation, /visibleLauncherGroups\.map\(\(group\) => \([\s\S]*?group\.items\.map\(\(launcher\) => \([\s\S]*?<DashboardLauncherButton/);
  assert.match(launchers, /hasCapability\(session, "(?:view_dashboard|submit|edit_tickets|manage_assets|manage_rooms|manage_users|review_feedback|view_profiles)"\)/);
  assert.doesNotMatch(navigation, /<a\b|data-cmpri-modal-trigger/);
  assert.match(dashboard, /onClick=\{\(\) => onLaunch\(launcher, Date\.now\(\)\)\}/);
});

test('shared modal navigation controls render buttons instead of links', () => {
  const navigationButton = readFileSync(new URL('../src/components/ModalNavigationButton.tsx', import.meta.url), 'utf8');
  assert.match(navigationButton, /<button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href=\{href\}/);
  assert.doesNotMatch(navigationButton, /<a\b|<Link\b/);
  const routes = [
    '../src/app/profile/page.tsx',
    '../src/app/management/rooms/page.tsx',
    '../src/app/engineering/room-operations/page.tsx',
    '../src/app/engineering/purchasing/page.tsx',
    '../src/app/engineering/import-work-orders/page.tsx',
    '../src/app/work-orders/page.tsx',
  ];
  for (const route of routes) {
    const page = readFileSync(new URL(route, import.meta.url), 'utf8');
    assert.doesNotMatch(page, /<a\b|<Link\b/, `${route} must use buttons for actions`);
  }
});

test('room operations import form and commit workflow live in the Daily Room Operations modal', () => {
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/app/engineering/room-operations/page.tsx', import.meta.url), 'utf8');
  const importer = readFileSync(new URL('../src/app/engineering/room-operations/RoomOperationsImport.tsx', import.meta.url), 'utf8');
  assert.match(page, /importOpen && hasCapability\(session, "edit_tickets"\)/);
  assert.match(page, /<RoomOperationsImport date=\{date\} onDateChange=\{setDate\} onCommitted=\{handleImportCommitted\}/);
  assert.doesNotMatch(dashboard, /Import Room Ops|showRoomOpsImport|Import Daily Room Operations/);
  assert.match(importer, /Upload today(?:&apos;|')s Room Status Report and Expected Departures/);
  assert.match(importer, /Expected Departures/);
  assert.match(importer, /11:00 AM/);
  assert.doesNotMatch(importer, /Import Photo \/ Screenshot|AI import/i);
  assert.match(importer, /Validated preview/);
  assert.match(importer, /async function commitImport/);
  assert.match(importer, /snapshotMatches/);
});