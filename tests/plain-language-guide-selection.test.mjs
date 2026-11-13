import test from 'node:test';
import assert from 'node:assert/strict';
import { guideRulesForIssue } from '../src/lib/work-orders/guide-selection.ts';

function select(issue, headings) {
  const knowledge = { source: { verified: true }, symptom_rules: headings.map((heading, index) => ({ match: [heading], steps: [`Verbatim source action ${index + 1}.`], source_pages: [index + 10] })) };
  return guideRulesForIssue(knowledge, issue).map(rule => rule.match[0]);
}

test('function-first failure descriptions select only that function across equipment types', () => {
  const headings = ['No Power', 'No heat', 'Not cooling', 'No Drain', 'No Fill', 'Water leak'];
  for (const [issue, expected] of [
    ['Heat not working says its running but never got warm', ['No heat']],
    ['Heating is not working', ['No heat']],
    ['Cooling does not work', ['Not cooling']],
    ['Washer drain is not working', ['No Drain']],
    ['Filling not working', ['No Fill']],
    ['Power is not working', ['No Power']],
    ['No heating issues; cooling not working', ['Not cooling']],
    ['Heating not working earlier; heating is fine', []],
    ['Maybe heating is not working', []],
  ]) assert.deepEqual(select(issue, headings), expected, issue);
});

test('plural issue wording matches the same explicit source heading without guessing a fault code', () => {
  assert.deepEqual(select('Heater has exhaust errors', ['Exhaust error', 'Ignition error', 'Exhaust error when firing']), ['Exhaust error']);
  assert.deepEqual(select('Washer has drain errors', ['Drain error', 'Fill error']), ['Drain error']);
  assert.deepEqual(select('No exhaust errors', ['Exhaust error']), []);
  assert.deepEqual(select('Possibly exhaust errors', ['Exhaust error']), []);
  assert.deepEqual(select('Exhaust errors', ['Error code E110', 'Exhaust error E110']), []);
  assert.deepEqual(select('Cooling issues', ['Not cooling', 'No heat']), ['Not cooling']);
});

for (const issue of ["It won’t turn on", "It won't start", 'The machine does not start', 'The unit cannot turn on']) test(`${issue} selects only explicit power/start or general nonoperation instructions`, () => {
  assert.deepEqual(select(issue, ['No Power', 'Will not start', 'Does not operate', 'No heat', 'Water leak']), ['No Power', 'Will not start', 'Does not operate']);
});

for (const issue of ['Water all over the floor', 'There is water on the floor', 'The machine is leaking', 'Water is all over the floor']) test(`${issue} routes to explicit leak instructions`, () => {
  assert.deepEqual(select(issue, ['Water leak', 'No heat', 'Not filling']), ['Water leak']);
});

test('plain temperature, drain and fill complaints select only their corresponding source symptoms', () => {
  const cases = [
    ["It won't get hot", ['No heat']], ['It will not get warm', ['No heat']],
    ["It won't get cold", ['Not cooling']], ['The air conditioner is not getting cold', ['Not cooling']],
    ["The washer won't drain", ['Washer not draining']], ["It won't fill", ['No Fill']],
  ];
  for (const [issue, expected] of cases) assert.deepEqual(select(issue, ['No heat', 'Not cooling', 'Washer not draining', 'No Fill']), expected, issue);
});

test('loud or rattling reports match explicit noise rules while retaining source steps and pages verbatim', () => {
  assert.deepEqual(select('It is loud', ['Abnormal noise', 'No heat', 'Rattling']), ['Abnormal noise']);
  assert.deepEqual(select('It is rattling', ['Abnormal noise', 'Rattling', 'No heat']), ['Abnormal noise', 'Rattling']);
  const knowledge = { source: { verified: true }, symptom_rules: [{ match: ['Abnormal noise'], steps: ['Inspect the source-listed fastener.'], source_pages: [27] }] };
  const [matched] = guideRulesForIssue(knowledge, 'The machine is loud');
  assert.equal(matched, knowledge.symptom_rules[0]);
  assert.deepEqual(matched.steps, ['Inspect the source-listed fastener.']); assert.deepEqual(matched.source_pages, [27]);
});

test('vague broken or not-working reports never expand into specific failure types', () => {
  const specific = ['No Power', 'No heat', 'Not cooling', 'Not draining', 'Not filling', 'Water leak', 'Abnormal noise'];
  for (const issue of ['It is broken', 'It is not working', "It doesn't work"]) {
    assert.deepEqual(select(issue, specific), [], issue);
    assert.deepEqual(select(issue, [...specific, 'Does not operate', 'Unit not working']), ['Does not operate', 'Unit not working'], issue);
  }
});

