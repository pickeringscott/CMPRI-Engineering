import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isPmRoutineCellChecked, togglePmRoutineResponse } from '../src/lib/pm/routine-responses.ts';

const root = fileURLToPath(new URL('../src/lib/pm/', import.meta.url));
const sourceCatalog = JSON.parse(readFileSync(path.join(root, 'source-catalog.json'), 'utf8'));
const checklistGroups = [
  ['daily', sourceCatalog.daily],
  ['weekly', sourceCatalog.weekly],
  ...sourceCatalog.months.map((month) => [month.month, month.tasks]),
];

test('every PM routine checkbox toggles only its own checklist item', () => {
  for (const [group, items] of checklistGroups) {
    const checklist = items.map(({ id }) => ({ id }));
    const emptyResponses = Object.fromEntries(checklist.map(({ id }) => [id, false]));
    const seenIds = new Set();

    for (const { id } of checklist) {
      assert.equal(seenIds.has(id), false, `${group} contains duplicate item ID ${id}`);
      seenIds.add(id);
      const responses = togglePmRoutineResponse(checklist, emptyResponses, id, true);
      assert.deepEqual(
        Object.keys(responses).filter((responseId) => responses[responseId]),
        [id],
        `${group} checkbox ${id} changed another item`,
      );
      assert.deepEqual(
        checklist.filter(({ id: responseId }) => emptyResponses[responseId] !== responses[responseId]).map(({ id: responseId }) => responseId),
        [id],
        `${group} checkbox ${id} changed more than one response`,
      );
    }
  }
});

test('unchecking one routine item preserves other checked items', () => {
  const checklist = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  const responses = togglePmRoutineResponse(
    checklist,
    { first: true, second: true, third: false },
    'second',
    false,
  );

  assert.deepEqual(responses, { first: true, second: false, third: false });
});

test('editing a sparse record does not turn unanswered tasks into false responses', () => {
  assert.deepEqual(togglePmRoutineResponse([{id:'first'},{id:'second'}],{},'first',true),{first:true});
});

test('routine checkbox toggles reject missing or duplicate item identifiers', () => {
  assert.throws(
    () => togglePmRoutineResponse([{ id: 'first' }], {}, 'missing', true),
    /not available/,
  );
  assert.throws(
    () => togglePmRoutineResponse([{ id: 'same' }, { id: 'same' }], {}, 'same', true),
    /must be unique/,
  );
});

test('a PM routine checkbox reads only its own target, never another cell in the same task row', () => {
  assert.equal(isPmRoutineCellChecked([{ value: 'FALSE' }, { value: 'TRUE' }]), false);
  assert.equal(isPmRoutineCellChecked([{ value: 'TRUE' }, { value: 'FALSE' }]), true);
  assert.equal(isPmRoutineCellChecked([]), false);
});
