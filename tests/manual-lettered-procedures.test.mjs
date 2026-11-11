import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLetteredTroubleshootingProcedures } from '../src/lib/manual-lettered-procedures.ts';
import { structureManualDocument, renderManualPageHtml } from '../src/lib/manual-document-html.ts';

const extract = text => readLetteredTroubleshootingProcedures(structureManualDocument(text));
const sample = `PAGE 17
Troubleshooting
3. DOOR CANNOT OPEN/NO CYCLE FUNCTION
The controller prevents unlocking until rotation has stopped.
WARNING: Isolate electrical power before inspecting wiring.
Rotation Sensor Troubleshooting
a. Check the sensor only after the drum stops.
b. Inspect the harness.
c. Repeat step a.
NOTE: Wait until the hourglass disappears before cycling power.
4. HEATING MALFUNCTION
Do not transfer this heating instruction.`;

test('groups complete source actions with heading, prerequisites, subheading and trailing safety note', () => {
  const rules = extract(sample);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].match, ['DOOR CANNOT OPEN/NO CYCLE FUNCTION', 'DOOR CANNOT OPEN', 'NO CYCLE FUNCTION']);
  assert.deepEqual(rules[0].source_pages, [17]);
  assert.equal(rules[0].steps.length, 1);
  assert.equal(rules[0].steps[0], sample.split('\n').slice(2, -2).join('\n'));
  assert.ok(!rules[0].steps[0].includes('heating instruction'));
});

test('generic titles and varying procedures work across manuals, with title conditions intact', () => {
  const other = `PAGE 9\nPump Troubleshooting\n1) Pump fails when cold/No flow\nService only after isolating the supply.\na) Disconnect the supply.\nb) Check the valve.\nCAUTION: Allow the assembly to cool.\n2) Pump leaks\nNo alphabetic instructions.`;
  const result = extract(other);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].match, ['Pump fails when cold/No flow']);
  assert.deepEqual(result[0].source_pages, [9]);
  assert.ok(result[0].steps[0].includes('Service only after isolating the supply.'));
  assert.deepEqual(extract(sample.replace('DOOR CANNOT OPEN/NO CYCLE FUNCTION', 'LOW/NO PRESSURE'))[0].match, ['LOW/NO PRESSURE']);
});

test('uppercase alphabetic markers preserve source order and text', () => {
  const text = sample.replace(/^([a-c])\./gm, marker => marker.toUpperCase());
  const [rule] = extract(text);
  assert.ok(rule);
  assert.equal(rule.steps[0], text.split('\n').slice(2, -2).join('\n'));
  assert.deepEqual(extract(text.replace('B. Inspect', 'D. Inspect')), []);
});

test('incomplete, out-of-order, absent-scope and cross-page groups are rejected', () => {
  for (const text of [
    sample.replace('Troubleshooting\n', 'Overview\n'),
    sample.replace('b. Inspect', 'd. Inspect'),
    sample.replace('b. Inspect', 'a. Inspect'),
    sample.replace('a. Check', 'b. Check'),
    sample.replace('before cycling power.', 'before cycling'),
    sample.replace('b. Inspect the harness.', 'b. Inspect the harness only after'),
    sample.slice(0, sample.indexOf('4. HEATING')),
    sample.replace('4. HEATING', '\n\nPAGE 18\n4. HEATING'),
    sample.replace('b. Inspect', '\n\nPAGE 18\nb. Inspect'),
    sample.replace('4. HEATING', '5. HEATING'),
    sample.replace('b. Inspect the harness.', 'b. The harness is loose.'),
  ]) assert.deepEqual(extract(text), [], text);
});

test('new unnumbered sections and tables cannot inherit an earlier symptom', () => {
  assert.deepEqual(extract(sample.replace('NOTE:', 'Maintenance\nNOTE:')), []);
  assert.deepEqual(extract(sample.replace('b. Inspect the harness.', 'b. Inspect the harness.\nProblem | Cause | Remedy')), []);
  assert.deepEqual(extract(sample.replace('3. DOOR CANNOT OPEN/NO CYCLE FUNCTION', '3. General information')), []);
});

test('an unrelated section revokes earlier troubleshooting scope', () => {
  assert.deepEqual(extract(sample.replace('3. DOOR', 'Maintenance\n3. DOOR')), []);
  assert.deepEqual(extract(sample.replace('Rotation Sensor Troubleshooting', 'Maintenance')), []);
});

test('qualification text stays inert through existing HTML generator', () => {
  const text = sample.replace('Wait until the hourglass', 'Keep <img src=x onerror=alert(1)> visible; wait until the hourglass');
  const rules = extract(text);
  assert.equal(rules.length, 1);
  assert.ok(rules[0].steps[0].includes('<img src=x onerror=alert(1)>'));
  const html = renderManualPageHtml(structureManualDocument(text)[0]);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img'));
});

test('actual local extracted PDF retains the whole rotation sensor procedure', { skip: !process.env.ACTUAL_MANUAL_RESULTS }, () => {
  const text = JSON.parse(readFileSync(process.env.ACTUAL_MANUAL_RESULTS, 'utf8'))[0].text;
  const result = extract(text);
  const rule = result.find(rule => rule.match.includes('DOOR CANNOT BE UNLOCKED'));
  assert.ok(rule);
  assert.deepEqual(rule.source_pages, [31]);
  assert.equal(rule.steps.length, 1);
  const step = rule.steps[0];
  for (const source of ['8. DOOR CANNOT BE UNLOCKED/NO CYCLE FUNCTION', 'The AP2 Control Display Board will prevent', 'Rotation Sensor Troubleshooting', 'a. Check the Inputs Outputs Menu', 'b. Make sure the harness', 'c. Check the rotation sensor’s gap setting.', 'd. Repeat step a.', 'e. Replace the rotation sensor as needed.', 'NOTE: If any attempt', 'times.']) assert.ok(step.includes(source), source);
  assert.ok(!step.includes('9. HEATING MALFUNCTION'));
});
