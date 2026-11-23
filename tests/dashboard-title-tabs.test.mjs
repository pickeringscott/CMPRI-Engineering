import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";
import * as titleTabs from "../src/lib/ui/dashboard-title-tabs.js";

const names = ["Daily Work", "Rooms & Reports", "Safety & Logs", "Assets & Inventory", "Account", "Admin"];
const saved = { "Daily Work": 0, "Rooms & Reports": 132, "Assets & Inventory": 246, "Safety & Logs": 343, Admin: 796, Account: 890 };
const naturalWidths = { "Daily Work": 94, "Rooms & Reports": 108, "Safety & Logs": 93, "Assets & Inventory": 125.1, Account: 65, Admin: 55, "Ask CMPRI": 76 };
const translations = { "Daily Work": "Trabajo diario", "Rooms & Reports": "Habitaciones e informes", "Safety & Logs": "Seguridad y registros", "Assets & Inventory": "Activos e inventario", Account: "Cuenta", Admin: "Administración", "Ask CMPRI": "Pregunte a CMPRI" };
const plain = value => JSON.parse(JSON.stringify(value));

/** Actual native/Ask modules with CSS-pixel geometry for their existing rail styles. */
function fixture({ width = 996, positions = saved, ask = true, insetNoise = 0, collapsed = names, tabWidths = {}, canDrop } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><header class="cmpri-dashboard-titlebar"><div class="cmpri-header-shelf"></div><nav class="cmpri-dashboard-menu-rail"><div class="cmpri-header-v23 anchored-menu"></div></nav></header></body></html>', { url: "https://cmpri.invalid/engineering" });
  const { window } = dom, { document } = window;
  const root = document.querySelector('.anchored-menu'), rail = document.querySelector('nav');
  const saves = [], resizeObservers = [], timers = new Map(), frames = new Map(), captures = new WeakMap(), queries = [];
  let counter = 0, now = 100, scroll = 0, observerPasses = 0, boxReads = 0, hitTarget = null;
  document.elementFromPoint = () => hitTarget;
  const intrinsicWidths = {}, titleScales = {};
  const rect = (left = 0, top = 80, w = width, height = 16) => ({ x: left, y: top, left, top, width: w, height, right: left + w, bottom: top + height, toJSON() { return { left, top, width: w, height }; } });
  const numeric = (value, fallback = 0) => Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback;
  const isAsk = node => node.hasAttribute('data-ask-launcher-tab');
  const groupInset = field => field.classList.contains('collapsed') ? 15 : 14;
  const groupBorder = field => field.classList.contains('collapsed') ? 0 : 1;
  const labelWidth = title => numeric(title.style.width, intrinsicWidths[title.parentElement.dataset.layoutLabel] ?? naturalWidths[title.textContent] ?? title.textContent.length * 6 + 12);
  const rowWidth = () => Math.max(width, numeric(root.querySelector('.anchored-groups')?.style.minWidth));
  const noise = () => insetNoise ? insetNoise + (++boxReads % 2) * 0.0000001 : 0;
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('anchored-groups')) return rect(-scroll, 80, rowWidth(), numeric(this.style.height, 16));
    if (this.tagName === 'FIELDSET') return rect(numeric(this.style.left) - scroll, 95, this.classList.contains('collapsed') ? 0 : numeric(this.style.width), this.classList.contains('collapsed') ? 0 : 26);
    if (this.tagName === 'LEGEND') {
      const field = this.parentElement, origin = field.getBoundingClientRect();
      if (isAsk(field) && width < 701) return rect(origin.left, 80, 0, 0);
      const scale = titleScales[field.dataset.layoutLabel] ?? 1, size = labelWidth(this);
      return rect(origin.left + groupInset(field) + groupBorder(field) + noise() + size * (1 - scale) / 2, 80, size * scale, 15);
    }
    if (this.classList.contains('tab-resize-edge')) {
      const field = this.parentElement, origin = field.getBoundingClientRect();
      return rect(origin.left + groupBorder(field) + numeric(this.style.left) + noise(), 80, 6, 15);
    }
    if (this.classList.contains('resize-edge')) {
      const field = this.parentElement.getBoundingClientRect(); return rect(field.right - 3, 95, 6, 26);
    }
    if (this.classList.contains('buttons')) {
      const field = this.parentElement.getBoundingClientRect(); return rect(field.left + 3, 97, Math.max(0, field.width - 6), 21);
    }
    if (this.classList.contains('action')) {
      const row = this.parentElement;
      const bounds = row.getBoundingClientRect();
      return rect(bounds.left + [...row.children].indexOf(this) * 153 - row.scrollLeft, bounds.top, 150, 21);
    }
    if (this.classList.contains('desktop-ask-search')) return rect(numeric(this.style.left), numeric(this.style.top, 95), numeric(this.style.width, 130), 24);
    if (this.tagName === 'BUTTON') return rect(0, 0, 20, 20);
    if (this.hidden) return rect(0, 0, 0, 0);
    return rect(0, 80, width, this === rail ? 14 : 60);
  };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { get() { return Math.round(this.tagName === 'LEGEND' ? labelWidth(this) : this.getBoundingClientRect().width); } },
    offsetHeight: { get() { return Math.round(this.getBoundingClientRect().height); } },
    offsetTop: { get() { return this.tagName === 'FIELDSET' ? 15 : 0; } },
    offsetLeft: { get() { return this.tagName === 'LEGEND' ? groupInset(this.parentElement) : numeric(this.style.left); } },
    clientLeft: { get() { return this.tagName === 'FIELDSET' ? groupBorder(this) : 0; } },
    clientWidth: { get() { return this === root || this === rail ? width : this.classList.contains('anchored-groups') ? rowWidth() : Math.max(0, this.getBoundingClientRect().width - this.clientLeft * 2); } },
    clientHeight: { get() { return this.getBoundingClientRect().height; } },
    scrollWidth: { get() { return this === root ? rowWidth() : this.classList.contains('buttons') ? 456 : this.clientWidth; } },
    scrollHeight: { get() { return 20; } },
  });
  Object.defineProperty(root, 'scrollLeft', { get: () => scroll, set: value => { scroll = Math.max(0, Math.min(value, rowWidth() - width)); } });
  Object.defineProperty(document.documentElement, 'clientWidth', { get: () => width });
  window.HTMLElement.prototype.setPointerCapture = function (id) { captures.set(this, id); };
  window.HTMLElement.prototype.hasPointerCapture = function (id) { return captures.get(this) === id; };
  window.HTMLElement.prototype.releasePointerCapture = function () { captures.delete(this); };
  window.HTMLElement.prototype.getAnimations = () => [];
  window.HTMLElement.prototype.animate = () => ({ cancel() {} });
  window.Range.prototype.getBoundingClientRect = function () { return this.commonAncestorContainer.getBoundingClientRect(); };
  window.setTimeout = callback => { timers.set(++counter, callback); return counter; };
  window.clearTimeout = id => timers.delete(id);
  const selectAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => selectAll(selector === 'dialog:modal' ? 'dialog[open]' : selector);
  const closest = window.Element.prototype.closest;
  window.Element.prototype.closest = function (selector) { return closest.call(this, selector === 'dialog:modal' ? 'dialog[open]' : selector); };
  const matchMedia = query => {
    const media = new window.EventTarget();
    Object.defineProperty(media, 'matches', { get: () => query === '(min-width: 701px)' ? width >= 701 : false });
    queries.push(media); return media;
  };
  const getComputedStyle = element => new Proxy(window.getComputedStyle(element), { get(styles, property) {
    if (property === 'getPropertyValue') return styles.getPropertyValue.bind(styles);
    if (property === Symbol.iterator) return function* () { for (let i = 0; i < styles.length; i++) yield styles.item(i); };
    if (property === 'columnGap') return '3px';
    if (['paddingLeft', 'paddingRight', 'borderLeftWidth'].includes(property)) return styles[property] || '0px';
    return styles[property];
  } });
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.active = true; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); } disconnect() { this.active = false; }
  }
  class MutationObserver {
    constructor(callback) { this.inner = new window.MutationObserver(records => { assert.ok(++observerPasses < 250, 'layout observers must settle'); callback(records); }); }
    observe(...args) { this.inner.observe(...args); } disconnect() { this.inner.disconnect(); }
  }
  const globals = {
    window, document, getComputedStyle, matchMedia, localStorage: window.localStorage, ResizeObserver, MutationObserver,
    AbortController: window.AbortController, Event: window.Event, CustomEvent: window.CustomEvent, HTMLDialogElement: window.HTMLDialogElement,
    performance: { now: () => now }, requestAnimationFrame: callback => { frames.set(++counter, callback); return counter; }, cancelAnimationFrame: id => frames.delete(id),
  };
  const dependency = { './dashboard-title-tabs.js': titleTabs };
  const { mountAnchoredMenus } = loadTs('src/lib/ui/anchored-dashboard-menus.js', dependency, globals);
  const { mountAskDashboardLauncher } = loadTs('src/lib/ui/ask-dashboard-launcher.js', dependency, globals);
  const groups = names.map(label => ({ label, items: [1, 2, 3].map(index => ({ key: label + index, label: 'Action ' + index })) }));
  const unmount = mountAnchoredMenus(root, groups, () => {}, { groups: names, buttons: {}, widths: {}, tabWidths, collapsed, positions: { ...positions }, active: null }, layout => saves.push(plain(layout)), { canDrop });
  window.localStorage.setItem('cmpri:ask-tab-offset:fixture', '664');
  let launcher = ask ? mountAskDashboardLauncher(root, 'fixture', value => value) : undefined;
  const field = name => [...root.querySelectorAll('fieldset.group')].find(node => node.dataset.layoutLabel === name);
  const row = root.querySelector('.anchored-groups');
  const state = () => [...row.children].map(node => ({ label: node.dataset.layoutLabel, requested: node.requestedX, desired: node.positionX, left: node.style.left, width: node.requestedTabWidth }));
  const boxes = () => [...row.children].flatMap(node => {
    const title = node.querySelector('legend').getBoundingClientRect();
    if (!title.width) return [];
    const edge = node.querySelector('.tab-resize-edge')?.getBoundingClientRect();
    const raised = !node.classList.contains('collapsed') && node.querySelector('.group-outline');
    const origin = node.getBoundingClientRect().left;
    return [{ name: node.dataset.layoutLabel,
      left: Math.min(title.left, edge?.left ?? title.left, raised ? origin + 7.5 : Infinity),
      right: Math.max(title.right, edge?.right ?? title.right, raised ? origin + node.querySelector('legend').offsetWidth + 20.5 : -Infinity) }];
  }).sort((a, b) => a.left - b.left);
  const disjoint = () => {
    const values = boxes();
    for (let i = 1; i < values.length; i++) assert.ok(values[i].left >= values[i - 1].right + 1.9, JSON.stringify(values));
  };
  const event = (target, type, x, y = 87, pointerType = 'mouse') => {
    now += 20;
    const value = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(value, { pointerId: { value: 1 }, pointerType: { value: pointerType }, isPrimary: { value: true } });
    target.dispatchEvent(value);
    // JSDOM does not expose native onpointer* property event handlers. Exercise
    // the installed property handler as browsers do, alongside real listeners.
    if (Object.hasOwn(target, 'on' + type)) {
      Object.defineProperty(value, 'currentTarget', { value: target, configurable: true });
      target['on' + type]?.call(target, value);
    }
    return value;
  };
  const key = (node, value, altKey = false) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, altKey, bubbles: true, cancelable: true }));
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); assert.ok(observerPasses < 250, 'layout observers must settle'); disjoint(); };
  return { window, document, root, row, rail, saves, field, state, boxes, disjoint, event, key, flush,
    pointAt(node) { hitTarget = node; },
    open(name) { field(name).querySelector('legend').click(); disjoint(); },
    hold() { now += 400; for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    observe(target) { for (const observer of resizeObservers) if (observer.active && (!target || observer.targets.has(target))) observer.callback(); disjoint(); },
    intrinsic(name, value) { intrinsicWidths[name] = value; },
    scale(name, value) { titleScales[name] = value; },
    resize(value) { const previous = queries.map(query => query.matches); width = value; queries.forEach((query, i) => { if (query.matches !== previous[i]) query.dispatchEvent(new window.Event('change')); }); this.observe(); root.scrollLeft = root.scrollLeft; },
    translate() { const t = value => translations[value] || value; unmount.setPresentation({ t, tt: t }); disjoint(); launcher?.setPresentation(t); disjoint(); },
    disposeAsk() { launcher?.dispose(); launcher = undefined; disjoint(); },
    close() { launcher?.dispose(); unmount(); window.close(); },
  };
}

