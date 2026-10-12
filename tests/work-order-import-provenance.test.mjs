import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as provenance from '../src/lib/work-order-import-provenance.ts';

const { workOrderImportLabel } = provenance;
const batch = 'CMPRI-final-20260915-IMP-';
const imported = (id) => ({ import_source: 'Spreadsheet', import_external_id: id });

test('verified Mitti batch covers originals, merged IDs, missing original IDs and split keys', () => {
  for (const suffix of ['0006|CUR-006|AC-6131', '0049|CUR-051|AC-9162, AC-9409', '0046|CUR-046', '0226|CUR-236-A|AC-9172', '0225|CUR-236-B|WO-2026-0948']) {
    assert.equal(workOrderImportLabel(imported(batch + suffix)), 'Imported from Mitti');
  }
  assert.equal(workOrderImportLabel({ import_source: 'SafetyCulture' }), null);
});

test('unrelated spreadsheet, paper, native, partial metadata and source mentions do not prove Mitti', () => {
  for (const order of [{}, { import_source: null, import_external_id: null },
    { import_source: 'Spreadsheet' }, { import_external_id: batch + '0006|CUR-006' },
    imported('CMPRI-completed-WO-001'), imported(batch), imported(batch + '6|CUR-006'), imported(batch + '0006|CUR-006-C'), imported(batch + '0006|CUR-006|'), imported(batch + '0006|CUR-006|AC-1|extra'), imported(batch + '0006|CUR-006\n'), { import_source: 'SafetyCulture', import_external_id: batch + '0006|CUR-006' }, imported('other-batch|AC-6131'), imported(''),
    imported('x' + batch + '0006'), imported('CMPRI-final-20260916-IMP-0006'),
    { import_source: 'Paper', import_external_id: batch + '0006' },
    { import_source: 'Spreadsheet', import_external_id: 123 },
    { notes: 'Imported from Mitti / SafetyCulture', issue: 'SafetyCulture request', creator_name: 'Mitti' }]) {
    assert.equal(workOrderImportLabel(order), null, JSON.stringify(order));
  }
});

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/WorkOrderImportPill.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require(name) {
  if (name === 'react/jsx-runtime') return jsx;
  if (name === '@/lib/work-order-import-provenance') return provenance;
  throw new Error(name);
} });

test('repeated rendering has one pill, preserves original attribution/notes/status, and clears with metadata', () => {
  const order = Object.freeze({ ...imported(batch + '0006|CUR-006|AC-6131'), creator_name: 'Original requester', notes: 'Full original provenance', status: 'Closed' });
  const before = JSON.stringify(order);
  for (let i = 0; i < 5; i++) {
    const html = renderToStaticMarkup(React.createElement(exports.default, { order }));
    assert.equal((html.match(/data-work-order-import-pill/g) || []).length, 1);
    assert.match(html, /Imported from Mitti/);
    assert.match(html, /title="Imported from SafetyCulture \/ Mitti via the approved September 15, 2026 workbook"/);
    assert.doesNotMatch(html, /<button|<a /);
  }
  assert.equal(JSON.stringify(order), before);
  assert.equal(renderToStaticMarkup(React.createElement(exports.default, { order: {} })), '');
});
