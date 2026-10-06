import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findReferencedPmTemplate } from '../src/lib/pm/references.ts';

const root = fileURLToPath(new URL('../src/lib/pm/', import.meta.url));
const sourceCatalog = JSON.parse(readFileSync(path.join(root, 'source-catalog.json'), 'utf8'));
const page = readFileSync(path.join(root, '../../app/engineering/preventive-maintenance/page.tsx'), 'utf8');
const templates = [
  { kind: 'routine', sourceFile: 'MaintenanceWorkbook.xlsx' },
  { kind: 'log', sourceFile: 'Monthly Sprinkler Valve Insp.pdf' },
  { kind: 'log', sourceFile: 'Monthly Fire Extinguisher Log.pdf' },
  { kind: 'log', sourceFile: 'Emergency lighting-Exit Sign log Master.pdf' },
];

test('routine attachment references with spaces resolve to their complete PM source file', () => {
  for (const filename of [
    'Monthly Sprinkler Valve Insp.pdf',
    'Monthly Fire Extinguisher Log.pdf',
    'Emergency lighting-Exit Sign log Master.pdf',
  ]) {
    const task = sourceCatalog.months.flatMap(({ tasks }) => tasks).find(({ references }) => references.includes(filename));
    assert.ok(task, `Expected a routine item to reference ${filename}`);
    assert.equal(findReferencedPmTemplate(`${task.source} · ${filename}`, templates)?.sourceFile, filename);
  }
});

test('routine rows only show attached-form actions when a matching interactive template exists', () => {
  assert.match(page, /const reference = linkedReference\?\.\(item\.id\) \|\| null/);
  assert.match(page, /findReferencedPmTemplate\(reference, PM_TEMPLATES\).*Open attached form/s);
  assert.match(page, /template\.checklist\.find\(\(item\) => item\.id === itemId\)\?\.source \|\| null/);
  assert.match(page, /No rooms match/);
  assert.doesNotMatch(page, /\.source\?\.match\(\/\[\^, \]\+\\\.pdf\/i\)/);
  assert.equal(findReferencedPmTemplate('DEC!C38 · Tool Inventory.pdf', templates), null);
});
