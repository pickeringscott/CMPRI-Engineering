import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountAnchoredMenus } from '../src/lib/ui/anchored-dashboard-menus.js';
import { makeUiTranslator } from '../src/lib/i18n/ui.ts';

test('anchored menus retain canonical layout, moved controls and active state across saved language changes', () => {
  const dom = new JSDOM('<div id="menus"></div>');
  const globals = { window: dom.window, document: dom.window.document,
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let dispose;
  try {
    const root = document.querySelector('#menus');
    Object.defineProperty(root, 'clientWidth', { value: 1200 });
    const note = { key: '/notes', label: 'Notes' }, weather = { key: '/previews/cmpri-weather-preview.html', label: 'Weather' };
    const saves = [], launches = [];
    dispose = mountAnchoredMenus(root, [{ label: 'Daily Work', items: [note] }, { label: 'Safety & Logs', items: [weather] }],
      action => launches.push(action), { groups: ['Daily Work', 'Safety & Logs'], buttons: {}, widths: {}, collapsed: [], active: 'Safety & Logs' },
      layout => saves.push(layout));
    const [first, second] = root.querySelectorAll('fieldset'), noteButton = first.querySelector('button'), weatherButton = second.querySelector('button');
    // A previously permitted move must remain intact when the user later changes language.
    second.querySelector('.buttons').append(noteButton);
    dispose.setPresentation({ t: makeUiTranslator('es'), tt: makeUiTranslator('es') });
    assert.equal(first.querySelector('legend').textContent, 'Trabajo diario');
    assert.equal(second.querySelector('legend').textContent, 'Seguridad y registros');
    assert.equal(noteButton.textContent, 'Notas');
    assert.equal(weatherButton.textContent, 'Clima');
    assert.equal(noteButton.closest('fieldset'), second);
    assert.equal(second.dataset.active, 'true');
    assert.equal(saves.length, 0, 'presentation changes must not write layout data');
    assert.equal(second.querySelector('.tab-resize-edge').getAttribute('aria-label'), 'Cambiar el tamaño de la pestaña Seguridad y registros');
    assert.equal(root.nextElementSibling.getAttribute('aria-label'), 'Desplazar las pestañas del menú');
    assert.equal(noteButton.dataset.layoutKey, '/notes::Notes');
    assert.equal(weatherButton.dataset.control, 'Weather');
    weatherButton.click(); assert.equal(launches[0], weather);
    first.querySelector('legend').click();
    assert.deepEqual(saves.at(-1).groups, ['Daily Work', 'Safety & Logs']);
    assert.deepEqual(saves.at(-1).buttons['Daily Work'], []);
    assert.deepEqual(saves.at(-1).buttons['Safety & Logs'], ['/previews/cmpri-weather-preview.html::Weather', '/notes::Notes']);
    const state = JSON.stringify(saves.at(-1));
    dispose.setPresentation({ t: makeUiTranslator('en'), tt: makeUiTranslator('en') });
    assert.equal(first.querySelector('legend').textContent, 'Daily Work');
    assert.equal(root.querySelector('[data-key="/notes"]'), noteButton);
    assert.equal(weatherButton.textContent, 'Weather');
    assert.equal(JSON.stringify(saves.at(-1)), state);
    assert.equal(saves.length, 1);
  } finally {
    dispose?.(); dom.window.close();
    for (const [key, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