test('interval placement preserves free gaps, handles saved ordering and cannot grow on repeated passes', () => {
  const tabs = [{ item: 'Safety', left: 358, width: 96 }, { item: 'Assets', left: 261, width: 128.1 }, { item: 'Ask', left: 679, width: 76, anchor: true }, { item: 'Admin', left: 811, width: 58 }];
  const before = plain(tabs), placed = titleTabs.resolveTitleTabIntervals(tabs);
  assert.equal(placed.get('Assets'), 261);
  assert.equal(placed.get('Admin'), 811);
  assert.equal(placed.get('Ask'), 679);
  assert.ok(placed.get('Safety') >= 261 + 128.1 + 2);
  assert.deepEqual(tabs, before);
  assert.deepEqual([...titleTabs.resolveTitleTabIntervals(tabs)], [...placed]);
});

test('reported restored layout separates native title hitboxes while expanded panels may overlap', async () => {
  const h = fixture();
  try {
    h.disjoint();
    assert.equal(parseFloat(h.field('Assets & Inventory').style.left), 246);
    assert.ok(parseFloat(h.field('Safety & Logs').style.left) > 343);
    assert.equal(h.field('Safety & Logs').requestedX, 343);
    for (const name of ['Daily Work', 'Rooms & Reports', 'Admin', 'Account']) assert.equal(parseFloat(h.field(name).style.left), saved[name]);
    assert.equal(h.saves.length, 0, 'display repair must not save account data');
    h.open('Assets & Inventory'); h.open('Safety & Logs');
    const a = h.field('Assets & Inventory').getBoundingClientRect(), b = h.field('Safety & Logs').getBoundingClientRect();
    assert.ok(Math.min(a.right, b.right) > Math.max(a.left, b.left), 'expanded content rows are still allowed to overlap');
    await h.flush();
    const state = h.state(), savedCount = h.saves.length;
    for (let i = 0; i < 5; i++) { h.observe(); await h.flush(); assert.deepEqual(h.state(), state); }
    assert.equal(h.saves.length, savedCount);
  } finally { h.close(); }
});

