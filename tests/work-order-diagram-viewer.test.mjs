import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://cmpri.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const require = createRequire(import.meta.url);
Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
const source = readFileSync(new URL('../src/components/WorkOrderDiagramViewer.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

async function fixture() {
  const observers = [];
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const exports = {};
  vm.runInNewContext(compiled, { exports, document, window, HTMLElement, ResizeObserver, require: name => require(name) });
  const opener = document.createElement('button'); opener.textContent = 'Open diagram'; document.body.appendChild(opener); opener.focus();
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  let closed = 0, props = { imageUrl: 'blob:approved-diagram-a', title: 'Wiring diagram', onClose: () => { closed++; } };
  const render = async next => { props = { ...props, ...next }; await React.act(async () => root.render(React.createElement(exports.default, props))); };
  await render();
  const viewport = host.querySelector('[data-diagram-viewport]');
  const captures = new Set();
  viewport.getBoundingClientRect = () => ({ left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400 });
  viewport.setPointerCapture = id => captures.add(id);
  viewport.hasPointerCapture = id => captures.has(id);
  viewport.releasePointerCapture = id => captures.delete(id);
  const image = () => host.querySelector('[data-diagram-image]');
  const load = async () => {
    Object.defineProperties(image(), { offsetWidth: { configurable: true, get: () => 400 }, offsetHeight: { configurable: true, get: () => 300 } });
    await React.act(async () => image().dispatchEvent(new dom.window.Event('load', { bubbles: false })));
  };
  const click = async label => React.act(async () => host.querySelector(`[aria-label="${label}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const pointer = async (type, id, x, y) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    await React.act(async () => viewport.dispatchEvent(event));
    return event;
  };
  const view = () => ({ scale: Number(viewport.dataset.diagramScale), x: Number(viewport.dataset.diagramX), y: Number(viewport.dataset.diagramY) });
  let returnedFocus = false;
  const dispose = async () => { await React.act(async () => root.unmount()); returnedFocus = document.activeElement === opener; host.remove(); opener.remove(); };
  return { host, viewport, image, opener, captures, observers, render, load, click, pointer, view, dispose, closed: () => closed, returnedFocus: () => returnedFocus };
}

test('native dialog focuses Close, exposes accessible zoom controls and restores opener focus', async () => {
  const h = await fixture();
  try {
    const dialog = h.host.querySelector('dialog');
    assert.equal(dialog.open, true);
    assert.equal(dialog.getAttribute('aria-label'), 'Wiring diagram');
    assert.ok(dialog.getAttribute('style').includes('--cmpri-modal-surface'));
    assert.ok(dialog.getAttribute('style').includes('--cmpri-modal-text'));
    assert.ok(h.viewport.getAttribute('style').includes('--cmpri-modal-surface'));
    assert.ok(h.host.querySelector('[aria-label="Zoom in"]').getAttribute('style').includes('--cmpri-action-rgb'));
    assert.equal(document.activeElement.getAttribute('aria-label'), 'Close diagram');
    assert.equal(h.host.querySelector('[aria-label="Zoom in"]').disabled, true, 'unloaded image cannot be zoomed');
    await h.load();
    await h.click('Zoom in');
    assert.deepEqual(h.view(), { scale: 1.5, x: 0, y: 0 });
    await h.click('Zoom out');
    assert.equal(h.view().scale, 1);
    await React.act(async () => h.host.querySelector('[aria-label="Close diagram"]').click());
    assert.equal(h.closed(), 1);
    await React.act(async () => h.host.querySelector('dialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true, bubbles: true })));
    assert.equal(h.closed(), 2);
    await React.act(async () => h.host.querySelector('dialog').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(h.closed(), 3);
  } finally { await h.dispose(); }
  assert.equal(h.returnedFocus(), true);
});

test('Escape and native cancel do not reach the surrounding work-order close handler', async () => {
  const h = await fixture();
  let outerEscapes = 0, outerCancels = 0;
  const key = event => { if (event.key === 'Escape') outerEscapes++; };
  const cancel = () => { outerCancels++; };
  document.addEventListener('keydown', key); document.addEventListener('cancel', cancel);
  try {
    const dialog = h.host.querySelector('dialog');
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const cancellation = new dom.window.Event('cancel', { bubbles: true, cancelable: true });
    await React.act(async () => dialog.dispatchEvent(escape));
    await React.act(async () => dialog.dispatchEvent(cancellation));
    assert.equal(escape.defaultPrevented, true);
    assert.equal(cancellation.defaultPrevented, true);
    assert.equal(outerEscapes, 0);
    assert.equal(outerCancels, 0);
    assert.equal(h.closed(), 2);
  } finally { document.removeEventListener('keydown', key); document.removeEventListener('cancel', cancel); await h.dispose(); }
});

test('a moving two-pointer pinch preserves its image anchor and transitions into one-pointer pan', async () => {
  const h = await fixture();
  try {
    await h.load();
    await h.pointer('pointerdown', 1, 325, 250);
    await h.pointer('pointerdown', 2, 375, 250);
    await h.pointer('pointermove', 1, 300, 250);
    await h.pointer('pointermove', 2, 400, 250);
    assert.deepEqual(h.view(), { scale: 2, x: -50, y: 0 }, 'the image point under midpoint x=350 stays fixed');
    await h.pointer('pointermove', 1, 320, 270);
    await h.pointer('pointermove', 2, 420, 270);
    assert.deepEqual(h.view(), { scale: 2, x: -30, y: 20 }, 'moving the pinch midpoint pans the same image point');
    await h.pointer('pointerup', 2, 420, 270);
    await h.pointer('pointermove', 1, 350, 280);
    assert.deepEqual(h.view(), { scale: 2, x: 0, y: 30 }, 'remaining finger starts from the confirmed pinch position');
    assert.equal(h.captures.has(1), true);
  } finally { await h.dispose(); }
});

test('pan and pinch stay within the image edges and scale range one through six', async () => {
  const h = await fixture();
  try {
    await h.load();
    await h.pointer('pointerdown', 1, 250, 250); await h.pointer('pointerdown', 2, 350, 250);
    await h.pointer('pointermove', 1, -500, 250); await h.pointer('pointermove', 2, 1100, 250);
    assert.equal(h.view().scale, 6);
    await h.pointer('pointerup', 2, 1100, 250);
    await h.pointer('pointermove', 1, 10000, 10000);
    assert.deepEqual(h.view(), { scale: 6, x: 1000, y: 750 });
    await h.click('Reset zoom');
    assert.deepEqual(h.view(), { scale: 1, x: 0, y: 0 });
    assert.equal(h.captures.size, 0);
    await h.pointer('pointerdown', 1, 300, 250); await h.pointer('pointermove', 1, 500, 400);
    assert.deepEqual(h.view(), { scale: 1, x: 0, y: 0 }, 'fitted image cannot be dragged into blank space');
    assert.equal(h.viewport.style.touchAction, 'none');
    assert.equal(document.documentElement.style.getPropertyValue('touch-action'), '');
    const browserZoom = new dom.window.KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true });
    await React.act(async () => h.viewport.dispatchEvent(browserZoom));
    assert.equal(browserZoom.defaultPrevented, false, 'standard browser zoom remains available');
    assert.equal(h.view().scale, 1);
  } finally { await h.dispose(); }
});

test('changing image source resets zoom and pointer capture, and ignores late old-pointer movement', async () => {
  const h = await fixture();
  try {
    await h.load(); await h.click('Zoom in');
    await h.pointer('pointerdown', 7, 300, 250); await h.pointer('pointermove', 7, 340, 280);
    assert.equal(h.captures.has(7), true);
    await h.render({ imageUrl: 'blob:approved-diagram-b', title: 'Replacement diagram' });
    assert.deepEqual(h.view(), { scale: 1, x: 0, y: 0 });
    assert.equal(h.captures.size, 0);
    assert.equal(h.host.querySelector('dialog').getAttribute('aria-label'), 'Replacement diagram');
    await h.load(); await h.pointer('pointermove', 7, 450, 350);
    assert.deepEqual(h.view(), { scale: 1, x: 0, y: 0 });
    assert.equal(h.observers[0].disconnected, true);
  } finally { await h.dispose(); }
});

test('pointer cancellation, viewport resize and keyboard reset leave a usable bounded viewer', async () => {
  const h = await fixture();
  try {
    await h.load(); await h.click('Zoom in');
    await h.pointer('pointerdown', 1, 300, 250); await h.pointer('pointermove', 1, 350, 300);
    await h.pointer('pointercancel', 1, 350, 300); await h.pointer('pointermove', 1, 0, 0);
    assert.deepEqual(h.view(), { scale: 1.5, x: 50, y: 50 });
    assert.equal(h.captures.size, 0);
    h.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    await React.act(async () => h.observers.at(-1).callback());
    assert.deepEqual(h.view(), { scale: 1.5, x: 0, y: 0 });
    await React.act(async () => h.viewport.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true })));
    assert.deepEqual(h.view(), { scale: 1, x: 0, y: 0 });
  } finally { await h.dispose(); }
});
