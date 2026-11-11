import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { uploadedManualActions } from '../src/lib/uploaded-manual-actions.ts';
import { guideRulesForIssue } from '../src/lib/work-orders/guide-selection.ts';
import { structureManualDocument, renderManualPageHtml } from '../src/lib/manual-document-html.ts';
const parse = body => uploadedManualActions(`PAGE 7\n${body}`).symptom_rules;

test('generic sequential numbered symptoms preserve entire bullets, labels, conditions and warnings', () => {
  const rules = parse(`Symptoms and Remedies
1. Pump Not Running
• Isolation: Before servicing, disconnect the supply.
Do not open the cover while energized.
• Inspection: If the red indicator is lit, check the inlet
only after the supply is isolated. Keep the cover closed otherwise.
2. Low Pressure
• Filter: The filter can block flow. Inspect the filter.
3. No Display
• Verify the display connection.
Phone Support
• Contact the support desk.`);
  assert.deepEqual(rules, [
    { match:['Pump Not Running'], steps:['Isolation: Before servicing, disconnect the supply. Do not open the cover while energized.', 'Inspection: If the red indicator is lit, check the inlet only after the supply is isolated. Keep the cover closed otherwise.'], source_pages:[7] },
    { match:['Low Pressure'], steps:['Filter: The filter can block flow. Inspect the filter.'], source_pages:[7] },
    { match:['No Display'], steps:['Verify the display connection.'], source_pages:[7] },
  ]);
});

test('does not derive actions from descriptions, labels or adjacent quick-reset instructions', () => {
  const rules = parse(`Quick Reset Steps
1. Unplug the supply.
2. Wait 30 seconds.
Common Scenarios & Solutions
1. No Picture
• Cable: Replacing the cable sometimes helps.
• Check Input: The input might be incorrect.
2. No Sound
• Verify the volume setting.
Maintenance
• Clean the housing.`);
  assert.deepEqual(rules, [{ match:['No Sound'],steps:['Verify the volume setting.'],source_pages:[7] }]);
});

for (const [name, body] of [
  ['ambiguous generic heading', 'Problems and Solutions\n1. Overview\n• Check the cable.'],
  ['missing explicit association', 'Troubleshooting\n1. No Picture\n• Check the cable.'],
  ['procedural numbered heading', 'Problems and Solutions\n1. Check the cable\n• Disconnect power.'],
  ['nonsequential headings', 'Problems and Solutions\n1. No Sound\n• A silent mode exists.\n3. No Picture\n• Check the cable.'],
  ['truncated conditional', 'Problems and Solutions\n1. No Picture\n• Check the cable. Only if the'],
  ['truncated action', 'Problems and Solutions\n1. No Picture\n• Check the cable'],
  ['heading without directly attached bullets', 'Problems and Solutions\n1. No Picture\nThis can have several causes.\n• Check the cable.'],
]) test(`fails closed: ${name}`, () => assert.deepEqual(parse(body), []));

test('new page requires repeated explicit scenario scope', () => {
  assert.deepEqual(uploadedManualActions('PAGE 1\nScenarios and Solutions\n1. No Picture\n• Check the cable.\n\nPAGE 2\n2. No Sound\n• Check the volume.').symptom_rules.map(x=>x.match[0]), ['No Picture']);
});

test('existing explicit symptom and problem extraction remains intact', () => {
  assert.deepEqual(parse('Symptom: No Fill\nAction: Check the valve.\nProblem: No Drain\n• Inspect the hose.').map(x => [x.match, x.steps]), [[['No Fill'],['Check the valve.']], [['No Drain'],['Inspect the hose.']]]);
});

test('source HTML is escaped, never executed, and qualifiers stay in the action', () => {
  const text = 'PAGE 7\nIssues and Solutions\n1. Missing Display\n• Check the label "<script>alert(1)</script>". Do not open the case.';
  const html = renderManualPageHtml(structureManualDocument(text)[0]);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(uploadedManualActions(text).symptom_rules[0].steps[0], 'Check the label "<script>alert(1)</script>". Do not open the case.');
});

// Full local source snapshots are not committed or published with these tests.
// Opt in explicitly when running against the authorized local PDF extraction.
const actualPath = process.env.LOCAL_MANUAL_RESULTS_PATH;
const actual = actualPath ? JSON.parse(fs.readFileSync(actualPath, 'utf8')) : [];
if (!actualPath) test('real local manual snapshots require LOCAL_MANUAL_RESULTS_PATH', { skip: 'No authorized local fixture path supplied.' }, () => {});
if (actualPath) assert.equal(actual.filter(x => /^(Enseo TV|Television) Troubleshooting Guide\.pdf$/.test(x.file)).length, 2, 'Expected both local TV manual snapshots');
for (const fixture of actual.filter(x => /^(Enseo TV|Television) Troubleshooting Guide\.pdf$/.test(x.file))) {
  test(`real local snapshot: ${fixture.file}`, () => {
    const rules = uploadedManualActions(fixture.text).symptom_rules;
    assert.deepEqual(rules.map(x => x.match[0]), ['"No Signal" or Black/Grey Screen','Remote Control Not Responding','Low or No Volume','No Internet']);
    const knowledge = { source: {verified: true}, symptom_rules: rules };
    for (const issue of ['Remote control not responding', 'No signal', 'Low or no volume', 'No Internet']) {
      assert.equal(guideRulesForIssue(knowledge, issue).length, 1, issue);
    }
    for (const denied of ['No signal is ruled out', 'If no signal occurs', 'Remote control not responding is unconfirmed', 'Maybe remote control not responding']) {
      assert.deepEqual(guideRulesForIssue(knowledge, denied), [], denied);
    }
    assert.deepEqual(guideRulesForIssue(knowledge, 'TV broken'), []);
    assert.deepEqual(guideRulesForIssue(knowledge, 'Frozen image or pixelation'), []);
    assert.deepEqual(rules.map(x => x.source_pages), [[1],[2],[2],[2]]);
    assert.deepEqual(rules.map(x => x.steps.length), [3,3,2,1]);
    const source = fixture.text.replace(/\s+/g, ' ');
    for (const rule of rules) for (const step of rule.steps) assert.ok(source.includes(step), `non-verbatim action: ${step}`);
    const output = rules.flatMap(x => x.steps).join('\n');
    assert.ok(output.includes('usually HDMI 1'));
    assert.ok(output.includes('Grey Screen: This often means'));
    assert.ok(output.includes("Two Volume Controls: Both the TV and the Enseo box have volume settings. Ensure"));
    assert.ok(!/Phone Support|Provide them|Wait 7 minutes|If Problem Persists|Pixelation is often/.test(output));
  });
}


test('lowercase standalone section heading ends a completed bullet association', () => {
  const rules = parse('Issues and Solutions\n1. No Picture\n• Check the cable.\ncontact information\n• Provide your address.');
  assert.deepEqual(rules, [{ match: ['No Picture'], steps: ['Check the cable.'], source_pages: [7] }]);
});

test('pipe table titles do not acquire numbered-scenario aliases', () => {
  const rules = parse('Symptom | Action\nNo Signal or Black Screen | Check the cable.');
  assert.deepEqual(rules[0].match, ['No Signal or Black Screen']);
});