test('restored open title outlines and their shoulders stay separate through pressed scaling', async () => {
  const h = fixture({ collapsed: [], tabWidths: { 'Assets & Inventory': 400 } });
  try {
    h.disjoint();
    const assets = h.field('Assets & Inventory'), cap = h.boxes().find(box => box.name === 'Assets & Inventory');
    const body = assets.getBoundingClientRect();
    assert.equal(cap.left, body.left + 7.5);
    assert.equal(cap.right, body.left + assets.querySelector('legend').offsetWidth + 20.5);
    assert.ok(body.width > cap.right - cap.left, 'the wider expanded body is not reserved as a title');
    assert.match(assets.querySelector('.group-outline path').getAttribute('d'), /H 8 Q 11 15 11 12/);
    const before = h.state();
    assert.equal(h.saves.length, 0);
    for (const name of names) assert.equal(h.field(name).requestedX, saved[name]);
    h.scale('Assets & Inventory', 0.985);
    h.scale('Ask CMPRI', 0.985);
    h.observe(); await h.flush();
    assert.deepEqual(h.state(), before, 'press transforms must not move the reserved title boxes');
    h.scale('Assets & Inventory', 1); h.scale('Ask CMPRI', 1);
    h.disjoint();
    for (let i = 0; i < 3; i++) { h.observe(); await h.flush(); assert.deepEqual(h.state(), before); }
    assert.equal(h.saves.length, 0);
  } finally { h.close(); }
});

