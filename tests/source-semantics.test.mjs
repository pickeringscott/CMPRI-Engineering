import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceSemantics } from '../src/lib/work-orders/source-semantics.ts';

test('explicit safety headings retain the requested source color families', () => {
  for (const source of ['DANGER: Disconnect power before servicing.', '[URGENT] Leave the area.', '### EMERGENCY', '## DANGER ##', 'Emergency — stop operation.']) {
    assert.deepEqual(sourceSemantics(source), { kind: 'urgent', label: 'Urgent', color: '#ef4444' }, source);
  }
  for (const source of ['CAUTION: Hot surface.', '**WARNING:** Disconnect the supply.', '2. [Warning] Keep hands clear.', 'WARNING']) {
    assert.deepEqual(sourceSemantics(source), { kind: 'caution', label: 'Caution', color: '#fbbf24' }, source);
  }
});

test('only an affirmative immediate call instruction adds urgency without a heading', () => {
  for (const source of ['Call a qualified technician immediately.', 'Immediately call the emergency service.', 'Stop operation and contact service immediately if smoke is present.', 'Do not delay; call service immediately.', 'If it does not restart, call service immediately.', 'Call service immediately, not later.']) {
    assert.equal(sourceSemantics(source)?.kind, 'urgent', source);
  }
  for (const source of ['Call service during business hours.', 'Call service when convenient.', 'Inspect the unit immediately.', 'Do not call service immediately.', 'Never contact service immediately.', 'You do not need to call the technician immediately.', 'Call service, but not immediately.', 'Do not immediately call service.', 'If it does not restart, do not call service immediately.', 'Do not, under any circumstances, call immediately.', 'Should I call service immediately?', 'The label says “Call service immediately”.', 'Example: call service immediately.', 'The instructions mention calling service immediately.', 'Call service immediately is not required.', 'Call service immediately should not be necessary.', 'Call service immediately isn’t required.', 'Call service immediately is optional.']) {
    assert.equal(sourceSemantics(source), null, source);
  }
});

test('green means an explicit positive source label, never an inferred task result', () => {
  for (const source of ['COMPLETE', 'SUCCESS: Test ended.', '[COMPLETE]', 'Result: PASS', 'Test result — completed.', 'RESULT: success (indicator on).']) {
    assert.deepEqual(sourceSemantics(source), { kind: 'success', label: 'Complete', color: '#34d399' }, source);
  }
  for (const source of ['incomplete', 'The inspection is incomplete.', 'Complete the following inspection.', 'A successful repair may require parts.', 'Result: failure', 'Result: not complete', 'Result: incomplete', 'Result: complete failure', 'Result: motor stops', 'Success is not confirmed.', 'SUCCESS: Not achieved.', 'COMPLETE: No.', 'SUCCESS: Tests have not passed.', 'Result: SUCCESS — not achieved.']) {
    assert.equal(sourceSemantics(source), null, source);
  }
});

test('positive headings and result labels fail closed when their body explicitly reports a failed outcome', () => {
  for (const source of ['SUCCESS: Inspection failed.', 'COMPLETE: Test result is failure.', 'Result: PASS — inspection failed.', 'SUCCESS: The final installation is unsuccessful.', 'COMPLETE: Required inspection is incomplete.', 'Result: PASS — the target was not achieved.']) {
    assert.equal(sourceSemantics(source), null, source);
  }
  for (const source of ['SUCCESS: Inspection passed.', 'COMPLETE: The inspection finished.', 'Result: PASS — inspection passed.']) {
    assert.equal(sourceSemantics(source)?.kind, 'success', source);
  }
});

test('information and notice labels are blue without treating all notes as labels', () => {
  for (const source of ['INFORMATION: Record the model.', '[NOTICE] Keep this manual.', '## Notice']) {
    assert.deepEqual(sourceSemantics(source), { kind: 'information', label: 'Information', color: '#7dd3fc' }, source);
  }
  for (const source of ['Notice the indicator position.', 'Additional information is available.', 'Note: record the serial number.']) {
    assert.equal(sourceSemantics(source), null, source);
  }
});

test('ordinary failures, issue priorities and negated or quoted warnings receive no invented severity', () => {
  for (const source of ['The motor has failed.', 'The pump is not working.', 'Check warning light.', 'WARNING LIGHT', 'Urgent issue: the fan is not working.', 'Priority is urgent.', 'High priority maintenance request.', 'No danger is present.', 'There is no emergency.', 'This is not a warning.', 'The screen reads "no danger".', 'The instruction says "do not call immediately".', '"DANGER: high voltage" is a quoted label.', 'Pump failure — check power.']) {
    assert.equal(sourceSemantics(source), null, source);
  }
});

test('multiple source captions use consistent precedence without changing input or shared badge state', () => {
  const source = ['NOTICE: Read the source.', 'SUCCESS: Inspection passed.', 'WARNING: Hot surface.'];
  assert.equal(sourceSemantics(...source)?.kind, 'caution');
  assert.equal(sourceSemantics(...source, 'Call service immediately.')?.kind, 'urgent');
  assert.deepEqual(source, ['NOTICE: Read the source.', 'SUCCESS: Inspection passed.', 'WARNING: Hot surface.']);
  const badge = sourceSemantics('DANGER'); badge.label = 'Changed by caller';
  assert.equal(sourceSemantics('DANGER').label, 'Urgent');
  assert.equal(sourceSemantics('', '  '), null);
});
