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

test('list remains available and selecting open tickets raises the requested window', () => {
  const actions = [];
  const tickets = [{ key: '/work-orders/a', title: 'WO#123 · Room 101' }, { key: '/work-orders/b', title: 'WO#456 · Room 102' }];
  const props = { tickets, activeKey: '/management/equipment', listKey: 'work-order-list', onOpenList: () => actions.push('list'), onRaise: key => actions.push(key) };
  const tree = exports.default(props);
  const list = find(tree, 'button'), select = find(tree, 'select');
  assert.equal(tree.props['aria-label'], 'Work order windows');
  assert.equal(select.props['aria-label'], 'Switch open work order');
  assert.equal(select.props.value, '');
  assert.equal(list.props['aria-pressed'], false);
  list.props.onClick();
  select.props.onChange({ target: { value: '/work-orders/b' } });
  assert.deepEqual(actions, ['list', '/work-orders/b']);
  assert.deepEqual(tickets.map(ticket => ticket.key), ['/work-orders/a', '/work-orders/b']);
  assert.equal(find(exports.default({ ...props, activeKey: '/work-orders/a' }), 'select').props.value, '/work-orders/a');
  assert.equal(find(exports.default({ ...props, activeKey: 'work-order-list' }), 'button').props['aria-pressed'], true);
});

test('list is available even before a ticket is open', () => {
  const tree = exports.default({ tickets: [], activeKey: '/profile', listKey: 'work-order-list', onOpenList() {}, onRaise() {} });
  assert.ok(find(tree, 'button'));
  assert.equal(find(tree, 'select'), undefined);
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