test('negated and normal operating symptoms do not select unrelated instructions', () => {
  for (const issue of ["Not leaking; it won't get hot", "No leaks, it won't get hot"]) assert.deepEqual(select(issue, ['Water leak', 'No heat', 'Not cooling']), ['No heat'], issue);
  for (const issue of ['No issue with cooling; loud noise', 'Cooling works; loud noise', 'Cooling is fine and the unit is rattling']) assert.deepEqual(select(issue, ['Cooling', 'Not cooling', 'Abnormal noise']), ['Abnormal noise'], issue);
  assert.deepEqual(select('Was leaking; no longer leaking; not heating', ['Water leak', 'No heat']), ['No heat']);
  assert.deepEqual(select('No leaks earlier, but it is leaking now', ['Water leak', 'No heat']), ['Water leak']);
  assert.deepEqual(select('Guest denies leaking, unit is loud', ['Water leak', 'Abnormal noise']), ['Abnormal noise']);
  for (const issue of ['No cooling issue; loud noise', 'No longer not cooling; loud noise']) assert.deepEqual(select(issue, ['Not cooling', 'Abnormal noise']), ['Abnormal noise'], issue);
  for (const issue of ['No evidence of water leaking; not heating', 'Water on the floor, but not a leak; not heating']) assert.deepEqual(select(issue, ['Water leak', 'No heat']), ['No heat'], issue);
  for (const issue of ['No abnormal rattle; not heating', "It doesn't make noise; not heating"]) assert.deepEqual(select(issue, ['Rattling', 'Abnormal noise', 'No heat']), ['No heat'], issue);
});

test('opposite failure polarities never become interchangeable', () => {
  for (const [issue, headings] of [
    ["It won't stop running", ['Will not start', 'No Power']],
    ['The machine is too hot', ['No heat', 'Will not heat']],
    ['The machine is overfilling', ['Not filling', 'No Fill']],
    ["It won't fill", ['Overfilling']],
    ["It won't drain", ['Draining normally']],
  ]) assert.deepEqual(select(issue, headings), [], issue);
});

test('conditional, component-qualified and code-qualified source headings retain their extra requirements', () => {
  assert.deepEqual(select("It won't get hot", ['No heat during defrost', 'No heat when flow is low', 'No heat']), ['No heat']);
  assert.deepEqual(select('Water all over the floor', ['Leaks only during filling', 'Water leak']), ['Water leak']);
  assert.deepEqual(select("It won't drain", ['Will not drain when door is open', 'F1 not draining', 'No Drain']), ['No Drain']);
  assert.deepEqual(select('Fault code F10 and washer not draining', ['F1 not draining', 'No Drain']), ['No Drain']);
  assert.deepEqual(select("It won't turn on", ['Compressor no power', 'No Power']), ['No Power']);
  assert.deepEqual(select("The compressor won't turn on", ['Compressor no power']), ['Compressor no power']);
  assert.deepEqual(select('No heat during defrost', ['No heat during defrost']), ['No heat during defrost']);
});

test('literal technical phrases preserve word boundaries, manual tests and unverified-source refusal', () => {
  assert.deepEqual(select('The thermostat is showing fault code F10', ['F1', 'F10']), ['F10']);
  assert.deepEqual(select('Defrost sensor fault', ['Defrost sensor fault']), ['Defrost sensor fault']);
  assert.deepEqual(select('Coolant leak', ['cool']), []);
  const testEntry = { match: ['No Drain'], steps: ['Use the exact manufacturer drain test.'], source_pages: [9] };
  const result = guideRulesForIssue({ source: { verified: true }, manual_tests: [testEntry] }, "It won't drain");
  assert.deepEqual(result[0].steps, testEntry.steps); assert.deepEqual(result[0].source_pages, [9]);
  assert.deepEqual(guideRulesForIssue({ source: { verified: false }, symptom_rules: [{ match: ['No Power'], steps: ['Unapproved.'] }] }, "It won't turn on"), []);
  assert.deepEqual(select("It won't turn on", ['NoPower']), ['NoPower']);
  assert.deepEqual(select("It won't drain", ['NoDrain']), ['NoDrain']);
  assert.deepEqual(select("It won't fill", ['NoFill']), ['NoFill']);
});

test('denied, hypothetical and qualified literal source phrases cannot bypass conservative matching', () => {
  for (const [issue, headings] of [
    ['It is not making any noise.', ['Abnormal noise']],
    ["It doesn't make a loud noise.", ['Abnormal noise']],
    ["I don't hear any noise.", ['Abnormal noise']],
    ['It never gets noisy.', ['Abnormal noise']],
    ['It is not a water leak.', ['Water leak']],
    ['There is no visible water leak.', ['Water leak']],
    ['There is no unusual vibration.', ['Vibration']],
    ['No leaks or noise.', ['Water leak', 'Abnormal noise']],
    ['It is not leaking or noisy.', ['Water leak', 'Abnormal noise']],
    ['The noise is normal.', ['Abnormal noise']],
    ['It vibrates normally.', ['Vibration']],
    ['No heat with no gas odor present', ['No heat — gas odor present']],
    ['No heat without gas odor present', ['No heat — gas odor present']],
    ['No heat flow switch not open', ['No heat flow switch open']],
    ['No power when door open is ruled out; noisy', ['No power when door open']],
    ['No power when door open was not found; noisy', ['No power when door open']],
    ['No power when door open has not been observed; noisy', ['No power when door open']],
    ['No heat gas odor present is not the problem; noise', ['No heat gas odor present']],
    ['If there is no power when door open; noisy', ['No power when door open']],
    ['No error code F1 is displayed; only noisy.', ['Code F1', 'F1 is displayed']],
    ['Fault code F10; not draining.', ['F1', 'F1 not draining']],
  ]) assert.deepEqual(select(issue, headings), [], issue);
  assert.deepEqual(select('No power when door open', ['No power when door open']), ['No power when door open'], 'the failure negation inside a positively reported source heading is preserved');
  assert.deepEqual(select('No heat gas odor present', ['No heat gas odor present']), ['No heat gas odor present']);
});
