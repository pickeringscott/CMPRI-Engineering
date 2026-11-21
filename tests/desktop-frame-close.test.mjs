import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { isDesktopRoute } from '../src/lib/ui/desktop-windows.ts';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://cmpri.test/engineering', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const frameGlobals = { exports: {}, window, document, URL, require(name) {
  if (['react', 'react/jsx-runtime'].includes(name)) return require(name);
    if (name === '@/components/UiLanguageProvider') return {useUiLanguage:()=>({language:'en', locale:'en-US', t:(text,values={})=>text.replace(/\{(\w+)\}/g,(token,key)=>Object.hasOwn(values,key)?String(values[key]):token), tt:text=>text})};
  if (name === '@/lib/ui/desktop-windows') return { isDesktopRoute };
  throw Error('Unexpected import ' + name);
} };
vm.runInNewContext(compile(readFileSync('src/components/desktop/DesktopFrame.tsx', 'utf8')), frameGlobals);
const Component = frameGlobals.exports.default;
const source = readFileSync('src/app/engineering/page.tsx', 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variables = new Map(), returns = [];
function walk(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node);
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onReturnToDesktop') returns.push(node.initializer.expression);
  ts.forEachChild(node, walk);
}
walk(ast);
assert.equal(returns.length, 2, 'both normal and cached frame callbacks must stay guarded');
const requestExpression = variables.get('requestCloseWindow').initializer.arguments[0].getText(ast);
const messageExpression = variables.get('handleWindowMessage').initializer.getText(ast);

function host(returnExpression) {
  let closes = 0;
  const frames = new Map();
  const entry = { key: '/profile' };
  const globals = { exports: {}, window, URL, Event: dom.window.Event, entry, frameRefs: { current: frames }, closeWindow(key) {
    assert.equal(key, entry.key); closes++;
  } };
  vm.runInNewContext(compile(`const requestCloseWindow = ${requestExpression};
    exports.onReturnToDesktop = ${returnExpression};
    exports.message = ${messageExpression};`), globals);
  return { frames, callbacks: globals.exports, closes: () => closes };
}

test('desktop embedded return buttons, links, and history all wait for save acknowledgment', async () => {
  for (const expression of returns) for (const action of ['button', 'link', 'push', 'replace']) {
    const harness = host(expression.getText(ast));
    const root = createRoot(document.getElementById('root'));
    let opened = 0, requests = 0;
    try {
      await React.act(async () => root.render(React.createElement(Component, {
        src: '/profile?embedded=1&modalToken=fixture-token', title: 'Profile',
        registerFrame: frame => { if (frame) harness.frames.set('/profile', frame); },
        onFocus() {}, onOpen() { opened++; }, onReturnToDesktop: harness.callbacks.onReturnToDesktop,
      })));
      const frame = document.querySelector('iframe');
      frame.contentDocument.open(); frame.contentDocument.write('<!doctype html><body></body>'); frame.contentDocument.close();
      await React.act(async () => frame.dispatchEvent(new dom.window.Event('load')));
      frame.contentDocument.addEventListener('cmpri-modal-cancel-request', event => { requests++; event.preventDefault(); });
      if (action === 'push' || action === 'replace') {
        frame.contentWindow.history[action + 'State']({}, '', '/front-desk');
      } else {
        frame.contentDocument.body.innerHTML = action === 'button'
          ? '<button data-cmpri-modal-dashboard="true">Return</button>' : '<a href="/front-desk">Return</a>';
        frame.contentDocument.body.firstElementChild.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      assert.equal(requests, 1, action);
      assert.equal(harness.closes(), 0, action);
      assert.equal(opened, 0, action);
      harness.callbacks.message({ origin: window.location.origin, source: frame.contentWindow, data: { type: 'cmpri-modal-close' } });
      assert.equal(harness.closes(), 1, action);
      assert.equal(requests, 1, 'a saved close acknowledgment cannot ask the editor to save again');
    } finally { await React.act(async () => root.unmount()); }
  }
});

test('desktop dashboard messages use the guard while close acknowledgments bypass it', () => {
  const harness = host(returns[0].getText(ast));
  const frameDocument = new dom.window.Document();
  const source = {};
  harness.frames.set('/profile', { contentDocument: frameDocument, contentWindow: source });
  let requests = 0;
  frameDocument.addEventListener('cmpri-modal-cancel-request', event => { requests++; event.preventDefault(); });
  harness.callbacks.message({ origin: window.location.origin, source, data: { type: 'cmpri-modal-dashboard' } });
  assert.equal(requests, 1);
  assert.equal(harness.closes(), 0);
  harness.callbacks.message({ origin: window.location.origin, source, data: { type: 'cmpri-modal-close' } });
  assert.equal(requests, 1);
  assert.equal(harness.closes(), 1);
});

test.after(() => dom.window.close());