test('caption resize observation and existing viewport refresh remeasure intrinsic minimums without saving', async () => {
  const h = fixture({ tabWidths: { 'Assets & Inventory': 160 } });
  try {
    const safety = h.field('Safety & Logs'), assets = h.field('Assets & Inventory');
    h.intrinsic('Safety & Logs', 230);
    h.observe(safety.querySelector('legend')); await h.flush();
    assert.equal(safety.minimumTabWidth, 230);
    assert.equal(safety.tabWidth, 230);
    h.intrinsic('Ask CMPRI', 150);
    h.observe(h.field('Ask CMPRI').querySelector('legend')); await h.flush();
    h.intrinsic('Assets & Inventory', 280);
    h.resize(995); await h.flush();
    assert.equal(assets.minimumTabWidth, 280);
    assert.equal(assets.querySelector('legend').style.width, '280px');
    assert.equal(assets.requestedTabWidth, 160, 'intrinsic fit must preserve the saved requested width');
    assert.equal(h.saves.length, 0);
    const stable = h.state(); h.observe(); await h.flush(); assert.deepEqual(h.state(), stable);
  } finally { h.close(); }
});

test('native drag and keyboard movement never overlap Ask or peers, and cancellation restores requested state', async () => {
  const h = fixture();
  try {
    const node = h.field('Safety & Logs'), title = node.querySelector('legend'), initial = h.state();
    const center = title.getBoundingClientRect().left + title.offsetWidth / 2;
    h.event(title, 'pointerdown', center);
    for (const x of [500, 620, 700, 760]) { h.event(h.document, 'pointermove', x); h.disjoint(); }
    assert.equal(node.classList.contains('dragging'), true);
    assert.notEqual(node.positionX, saved['Safety & Logs']);
    h.event(h.document, 'pointercancel', 760);
    assert.deepEqual(h.state(), initial); assert.equal(h.saves.length, 0);
    for (let i = 0; i < 18; i++) { h.key(title, 'ArrowRight', true); h.disjoint(); }
    assert.equal(node.requestedX, saved['Safety & Logs'] + 180, 'keyboard intent keeps advancing through a blocked slot');
    assert.equal(h.saves.at(-1).positions['Safety & Logs'], node.requestedX);
    await h.flush();
  } finally { h.close(); }
});

