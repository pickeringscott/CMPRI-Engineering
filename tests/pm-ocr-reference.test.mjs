import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/app/engineering/preventive-maintenance/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const options = { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 };
const jsx = (type, props) => ({ type, props: props || {} });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' };
function find(node, predicate) {
  if (node && typeof node === 'object') {
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
}

test('PM document reader stays closed until requested and never changes the form', () => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'PmOcrReference');
  assert.ok(declaration, 'PM reader wrapper exists');
  const code = ts.transpileModule(`${declaration.getText(ast)}\nexports.render = PmOcrReference;`, { compilerOptions: options }).outputText;
  let open = false;
  const reader = Symbol('LocalOcrReview');
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    useState: () => [open, change => { open = typeof change === 'function' ? change(open) : change; }],
    LocalOcrReview: reader,
    require: name => { if (name === 'react/jsx-runtime') return jsxRuntime; throw new Error(`Unexpected dependency ${name}`); },
  });
  let tree = exports.render();
  let button = find(tree, node => node.type === 'button');
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(find(tree, node => node.type === reader), undefined, 'no OCR component mounts before a user asks');
  button.props.onClick();
  tree = exports.render();
  button = find(tree, node => node.type === 'button');
  const review = find(tree, node => node.type === reader);
  assert.equal(button.props['aria-expanded'], true);
  assert.ok(review, 'reader mounts only after opening');
  assert.equal(review.props.onUseText, undefined, 'recognized text cannot automatically update the PM form');
  assert.match(JSON.stringify(tree), /does not save, complete, or approve a PM record/);
  button.props.onClick();
  tree = exports.render();
  assert.equal(find(tree, node => node.type === reader), undefined, 'closing unmounts the reader and its transient document');
});

test('only an editable PM form exposes its document reader', () => {
  let expression;
  function visit(node) {
    if (ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression)
      && node.expression.left.getText(ast) === 'activeCanEdit'
      && ts.isJsxSelfClosingElement(node.expression.right)
      && node.expression.right.tagName.getText(ast) === 'PmOcrReference') expression = node.expression.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, 'reader must be gated by the existing form edit permission');
  const code = ts.transpileModule(`exports.render = activeCanEdit => (${expression});`, { compilerOptions: options }).outputText;
  const exports = {}, reader = Symbol('PmOcrReference');
  vm.runInNewContext(code, { exports, PmOcrReference: reader, require: name => { if (name === 'react/jsx-runtime') return jsxRuntime; throw new Error(name); } });
  assert.equal(exports.render(false), false);
  assert.equal(exports.render(true).type, reader);
});
