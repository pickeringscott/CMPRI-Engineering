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

test('ordinary internal routes are not marked as embedded modals', () => {
  const result = exports.modalHref('/profile');
  assert.equal(result.href, '/profile');
  assert.equal(result.modalToken, undefined);
});

test('global navigation preserves standard modified-click gestures', () => {
  assert.match(source, /event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
});

test('create cancellation and completion messages dismiss the matching modal', () => {
  assert.match(source, /"cmpri-work-order-cancelled", "cmpri-work-order-created"/);
  assert.match(source, /event\.data\.modalToken !== top\.modalToken/);
});

test('inner embedded forms get first refusal on Escape before the host closes', () => {
  assert.match(source, /keyEvent\.defaultPrevented/);
  assert.match(source, /cmpri-modal-cancel-request/);
  assert.match(source, /function requestModalClose\(entryId: string\)/);
  assert.match(source, /if \(frameDocument\.dispatchEvent\(cancelRequest\)\) closeModal\(entryId\)/);
  assert.match(source, /requestModalClose\(entry\.id\)/);
  const dashboard = readFileSync(new URL('../src/app/engineering/page.tsx', import.meta.url), 'utf8');
  const workOrder = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
  const createWorkOrder = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(dashboard, /cmpri-modal-cancel-request/);
  assert.match(workOrder, /document\.addEventListener\("cmpri-modal-cancel-request", handleModalCancelRequest\)/);
  assert.match(createWorkOrder, /document\.addEventListener\("cmpri-modal-cancel-request", handleModalCancelRequest\)/);
});

test('embedded page actions remain visible without a duplicate close toolbar or divider', () => {
  assert.doesNotMatch(source, /aria-label=\{`Close \$\{entry\.title\}`\}/);
  assert.doesNotMatch(source, /pageHeader\.style\.display = "none"/);
  assert.doesNotMatch(source, /h-11 shrink-0 items-center justify-end border-b/);
  assert.match(source, /a\[href='\/engineering'\]/);
});

test('modal shell leaves 15px clearance from the viewport edges', () => {
  assert.match(source, /p-\[15px\]/);
  assert.match(source, /calc\(100vw - 30px\)/);
  assert.match(source, /calc\(100dvh - 30px\)/);
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

test('dashboard return works for tokenless modals and respects embedded cancel guards', () => {
  assert.match(source, /const closeToDashboard = \(\) => requestModalClose\(entry\.id\)/);
  assert.match(source, /event\.data\.modalToken !== ""/);
  assert.match(source, /event\.data\.type === "cmpri-modal-dashboard"\) \{\s*requestModalClose\(top\.id\)/);
  assert.match(source, /embeddedCleanupRefs\.current\.get\(entry\.id\)/);
});