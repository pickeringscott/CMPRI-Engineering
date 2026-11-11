import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { normalizeManualKnowledge } from '../src/lib/manual-knowledge.ts';
import { structureManualDocument, renderManualPageHtml } from '../src/lib/manual-document-html.ts';
import { uploadedManualHtmlActions } from '../src/lib/uploaded-manual-actions.ts';
import { deriveTroubleshootingChecklistContext } from '../src/lib/work-orders/troubleshooting-checklist.ts';
import { extractPdfTroubleshootingTables } from '../src/lib/server/pdf-troubleshooting-tables.ts';

// Only this source import needs a path alias in the optional local PDF run.
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === '@/lib/manual-document-match'
    ? new URL('../src/lib/manual-document-match.ts', import.meta.url).href : specifier, context);
} });
globalThis.fetch = async () => { throw new Error('No network is permitted in isolated manual tests.'); };

const asset = { id: '00000000-0000-4000-8000-000000000099' };
// This is a synthetic association, not evidence of any current asset attachment.
const source = { verified: true, source_kind: 'asset-upload', storage_path: 'isolated-fixture/manual.pdf',
  registered_file_id: '00000000-0000-4000-8000-000000000088', sha256: 'a'.repeat(64) };
const checklist = (knowledge, issue) => deriveTroubleshootingChecklistContext({ issue, asset }, knowledge).steps;

test('semantic source flows through normalized knowledge into complete source-linked checklist text', () => {
  const text = 'PAGE 7\nTroubleshooting\n1. DOOR CANNOT OPEN/NO CYCLE FUNCTION\nWait until rotation has stopped.\na. Disconnect the supply.\nb. Inspect the harness.\nc. Repeat step a.\nNOTE: Do not restore power until guards are installed.\n2. HEATING MALFUNCTION\nNo instructions here.';
  const actions = uploadedManualHtmlActions(structureManualDocument(text));
  const knowledge = normalizeManualKnowledge({ ...actions, source });
  const steps = checklist(knowledge, 'Door cannot open');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, actions.symptom_rules[0].steps[0]);
  assert.deepEqual(steps[0].sourcePages, [7]);
  assert.match(steps[0].label, /c\. Repeat step a\./);
  assert.match(steps[0].label, /NOTE: Do not restore power until guards are installed\./);
  assert.equal(checklist(knowledge, 'Maybe door cannot open').length, 0);
});

test('new parser output cannot bypass the existing verified-attachment guards', () => {
  const actions = uploadedManualHtmlActions(structureManualDocument('PAGE 2\nCommon Scenarios & Solutions\n1. No signal\n• Check the input.'));
  assert.equal(actions.symptom_rules.length, 1);
  for (const change of [{ verified: false }, { source_kind: 'catalog' }, { registered_file_id: '' }, { sha256: '' }]) {
    const knowledge = normalizeManualKnowledge({ ...actions, source: { ...source, ...change } });
    assert.equal(checklist(knowledge, 'No signal').length, 0);
  }
});

const manualCases = [
  ['Troubleshooting Guide Unimac UWN065T4V.pdf', 58, [
    ['No fill analysis', 4, 13], ['Drain error', 5, 47], ['Door cannot be unlocked', 1, 31],
    ['Maybe door cannot be unlocked', 0],
  ]],
  ['Enseo TV Troubleshooting Guide.pdf', 2, [
    ['Remote control not responding', 3, 2], ['No signal', 3, 1], ['Low or no volume', 2, 2], ['No Internet', 1, 2],
    ['TV broken', 0], ['Maybe no signal', 0],
  ]],
  ['Television Troubleshooting Guide.pdf', 2, [
    ['Remote control not responding', 3, 2], ['No signal', 3, 1], ['Low or no volume', 2, 2], ['No Internet', 1, 2],
    ['TV broken', 0],
  ]],
  ['Curtis Coffee Server Parts Diag.pdf', 4, [['LCD display', 0], ['Faucet', 0]]],
  ['Shower Valve Temptrol_Parts_Diagram.pdf', 4, [
    ['Valve will not pass water', 1, 4], ['Valve leaks when shut off', 1, 4], ['Valve is not leaking', 0],
  ]],
];

for (const [file, pageCount, cases] of manualCases) test(`optional actual local PDF to checklist: ${file}`, {
  skip: !process.env.MANUAL_FIXTURE_DIR && 'Set MANUAL_FIXTURE_DIR to an authorized local manual snapshot directory; no files are downloaded.',
}, async () => {
  const { extractManualPdfText } = await import('../src/lib/manual-pdf-knowledge.ts');
  const bytes = new Uint8Array(readFileSync(join(process.env.MANUAL_FIXTURE_DIR, file)));
  const text = await extractManualPdfText(bytes, { includeEmptyPages: true });
  const pages = structureManualDocument(text);
  assert.equal(pages.length, pageCount);
  for (const page of pages) {
    const html = renderManualPageHtml(page);
    assert.ok(html.includes(`data-source-page="${page.page}"`));
    assert.doesNotMatch(html, /<script\b|<iframe\b|onerror\s*=/i);
  }
  const semantic = uploadedManualHtmlActions(pages);
  const coordinate = await extractPdfTroubleshootingTables(bytes);
  const knowledge = normalizeManualKnowledge({ ...semantic, symptom_rules: [...semantic.symptom_rules, ...coordinate],
    source: { ...source, sha256: createHash('sha256').update(bytes).digest('hex') } });
  for (const [issue, count, page] of cases) {
    const steps = checklist(knowledge, issue);
    assert.equal(steps.length, count, issue);
    for (const step of steps) assert.deepEqual(step.sourcePages, [page], issue);
    if (issue === 'Door cannot be unlocked') {
      for (const fragment of ['The AP2 Control Display Board will prevent', 'a. Check the Inputs Outputs Menu',
        'b. Make sure the harness', 'c. Check the rotation sensor’s gap setting.', 'd. Repeat step a.',
        'e. Replace the rotation sensor as needed.', 'NOTE: If any attempt']) assert.ok(steps[0].label.includes(fragment), fragment);
      assert.ok(!steps[0].label.includes('9. HEATING MALFUNCTION'));
    }
    if (issue === 'Drain error') {
      assert.ok(steps.every(step => step.label.includes('If LED 13')));
      assert.match(steps[2].label, /120V or 220V.*debris/);
    }
  }
});
