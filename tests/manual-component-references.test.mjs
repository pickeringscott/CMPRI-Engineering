import test from 'node:test';
import assert from 'node:assert/strict';
import { manualSourcePassages, manualReferencePages, relevantSourcePassages, prepareUploadedGuide } from '../src/lib/manual-source.ts';
import { guideRulesForIssue } from '../src/lib/work-orders/guide-selection.ts';

const manuals = [
  { issue: 'Guest has no heat working in room', topic: 'heater', heading: 'TESTING THE HEATING ELEMENTS AND\nLIMIT SWITCHES', body: 'WARNING\nDisconnect power before servicing.\nTest only after removing the power wires. Test below the reset temperature.' },
  { issue: 'Washer not draining', topic: 'drain', heading: 'Drain Pump Inspection', body: 'CAUTION\nDisconnect electrical power.\nClose the supply valve before removing the cover.' },
  { issue: 'Low water pressure', topic: 'pressure', heading: 'TESTING THE WATER\nPRESSURE SWITCH', body: 'WARNING\nIsolate the supply before testing.\nUse only the specified pressure range.' },
];
for (const fixture of manuals) test(`component references retain source safety/context without creating a ${fixture.topic} checklist`, () => {
  const text = `PAGE 2\nSpecifications\nThe ${fixture.topic} is part of this model.\n\nPAGE 9\n${fixture.heading}\n${fixture.body}`;
  const pages = manualReferencePages(text);
  const ranked = relevantSourcePassages(pages, fixture.issue);
  assert.equal(ranked[0].page, 9);
  assert.equal(ranked[0], pages[1]);
  assert.equal(ranked[0].text, `${fixture.heading}\n${fixture.body}`);
  assert.equal(ranked.length, 2, 'incidental matches remain available, below the procedure');
  const component = manualSourcePassages(text).find(page => page.page === 9);
  assert.equal(component.kind, 'reference');
  const prepared = prepareUploadedGuide(text, {}, 'Source.pdf', 'fixture');
  assert.deepEqual(prepared.knowledge.symptom_rules, []);
  assert.deepEqual(guideRulesForIssue(prepared.knowledge, fixture.issue), []);
});

test('ordinary prose and a contents list do not become component procedures', () => {
  assert.deepEqual(manualSourcePassages('PAGE 1\nTesting of the heater can be made with an\nohmmeter.\n\nPAGE 2\nTable of contents\nTESTING THE HEATER'), []);
  const pages = manualReferencePages('PAGE 1\nSpecifications\nDrain pump capacity.\n\nPAGE 2\nTESTING THE HEATER\nDisconnect power.');
  assert.deepEqual(relevantSourcePassages(pages, 'drain failure').map(page => page.page), [1]);
});

test('changed source text invalidates heading ranking cache', () => {
  const pages = [{page:1,text:'TESTING THE HEATER\nDisconnect power.',kind:'reference'}, {page:2,text:'Heater specifications',kind:'reference'}];
  assert.equal(relevantSourcePassages(pages, 'no heat')[0].page, 1);
  pages[0].text = 'TESTING THE DRAIN\nDisconnect power.';
  assert.deepEqual(relevantSourcePassages(pages, 'no heat').map(page => page.page), [2]);
});
