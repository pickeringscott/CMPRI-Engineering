import test from 'node:test';
import assert from 'node:assert/strict';
import { SPANISH_UI } from '../src/lib/i18n/catalog.ts';
import { makeUiTranslator, translateUiText, uiLanguage, uiLocale, uiTitleCase } from '../src/lib/i18n/ui.ts';

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
