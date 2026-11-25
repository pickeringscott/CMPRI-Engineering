import test from 'node:test';
import assert from 'node:assert/strict';
import { SPANISH_UI } from '../src/lib/i18n/catalog.ts';
import { makeUiTranslator, translateUiText, uiLanguage, uiLocale, uiTitleCase } from '../src/lib/i18n/ui.ts';
import { formatWallTime, timeFormatOptions } from '../src/lib/ui/time-format.ts';

test('account clock labels change format without shifting local time or losing seconds', () => {
  assert.equal(formatWallTime('17:07', '12h'), '5:07 PM');
  assert.equal(formatWallTime('5:07 p. m.', '24h'), '17:07');
  assert.equal(formatWallTime('12:01 AM', '24h'), '00:01');
  assert.equal(formatWallTime('23:45:10', '12h'), '11:45:10 PM');
  assert.equal(formatWallTime('24:02', '12h'), '24:02');
  assert.equal(formatWallTime('Pending', '24h'), 'Pending');

  const instant = new Date('2026-11-24T05:31:00Z');
  const options = { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' };
  assert.equal(instant.toLocaleTimeString('en-US', { ...options, ...timeFormatOptions('24h') }), '23:31');
  assert.equal(instant.toLocaleTimeString('en-US', { ...options, ...timeFormatOptions('12h') }), '11:31 PM');
});

test('an account preference save updates mounted views and frames using verified settings', async () => {
  const { JSDOM } = await import('jsdom');
  const React = await import('react');
  const jsx = await import('react/jsx-runtime');
  const { createRoot } = await import('react-dom/client');
  const { loadTs } = await import('./helpers/load-ts.mjs');
  const profiles = await import('../src/lib/profile-preferences.ts');
  const time = await import('../src/lib/ui/time-format.ts');
  const language = await import('../src/lib/i18n/ui.ts');
  const { window } = new JSDOM('<main></main><iframe></iframe>', { url: 'https://cmpri.fixture' });
  const { document } = window;
  const frame = document.querySelector('iframe');
  const messages = [];
  frame.contentWindow.postMessage = (data, origin) => messages.push({ data, origin });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActSetting = globalThis.IS_REACT_ACT_ENVIRONMENT;
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });

  const TimeFormatContext = React.createContext('12h');
  const account = { id: 'chief', role: 'Chief Engineer' };
  let preferences = { language: 'en' };
  const provider = loadTs('src/components/UiLanguageProvider.tsx', {
    react: React,
    'react/jsx-runtime': jsx,
    'next/navigation': { usePathname: () => '/engineering' },
    '@/lib/supabase/client': { getValidSession: async () => ({ user: account, access_token: 'fixture' }) },
    '@/lib/profile-preferences': profiles,
    '@/lib/ui/time-format': time,
    '@/lib/i18n/ui': language,
    './TimeFormatProvider': { TimeFormatContext },
  }, {
    window, document, localStorage: window.localStorage, HTMLIFrameElement: window.HTMLIFrameElement,
    CustomEvent: window.CustomEvent, AbortController,
    fetch: async path => {
      assert.equal(path, '/api/profile');
      return Response.json({ profile: account, preferences });
    },
  }).default;
  const root = createRoot(document.querySelector('main'));
  function Display() { return React.createElement('output', {}, React.useContext(TimeFormatContext)); }
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  try {
    await React.act(async () => { root.render(React.createElement(provider, {}, React.createElement(Display))); await settle(); });
    assert.equal(document.querySelector('output').textContent, '24h');
    assert.ok(messages.some(({ data }) => data.type === time.TIME_FORMAT_MESSAGE && data.timeFormat === '24h' && data.userId === 'chief'));

    preferences = { language: 'en', time_format: '12h' };
    await React.act(async () => {
      window.dispatchEvent(new window.MessageEvent('message', { origin: window.location.origin, source: window,
        data: { type: 'cmpri-profile-preferences-updated', preferences: { time_format: '24h' } } }));
      await settle();
    });
    assert.equal(document.querySelector('output').textContent, '12h');
    const last = messages.filter(({ data }) => data.type === time.TIME_FORMAT_MESSAGE).at(-1);
    assert.equal(last.origin, window.location.origin);
    assert.equal(last.data.timeFormat, '12h');
    assert.equal(last.data.userId, 'chief');
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, IS_REACT_ACT_ENVIRONMENT: previousActSetting });
    window.close();
  }
});

