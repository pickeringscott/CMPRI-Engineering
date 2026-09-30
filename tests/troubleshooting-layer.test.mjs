import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualKnowledge } from '../src/lib/manual-knowledge.ts';

test('normalizeManualKnowledge preserves general checks and manual tests', () => {
  const knowledge = normalizeManualKnowledge({
    manufacturer: 'Friedrich',
    equipment: 'Vert-I-Pak',
    source: { verified: true, title: 'Verified manual', source_file_name: 'manual.pdf' },
    general_checks: ['Check breaker and power'],
    manual_tests: [
      { title: 'Power cycle the unit', test: 'Power cycle and wait 60 seconds.', source_pages: [12, 13] },
    ],
    symptom_rules: [
      { match: ['not cooling'], steps: ['Verify the filter and condenser coil.'], source_pages: [14] },
    ],
  });

  assert.ok(knowledge);
  assert.deepEqual(knowledge.general_checks, ['Check breaker and power']);
  assert.equal(knowledge.manual_tests.length, 1);
  assert.equal(knowledge.manual_tests[0].title, 'Power cycle the unit');
  assert.equal(knowledge.symptom_rules.length, 1);
});

test('normalizeManualKnowledge does not fabricate a match when the payload has no structured guidance', () => {
  const knowledge = normalizeManualKnowledge({
    manufacturer: 'Generic',
    equipment: 'Unknown',
    source: { verified: false, title: 'Uploaded PDF' },
    error_codes: [],
    symptom_rules: [],
  });

  assert.ok(knowledge);
  assert.deepEqual(knowledge.general_checks, []);
  assert.deepEqual(knowledge.manual_tests, []);
  assert.deepEqual(knowledge.symptom_rules, []);
});
