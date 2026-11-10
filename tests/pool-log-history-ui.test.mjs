import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import * as pool from '../src/lib/pool-log.ts';

const require = createRequire(import.meta.url);
const source = readFileSync('src/app/engineering/pool-log/PoolDailyHistory.tsx', 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, require: name => name === '@/lib/pool-log' ? pool : require(name),
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

test('the pool form has one accessible notes editor and a single top-row save button', () => {
  const page = readFileSync('src/app/engineering/pool-log/page.tsx', 'utf8');
  assert.match(page, /aria-label="Date"/);
  assert.match(page, /form="pool-log-form"/);
  assert.equal((page.match(/form="pool-log-form"/g) || []).length, 1);
  assert.equal((page.match(/aria-label="Notes \/ actions taken"/g) || []).length, 1);
  assert.doesNotMatch(page, />Reload<|Discard edits and reload|Remarks \/ actions taken/);
  assert.doesNotMatch(page, /Keep Closed for Another Reason/);
});