test('button hover opens and focuses its destination and previews the exact insertion before drop', async () => {
  const h = fixture();
  try {
    h.open('Daily Work');
    const origin = h.field('Daily Work'), destination = h.field('Rooms & Reports');
    const button = origin.querySelector('.action'), title = destination.querySelector('legend');
    const initialSaved = h.saves.length;
    const from = button.getBoundingClientRect(), tab = title.getBoundingClientRect();
    h.pointAt(button);
    h.event(button, 'pointerdown', from.left + 10, from.top + 10);
    h.pointAt(title);
    h.event(h.document, 'pointermove', tab.left + 10, tab.top + 7);
    assert.equal(title.getAttribute('aria-expanded'), 'true');
    assert.equal(title.getAttribute('aria-current'), 'true');
    assert.equal(h.document.activeElement, title);
    assert.equal(destination.querySelector('.buttons').lastElementChild, button);
    assert.equal(button.classList.contains('landing-copy'), true);
    assert.equal(h.saves.length, initialSaved, 'hover must not save the provisional move');

    const row = destination.querySelector('.buttons');
    const target = row.querySelector('.action'), targetRect = target.getBoundingClientRect();
    h.pointAt(target);
    h.hold();
    h.event(h.document, 'pointermove', targetRect.left + 8, targetRect.top + 8);
    assert.equal(row.firstElementChild, button, 'the faint button moves into the slot under the pointer');
    const previewOrder = [...row.children].map(node => node.dataset.layoutKey);
    // A neighbor can still be interpolating when the user releases. The
    // committed order must match the preview instead of re-hit-testing it.
    target.getBoundingClientRect = () => ({ ...targetRect, left: targetRect.left - 300, right: targetRect.right - 300 });
    h.event(h.document, 'pointerup', targetRect.left + 8, targetRect.top + 8);
    assert.deepEqual([...row.children].map(node => node.dataset.layoutKey), previewOrder);
    assert.deepEqual(h.saves.at(-1).buttons['Rooms & Reports'], previewOrder);
    assert.equal(button.classList.contains('landing-copy'), false);
    assert.equal(h.saves.length, initialSaved + 1);
    assert.equal(h.root.hasAttribute('data-button-dragging'), false);
    await h.flush();
  } finally { h.close(); }
});

