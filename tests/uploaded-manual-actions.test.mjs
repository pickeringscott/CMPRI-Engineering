import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadedManualActions } from '../src/lib/uploaded-manual-actions.ts';

test('explicit symptom sections yield only their verbatim actions with original page numbers', () => {
  const text = `PAGE 7\nACME C1 Troubleshooting\nSymptom: Washer not draining\nPossible cause: Filter blocked.\n1. Disconnect electrical power.\n2. Clean the drain filter.\nProblem: Washer not filling\n• Open the water supply valve.\n• Inlet valve failed.\n\nPAGE 12\nProblem: Washer vibrating\nAction: Inspect the feet for level installation.`;
  const result = uploadedManualActions(text);
  assert.deepEqual(result.symptom_rules, [
    { match: ['Washer not draining'], steps: ['Disconnect electrical power.', 'Clean the drain filter.'], source_pages: [7] },
    { match: ['Washer not filling'], steps: ['Open the water supply valve.'], source_pages: [7] },
    { match: ['Washer vibrating'], steps: ['Inspect the feet for level installation.'], source_pages: [12] },
  ]);
  for (const rule of result.symptom_rules) for (const step of rule.steps) assert.ok(text.includes(step));
  assert.deepEqual(result.error_codes, []);
});

test('explicit delimited troubleshooting rows retain the problem/action association and ignore causes', () => {
  const text = `PAGE 3\nTroubleshooting\nProblem | Possible cause | Corrective action\nNot draining | Filter blocked | Clean the drain filter.\nNot filling | Supply valve closed | Open the water supply valve.\nNo heat | Element failed | Element failed.\nMalformed | Unknown`;
  assert.deepEqual(uploadedManualActions(text).symptom_rules, [
    { match: ['Not draining'], steps: ['Clean the drain filter.'], source_pages: [3] },
    { match: ['Not filling'], steps: ['Open the water supply valve.'], source_pages: [3] },
  ]);
});

test('explicit fault-code headings and action tables produce source-bound diagnostic actions', () => {
  const text = `PAGE 8\nDiagnostic codes\nError code E42: Sensor fault\nAction: Check the sensor connection.\nRemedy: Replace the sensor if its resistance is outside specification.\n\nPAGE 9\nCode | Problem | Remedy\nF-10 | Door open | Close the door and retry.\nRoom 316 | Guest room | Check the room temperature.`;
  assert.deepEqual(uploadedManualActions(text).error_codes, [
    { code: 'E42', problem: 'Sensor fault', action: 'Check the sensor connection.\nReplace the sensor if its resistance is outside specification.', source_pages: [8] },
    { code: 'F-10', problem: 'Door open', action: 'Close the door and retry.', source_pages: [9] },
  ]);
});

test('generic prose, references, missing page evidence and ambiguous table layouts do not invent actions', () => {
  for (const text of [
    'Symptom: Not draining\n1. Clean the filter.',
    'PAGE 1\nGeneral checks\n1. Clean the filter.\n2. Inspect the pump.',
    'PAGE 1\nTroubleshooting\nProblem Possible cause Corrective action\nNot draining Blocked filter Clean the filter.',
    'PAGE 1\nProblem: Not draining\n1. See the service manual for details.\n2. Filter blocked.',
    'PAGE 1\nProblem: Not draining\nThe following section describes unrelated inspection.\n1. Replace the heating element.',
    'PAGE 1\nFault code information\nE42 Sensor fault Check wiring.',
  ]) assert.deepEqual(uploadedManualActions(text), { symptom_rules: [], error_codes: [] }, text);
});

test('page and section boundaries prevent unrelated later instructions from inheriting a symptom', () => {
  const text = `PAGE 4\nSymptom: Not draining\n1. Clean the filter.\nPreventive maintenance\n2. Lubricate the motor bearing.\n\nPAGE 5\n1. Replace the heating element.`;
  assert.deepEqual(uploadedManualActions(text).symptom_rules, [
    { match: ['Not draining'], steps: ['Clean the filter.'], source_pages: [4] },
  ]);
});

test('a new symptom heading cannot transfer the previous symptom actions', () => {
  const result = uploadedManualActions('PAGE 2\nProblem: Not draining\n1. Clean the filter.\nProblem: Not heating\n1. Inspect the heater.');
  assert.equal(result.symptom_rules.length, 2);
  assert.deepEqual(result.symptom_rules[0].steps, ['Clean the filter.']);
  assert.deepEqual(result.symptom_rules[1].steps, ['Inspect the heater.']);
});

test('wrapped or incomplete actions cannot lose a safety condition when converted to checkboxes', () => {
  for (const text of [
    'PAGE 1\nProblem: Not draining\n1. Disconnect electrical power only after\nclosing the supply valve.\n2. Remove the cover.',
    'PAGE 1\nProblem: Not draining\n1. Disconnect electrical power.\nClose the supply valve before removing the cover.\n2. Remove the cover.',
    'PAGE 1\nProblem | Cause | Corrective action\nNot draining | Blocked filter | Disconnect electrical power only after\nclosing the supply valve.',
    'PAGE 1\nProblem: Not draining\nAction: Disconnect power before',
  ]) assert.deepEqual(uploadedManualActions(text), { symptom_rules: [], error_codes: [] }, text);
});