test('one catalogue gives shared CMPRI controls the same Spanish wording', () => {
  const t = makeUiTranslator('es');
  assert.equal(t('Work Order', 'Ticket'), 'Orden de trabajo');
  assert.equal(t('Work Order List'), 'Lista de órdenes de trabajo');
  assert.equal(t('Lead Housekeeper'), 'Supervisor de limpieza');
  assert.equal(t('Save Profile'), 'Guardar perfil');
  assert.equal(t('Staff Notes'), 'Notas del personal');
  assert.equal(t('Assets'), 'Equipos');
  assert.equal(t('Will Not Do'), 'No se realizará');
});

test('English controls and supplied field values are preserved', () => {
  const t = makeUiTranslator('en');
  assert.equal(t('Work Order List'), 'Work Order List');
  assert.equal(t('Work Order #{id}', { id: '4218' }), 'Work Order #4218');
  const original = { status: 'Open', name: 'María', issue: 'The shower handle is loose.' };
  assert.equal(makeUiTranslator('es')(original.status), 'Abierta');
  assert.deepEqual(original, { status: 'Open', name: 'María', issue: 'The shower handle is loose.' });
});

test('variables, punctuation and outer whitespace survive localization', () => {
  const t = makeUiTranslator('es');
  assert.equal(t('  Work Order  '), '  Orden de trabajo  ');
  assert.equal(t('Name: '), 'Nombre: ');
  assert.equal(t('Room {room}', { room: 'Ático 124' }), 'Habitación Ático 124');
  assert.equal(t('Photos ({count})', { count: 3 }), 'Fotos (3)');
  assert.equal(t('New unregistered phrase', 'Frase nueva'), 'Frase nueva');
});

test('ambiguous verbs use explicit context without changing English keys', () => {
  assert.equal(translateUiText('es', 'Open'), 'Abierta');
  assert.equal(translateUiText('es', 'Open', { context: 'action' }), 'Abrir');
  assert.equal(translateUiText('en', 'Open', { context: 'action' }), 'Open');
  assert.equal(translateUiText('es', 'Clear', { context: 'gss' }), 'Sin color');
});

test('unknown names and source content are not captured by prefixless UI templates', () => {
  for (const value of ['María: Save', 'The guest wrote: Open', '3 of my coworkers', 'https://example.invalid/Room 124', 'constructor', 'toString', '__proto__', ' constructor: ']) {
    assert.equal(translateUiText('es', value), value);
  }
});

test('known dynamic UI templates preserve their inserted data', () => {
  assert.equal(translateUiText('es', 'Room 124'), 'Habitación 124');
  assert.equal(translateUiText('es', 'Work Order #4218'), 'Orden de trabajo n.º 4218');
});

test('a composite alert label translates both prefixes without capturing the second label as data', () => {
  const effective = '2026-11-20 20:27 CST';
  const expires = '2026-11-20 22:32 CST';
  // Effective: {time} is also a known template, but its data slot must not
  // swallow the second label in the more specific official-alert UI template.
  assert.equal(translateUiText('es', `Effective: ${effective} · Expires: ${expires}`),
    `Vigente desde: ${effective} · Vence: ${expires}`);
  assert.equal(translateUiText('es', `Effective: ${effective}`), `Vigente desde: ${effective}`);
});

test('all translated UI templates preserve every interpolation variable', () => {
  const names = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  const bad = Object.entries(SPANISH_UI).flatMap(([english, spanish]) => {
    assert.equal(typeof spanish, 'string', english);
    assert.ok(spanish.trim(), english);
    return JSON.stringify(names(english)) === JSON.stringify(names(spanish)) ? [] : [{ english, spanish }];
  });
  assert.deepEqual(bad, []);
});

test('locale normalization and title casing preserve Spanish accents and abbreviations', () => {
  assert.equal(uiLanguage('es'), 'es');
  assert.equal(uiLanguage('other'), 'en');
  assert.equal(uiLocale('es'), 'es-US');
  assert.equal(uiTitleCase('añadir órdenes de trabajo / CMPRI'), 'Añadir Órdenes De Trabajo / CMPRI');
});