test('canceling a cross-tab preview restores the source, opened tabs and active tab without a save', async () => {
  const h = fixture();
  try {
    h.open('Daily Work');
    const origin = h.field('Daily Work'), destination = h.field('Rooms & Reports');
    const button = origin.querySelector('.action'), title = destination.querySelector('legend');
    const before = [...origin.querySelector('.buttons').children];
    const savedCount = h.saves.length, from = button.getBoundingClientRect(), tab = title.getBoundingClientRect();
    h.pointAt(button);
    h.event(button, 'pointerdown', from.left + 10, from.top + 10, 'touch');
    h.hold();
    h.pointAt(title);
    h.event(h.document, 'pointermove', tab.left + 10, tab.top + 7, 'touch');
    assert.equal(button.closest('fieldset'), destination);
    assert.equal(title.getAttribute('aria-current'), 'true');
    h.key(h.document, 'Escape');
    assert.deepEqual([...origin.querySelector('.buttons').children], before);
    assert.equal(title.getAttribute('aria-expanded'), 'false');
    assert.equal(origin.querySelector('legend').getAttribute('aria-current'), 'true');
    assert.equal(h.document.querySelector('.moving-copy'), null);
    assert.equal(h.document.querySelector('.landing-copy'), null);
    assert.equal(h.saves.length, savedCount);
    await h.flush();
  } finally { h.close(); }
});

test('forbidden tabs and Ask CMPRI never become button-drop destinations', () => {
  const h = fixture({ canDrop: (_key, group) => group !== 'Admin' });
  try {
    h.open('Daily Work');
    const origin = h.field('Daily Work'), button = origin.querySelector('.action'), from = button.getBoundingClientRect();
    const savedCount = h.saves.length;
    h.pointAt(button);
    h.event(button, 'pointerdown', from.left + 10, from.top + 10);
    for (const name of ['Admin', 'Ask CMPRI']) {
      const title = h.field(name).querySelector('legend'), tab = title.getBoundingClientRect();
      h.pointAt(title);
      h.event(h.document, 'pointermove', tab.left + 10, tab.top + 7);
      assert.equal(button.closest('fieldset'), origin);
      assert.equal(h.document.body.classList.contains('drag-invalid'), true);
      assert.equal(title.getAttribute('aria-current'), null);
    }
    h.event(h.document, 'pointerup', 0, 0);
    assert.equal(button.closest('fieldset'), origin);
    assert.equal(h.saves.length, savedCount);
  } finally { h.close(); }
});

test('a stationary touch hold on a visually displaced tab does not save a repaired position', () => {
  const h = fixture();
  try {
    const node = h.field('Safety & Logs'), title = node.querySelector('legend'), before = h.state();
    assert.notEqual(parseFloat(node.style.left), node.positionX);
    const center = title.getBoundingClientRect().left + 30;
    h.event(title, 'pointerdown', center, 87, 'touch'); h.hold();
    assert.equal(node.classList.contains('dragging'), true);
    h.event(h.document, 'pointerup', center, 87, 'touch');
    h.disjoint(); assert.deepEqual(h.state(), before); assert.equal(h.saves.length, 0);
  } finally { h.close(); }
});

test('caption and row resizing remain separate; caption cancellation restores every title', async () => {
  const h = fixture();
  try {
    const node = h.field('Assets & Inventory'), edge = node.querySelector('.tab-resize-edge'), before = h.state();
    const center = edge.getBoundingClientRect().left + 3;
    h.event(edge, 'pointerdown', center);
    h.event(h.document, 'pointermove', center + 220); h.disjoint();
    assert.ok(node.requestedTabWidth > 300);
    h.key(h.document, 'Escape'); h.disjoint(); assert.deepEqual(h.state(), before); assert.equal(h.saves.length, 0);
    h.key(edge, 'ArrowRight'); h.disjoint();
    assert.ok(h.saves.at(-1).tabWidths['Assets & Inventory'] > 125);
    h.open('Assets & Inventory');
    const titles = h.state().map(item => [item.label, item.left]);
    h.key(node.querySelector('.resize-edge'), 'ArrowLeft');
    assert.deepEqual(h.state().map(item => [item.label, item.left]), titles, 'content-row resizing does not reserve a wider title slot');
    await h.flush();
  } finally { h.close(); }
});

