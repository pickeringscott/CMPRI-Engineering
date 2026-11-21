import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountApprovedMenus } from '../src/lib/ui/approved-header-menus.js';
import { SHELL_ES } from '../src/lib/i18n/shell.ts';
import { translateNotificationMessage } from '../src/lib/i18n/notification-text.ts';

function translator(language) {
  return (english, values = {}) => (language === 'es' ? SHELL_ES[english] || english : english)
    .replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

test('switching menu language preserves its DOM, canonical layout identifiers, and authorized action payload', () => {
  const dom = new JSDOM('<div id="menus"></div>');
  const replacements = {
    window: dom.window, document: dom.window.document,
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  };
  const prior = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    const root = document.querySelector('#menus');
    Object.defineProperty(root, 'clientWidth', { value: 1200 });
    const action = { key: '/staff-notes', label: 'Staff Notes' };
    const saves = [], launches = [];
    const dispose = mountApprovedMenus(root, [{ label: 'Operations', items: [action] }], value => launches.push(value),
      { groups: ['Operations'], buttons: {}, widths: {}, collapsed: [] }, value => saves.push(value));
    const button = root.querySelector('button'), legend = root.querySelector('legend');
    assert.equal(legend.textContent, 'Operations');
    dispose.setPresentation({ t: translator('es'), tt: translator('es') });
    assert.equal(root.querySelector('button'), button);
    assert.equal(legend.textContent, 'Operaciones');
    assert.equal(button.textContent, 'Notas del personal');
    assert.equal(button.dataset.layoutKey, '/staff-notes::Staff Notes');
    assert.equal(button.dataset.control, 'Staff Notes');
    assert.equal(saves.length, 0, 'translation alone must not write a layout');
    legend.click();
    assert.deepEqual(saves.at(-1).groups, ['Operations']);
    assert.deepEqual(saves.at(-1).collapsed, ['Operations']);
    assert.deepEqual(saves.at(-1).buttons, { Operations: ['/staff-notes::Staff Notes'] });
    button.click();
    assert.equal(launches[0], action);
    dispose.setPresentation({ t: translator('en'), tt: translator('en') });
    assert.equal(legend.textContent, 'Operations');
    assert.equal(button.textContent, 'Staff Notes');
    assert.equal(legend.getAttribute('aria-expanded'), 'false');
    assert.equal(saves.length, 1, 'switching back must preserve collapse state without saving');
    dispose();
  } finally {
    dom.window.close();
    for (const [key, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test('Spanish system notification framing preserves supplied names, ticket numbers and issue text', () => {
  const t = translator('es');
  assert.equal(translateNotificationMessage('WO#124 was assigned to you.', t), 'Se te asignó WO#124.');
  assert.equal(translateNotificationMessage('WO#124 was claimed by Open.', t), 'Open se asignó WO#124.');
  const text = 'WO#124 (Room 124 — Open is the guest note) status changed: Open → Closed by Jane.';
  assert.equal(translateNotificationMessage(text, t), 'Jane cambió el estado de WO#124 (Room 124 — Open is the guest note): Abierta → Cerrada.');
  assert.equal(translateNotificationMessage('New WO#124: Guest wrote "Open" — keep exactly.', t), 'Nueva WO#124: Guest wrote "Open" — keep exactly.');
});

test('unrecognized user-written messages and official bulletin bodies are left untouched', () => {
  const original = 'Flood warning: turn around, do not drown. Open Guest Road may be flooded.';
  assert.equal(translateNotificationMessage(original, translator('es')), original);
  assert.equal(translateNotificationMessage('Open is a guest surname.', translator('es')), 'Open is a guest surname.');
});
