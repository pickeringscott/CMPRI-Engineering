import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const script = readFileSync('public/ui-language.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
function fixture(scope = 'weather') {
  const dom = new JSDOM('<iframe src="/preview"></iframe>', { url: 'https://cmpri.test/', runScripts: 'outside-only' });
  const window = dom.window.document.querySelector('iframe').contentWindow;
  window.document.open();
  window.document.write('<body><h2 id="heading">Current Conditions</h2><button id="button" title="Save">Save</button><p id="condition">Clear</p><p id="stamp">As of: 11/20/2026 16:30 CST</p><p id="official" translate="no">Clear</p><p data-user-content id="note">Save</p><textarea id="input">Save</textarea><input id="range" type="range" min="0" max="1" step=".01" value=".62"></body>');
  window.document.close();
  const element = window.document.createElement('script'); element.dataset.uiScope = scope;
  Object.defineProperty(window.document, 'currentScript', { value: element, configurable: true });
  let calls = 0;
  window.fetch = async url => {
    assert.equal(url, '/ui-language.es.json'); calls++;
    return { ok: true, json: async () => ({ common: { Save: 'Guardar', Clear: 'Borrar' }, weather: { 'Current Conditions': 'Condiciones actuales', Clear: 'Despejado', 'As of: {stamp}': 'Al: {stamp}' } }) };
  };
  window.eval(script);
  const language = (value, origin = 'https://cmpri.test') => window.dispatchEvent(new window.MessageEvent('message', { source: dom.window, origin, data: { type: 'cmpri-ui-language', language: value } }));
  return { dom, window, language, close: async () => { window.dispatchEvent(new window.Event('pagehide')); await tick(); dom.window.close(); }, calls: () => calls, node: id => window.document.getElementById(id) };
}

test('vanilla iframe uses the weather context and keeps source content and controls intact', async () => {
  const f = fixture(), range = f.node('range'), button = f.node('button');
  let clicked = 0; button.addEventListener('click', () => clicked++);
  f.language('es'); await tick();
  assert.equal(f.node('heading').textContent, 'Condiciones actuales');
  assert.equal(f.node('condition').textContent, 'Despejado');
  assert.equal(f.node('stamp').textContent, 'Al: 11/20/2026 16:30 CST');
  assert.equal(f.node('official').textContent, 'Clear');
  assert.equal(f.node('note').textContent, 'Save');
  assert.equal(f.node('input').value, 'Save');
  assert.equal(f.node('range'), range); assert.equal(range.value, '.62');
  button.click(); assert.equal(clicked, 1);
  assert.equal(f.calls(), 1);
  await f.close();
});

test('switching back to English restores labels without replacing the map or reloading the catalogue', async () => {
  const f = fixture(); f.language('es'); await tick();
  assert.equal(f.node('button').textContent, 'Guardar');
  f.node('heading').textContent = 'Save'; await tick();
  assert.equal(f.node('heading').textContent, 'Guardar');
  f.language('en'); await tick();
  assert.equal(f.node('heading').textContent, 'Save');
  assert.equal(f.node('button').textContent, 'Save');
  assert.equal(f.node('button').getAttribute('title'), 'Save');
  f.language('es'); await tick(); assert.equal(f.calls(), 1);
  await f.close();
});

test('untrusted language messages cannot change a vanilla iframe', async () => {
  const f = fixture(); f.language('es', 'https://other.invalid'); await tick();
  assert.equal(f.node('button').textContent, 'Save'); assert.equal(f.calls(), 0);
  await f.close();
});

test('the general catalogue retains action meaning rather than weather meaning', async () => {
  const f = fixture('general'); f.language('es'); await tick();
  assert.equal(f.node('condition').textContent, 'Borrar');
  f.window.dispatchEvent(new f.window.Event('pagehide'));
  f.node('button').textContent = 'Save'; await tick();
  assert.equal(f.node('button').textContent, 'Save');
  await f.close();
});


test('BFCache restoration resumes language updates with cached data and original controls', async () => {
  const f = fixture(), button = f.node('button'), range = f.node('range');
  let clicks = 0; button.addEventListener('click', () => clicks++);
  try {
    f.language('es'); await tick();
    assert.equal(button.textContent, 'Guardar'); assert.equal(f.calls(), 1);
    f.window.dispatchEvent(new f.window.PageTransitionEvent('pagehide', { persisted: true }));
    f.language('en');
    f.node('heading').textContent = 'Save'; await tick();
    assert.equal(f.node('heading').textContent, 'Save');
    assert.equal(f.window.document.documentElement.lang, 'es');

    f.dom.window.document.documentElement.lang = 'en';
    f.window.dispatchEvent(new f.window.PageTransitionEvent('pageshow', { persisted: true }));
    await tick();
    assert.equal(f.window.document.documentElement.lang, 'en');
    assert.equal(button.textContent, 'Save');
    assert.equal(button.getAttribute('title'), 'Save');
    f.language('es'); await tick();
    assert.equal(button.textContent, 'Guardar');
    f.node('heading').textContent = 'Current Conditions'; await tick();
    assert.equal(f.node('heading').textContent, 'Condiciones actuales');
    assert.equal(f.calls(), 1);
    assert.equal(f.node('range'), range); assert.equal(range.value, '.62');
    assert.equal(f.node('button'), button); button.click(); assert.equal(clicks, 1);

    f.window.dispatchEvent(new f.window.PageTransitionEvent('pagehide', { persisted: true }));
    f.dom.window.document.documentElement.lang = 'es';
    f.window.dispatchEvent(new f.window.PageTransitionEvent('pageshow', { persisted: true }));
    await tick();
    f.language('en'); await tick();
    assert.equal(button.textContent, 'Save'); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