test('Ask movement, cancellation, viewport changes, localization and disposal keep native hitboxes disjoint', async () => {
  const h = fixture();
  try {
    const title = h.field('Ask CMPRI').querySelector('legend'), before = h.state();
    const center = title.getBoundingClientRect().left + 30;
    h.event(title, 'pointerdown', center);
    for (const x of [450, 330, 170]) { h.event(h.rail, 'pointermove', x); h.disjoint(); }
    h.event(h.rail, 'pointercancel', 170); h.disjoint(); assert.deepEqual(h.state(), before);
    assert.equal(h.window.localStorage.getItem('cmpri:ask-tab-offset:fixture'), '664');
    h.key(title, 'ArrowLeft', true); h.disjoint(); assert.equal(h.saves.length, 0);
    const preferred = Object.fromEntries(names.map(name => [name, h.field(name).requestedX]));
    for (const size of [701, 700, 390, 996]) { h.resize(size); await h.flush(); }
    h.translate(); await h.flush();
    assert.deepEqual(Object.fromEntries(names.map(name => [name, h.field(name).requestedX])), preferred);
    const stable = h.state(); h.observe(); await h.flush(); assert.deepEqual(h.state(), stable);
    h.disposeAsk(); assert.equal(h.saves.length, 0);
  } finally { h.close(); }
});

test('crossing the phone breakpoint cancels an Ask drag and preserves its saved desktop offset', async () => {
  const h = fixture();
  try {
    const node = h.field('Ask CMPRI'), title = node.querySelector('legend'), before = h.state();
    const center = title.getBoundingClientRect().left + 30;
    h.event(title, 'pointerdown', center); h.event(h.rail, 'pointermove', 330);
    assert.equal(node.classList.contains('dragging'), true);
    assert.equal(h.rail.hasPointerCapture(1), true);
    h.resize(700);
    assert.equal(node.classList.contains('dragging'), false);
    assert.equal(h.rail.hasPointerCapture(1), false);
    h.event(h.rail, 'pointermove', 120); h.event(h.rail, 'pointerup', 120);
    assert.equal(h.window.localStorage.getItem('cmpri:ask-tab-offset:fixture'), '664');
    h.resize(996); await h.flush();
    assert.deepEqual(h.state(), before);
    assert.equal(h.saves.length, 0);
  } finally { h.close(); }
});

test('viewport and language changes during a native gesture resolve synchronously without persisting it', async () => {
  const h = fixture();
  try {
    const node = h.field('Safety & Logs'), title = node.querySelector('legend'), before = node.requestedX;
    const center = title.getBoundingClientRect().left + 30;
    h.event(title, 'pointerdown', center); h.event(h.document, 'pointermove', 600); h.disjoint();
    h.resize(701); h.translate(); h.disjoint();
    h.event(h.document, 'pointercancel', 600); h.disjoint();
    assert.equal(node.requestedX, before); assert.equal(h.saves.length, 0);
    await h.flush();
  } finally { h.close(); }
});

test('fractional inset noise settles, crowded restored tabs remain reachable, and Ask disposal retains repair', async () => {
  const h = fixture({ positions: Object.fromEntries(names.map(name => [name, 246])), insetNoise: -0.007440567016602 });
  try {
    h.disjoint(); await h.flush();
    const stable = h.state(), extent = h.row.style.minWidth;
    for (let i = 0; i < 8; i++) { h.observe(); await h.flush(); assert.deepEqual(h.state(), stable); assert.equal(h.row.style.minWidth, extent); }
    assert.equal(h.saves.length, 0);
    h.disposeAsk(); await h.flush(); h.disjoint();
    assert.equal(h.saves.length, 0);
    for (const node of h.row.children) assert.equal(node.requestedX, 246);
    h.resize(390); await h.flush();
    assert.ok(parseFloat(h.row.style.minWidth) > 390);
    h.root.scrollLeft = h.root.scrollWidth; h.root.dispatchEvent(new h.window.Event('scroll')); h.disjoint();
    const last = h.boxes().at(-1); assert.ok(last.right <= 390, JSON.stringify(last));
  } finally { h.close(); }
});
