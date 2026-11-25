import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import * as pool from '../src/lib/pool-log.ts';
import { makeUiTranslator } from '../src/lib/i18n/ui.ts';
import * as clock from '../src/lib/ui/time-format.ts';

const require = createRequire(import.meta.url);
const source = readFileSync('src/app/engineering/pool-log/PoolDailyHistory.tsx', 'utf8');
const exports = {};
let timeFormat = '12h';
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, require: name => ({
    '@/lib/pool-log': pool,
    '@/components/UiLanguageProvider': { useUiLanguage: () => ({ t: makeUiTranslator('en'), locale: 'en-US' }) },
    '@/components/TimeFormatProvider': { useTimeFormat: () => timeFormat },
    '@/lib/ui/time-format': clock,
  })[name] ?? require(name),
});

test('daily history reports changes and preserves every distinct location reading, zeros and notes', () => {
  const previous = { ph_am: 7.4, sanitizer_band_am: '3-6', ph_shallow_am: 7.4, ph_deep_am: 7.6, remarks: 'AM note', flow_rate_gpm: 50, main_drain_visible: true };
  const current = { ...previous, ph_pm: 7.8, sanitizer_band_pm: '0', ph_deep_am: 7.8, temperature_f: 84, filter_backwashed: false, remarks: 'AM note\nPM note', retest_submission: { id: 'r1', ph: 7.6, sanitizer_band: '3-6', sample_location: 'shared' } };
  const text = exports.poolSnapshotDescription(current, previous);
  assert.match(text, /PM pH 7.8/); assert.match(text, /PM bromine 0 ppm/);
  assert.match(text, /AM deep pH: 7.8/); assert.doesNotMatch(text, /AM shallow pH/);
  assert.match(text, /Retest pH 7.6/); assert.match(text, /Retest sample Shared sample/);
  assert.match(text, /Water 84°F/); assert.match(text, /Filter backwashed: No/);
  assert.match(text, /Notes: PM note/); assert.doesNotMatch(text, /AM note/);
  assert.doesNotMatch(text, /Flow 50 GPM/);
});

test('first snapshot keeps differing shallow and deep values alongside the generic sample', () => {
  const text = exports.poolSnapshotDescription({ ph_am: 7.4, ph_shallow_am: 7.4, ph_middle_am: 7.2, ph_deep_am: 7.8, sanitizer_band_am: '3-6', sanitizer_middle_am: 4, flow_rate_gpm: 0, main_drain_visible: false });
  assert.match(text, /AM pH 7.4/); assert.match(text, /AM deep pH: 7.8/);
  assert.match(text, /AM middle pH: 7.2/); assert.match(text, /AM middle bromine \(ppm\): 4/);
  assert.doesNotMatch(text, /AM shallow pH/); assert.match(text, /Flow 0 GPM/); assert.match(text, /Main drain visible: No/);
});

test('the daily timeline renders one row per action and labels legacy current data honestly', () => {
  const html = renderToStaticMarkup(React.createElement(exports.default, { entries: [
    { id: 'one', kind: 'close', recorded_at: '2026-11-10T18:00:00Z', actor_name: 'Alex', reason: 'Cleaning' },
    { id: 'two', kind: 'clear-manual', recorded_at: '2026-11-10T18:15:00Z', actor_name: 'Jordan' },
    { id: 'three', kind: 'reading', source: 'current', recorded_at: '2026-11-10T18:30:00Z', snapshot: { ph_am: 7.4, remarks: 'Routine' } },
  ] }));
  assert.match(html, /Pool closed: Cleaning/); assert.match(html, /Manual hold cleared/);
  assert.match(html, /Current saved record: AM pH 7.4/); assert.match(html, /Notes: Routine/);
  assert.equal((html.match(/<time /g) || []).length, 3);
});

test('pool history switches time format without changing its Chicago zone or stored timestamp', () => {
  const recorded_at = '2026-11-10T23:15:00Z';
  const render = () => renderToStaticMarkup(React.createElement(exports.default, { entries: [
    { id: 'close', kind: 'close', recorded_at, reason: 'Cleaning' },
  ] }));
  try {
    assert.match(render(), /5:15\s*PM/);
    timeFormat = '24h';
    const html = render();
    assert.match(html, /17:15/);
    assert.ok(html.includes(recorded_at));
  } finally {
    timeFormat = '12h';
  }
});

test('the pool form has one accessible notes editor and a single top-row save button', () => {
  const page = readFileSync('src/app/engineering/pool-log/page.tsx', 'utf8');
  assert.match(page, /aria-label=\{t\("Date"\)\}/);
  assert.match(page, /form="pool-log-form"/);
  assert.equal((page.match(/form="pool-log-form"/g) || []).length, 1);
  assert.equal((page.match(/aria-label=\{t\("Notes \/ actions taken"\)\}/g) || []).length, 1);
  assert.doesNotMatch(page, />Reload<|Discard edits and reload|Remarks \/ actions taken/);
  assert.doesNotMatch(page, /Keep Closed for Another Reason/);
});


test('Spanish history translates controlled labels without changing readings, notes or closure reasons', () => {
  const t = makeUiTranslator('es');
  const previous = { remarks: 'Original note' };
  const snapshot = { ph_am: 7.4, sanitizer_band_am: '0', sample_location_am: 'shared', main_drain_visible: false, remarks: 'Original note\nKeep this note as written', closure_reason: 'Staff reason stays verbatim' };
  const text = exports.poolSnapshotDescription(snapshot, previous, text => t(text, { context: 'pool' }));
  assert.match(text, /AM pH 7.4/);
  assert.match(text, /AM bromo 0 ppm/);
  assert.match(text, /muestra Muestra compartida/);
  assert.match(text, /Drenaje principal visible: No/);
  assert.match(text, /Notas: Keep this note as written/);
  assert.match(text, /Cierre: Staff reason stays verbatim/);
  assert.doesNotMatch(text, /Original note|bromine|Main drain visible/);
  assert.equal(t('AM pH 8.0 is outside 7.2–7.8'), 'El pH AM, 8.0, está fuera del intervalo de 7.2–7.8');
});
