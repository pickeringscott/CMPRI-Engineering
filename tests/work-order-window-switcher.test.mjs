import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync('src/components/desktop/WorkOrderWindowSwitcher.tsx', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
const jsx = (type, props) => ({ type, props });
vm.runInNewContext(code, { exports, require(name) {
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  throw new Error(`Unexpected import: ${name}`);
} });

function find(node, type) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, type);
    if (found) return found;
  }
}

test('the switcher raises open tickets without adding another list button', () => {
  const actions = [];
  const tickets = [{ key: '/work-orders/a', title: 'WO#123 · Room 101' }, { key: '/work-orders/b', title: 'WO#456 · Room 102' }];
  const props = { tickets, activeKey: '/management/equipment', onRaise: key => actions.push(key) };
  const tree = exports.default(props);
  const select = find(tree, 'select');
  assert.equal(tree.props['aria-label'], 'Work order windows');
  assert.equal(select.props['aria-label'], 'Switch open work order');
  assert.equal(select.props.value, '');
  assert.equal(find(tree, 'button'), undefined);
  select.props.onChange({ target: { value: '/work-orders/b' } });
  assert.deepEqual(actions, ['/work-orders/b']);
  assert.deepEqual(tickets.map(ticket => ticket.key), ['/work-orders/a', '/work-orders/b']);
  assert.equal(find(exports.default({ ...props, activeKey: '/work-orders/a' }), 'select').props.value, '/work-orders/a');
});

test('no extra switcher occupies the header before a ticket is open', () => {
  const tree = exports.default({ tickets: [], activeKey: '/profile', onRaise() {} });
  assert.equal(tree, null);
});

test('the existing list menu raises a background list and retains active quick-toggle behavior', () => {
  const page = readFileSync('src/app/engineering/page.tsx', 'utf8');
  const ast = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let method = '';
  function findMethod(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'launchWindow') method = node.getText(ast); ts.forEachChild(node, findMethod); }
  findMethod(ast);
  assert.ok(method);
  const code = ts.transpileModule(`${method}\nexports.launch = launchWindow;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [];
  const context = { exports: {}, WORK_ORDER_LIST_KEY: 'work-order-list', zOrder: ['work-order-list', '/staff-notes'], windowOpenedAtRef: { current: new Map([['work-order-list', 100]]) }, windowsRef: { current: [{ key: 'work-order-list' }] }, LAUNCHER_CLOSE_WINDOW_MS: 5000, requestCloseWindow: key => calls.push(`close ${key}`) };
  vm.runInNewContext(code, context);
  context.exports.launch('work-order-list', 101, () => calls.push('raise'));
  context.zOrder = ['/staff-notes', 'work-order-list'];
  context.exports.launch('work-order-list', 102, () => calls.push('raise'));
  assert.deepEqual(calls, ['raise', 'close work-order-list']);
});

test('the cap and activation are shared synchronously across same-origin hosts', () => {
  const code = ts.transpileModule(readFileSync('src/lib/open-work-orders.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const top = { location: { origin: 'https://example.test' } };
  const host = () => {
    const exports = {};
    vm.runInNewContext(code, { exports, window: { top, location: { origin: 'https://example.test' } } });
    return exports;
  };
  const desktop = host(), modal = host(), raised = [];
  for (let i = 1; i <= 5; i++) assert.equal((i % 2 ? desktop : modal).claimWorkOrder(String(i), i % 2 ? 'desktop' : 'modal', () => raised.push(i)), 'claimed');
  assert.equal(modal.claimWorkOrder('6', 'modal', () => {}), 'limit');
  assert.equal(modal.claimWorkOrder('1', 'modal', () => {}), 'existing');
  assert.deepEqual(raised, [1]);
  modal.releaseWorkOrder('1', 'modal');
  assert.equal(modal.claimWorkOrder('6', 'modal', () => {}), 'limit', 'another host cannot release the owner’s ticket');
  desktop.releaseWorkOrder('1', 'desktop');
  assert.equal(modal.claimWorkOrder('6', 'modal', () => {}), 'claimed');
});
