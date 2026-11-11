import test from 'node:test';
import assert from 'node:assert/strict';
import { canReconcileChecklistSummary } from '../src/lib/work-orders/troubleshooting-summary.ts';
const base={id:'ticket',revision:3,issue:'No heat',status:'Open',priority:'High',notes:'Earlier note'};
test('a saved checklist summary can advance revision without replacing a draft',()=>{
  assert.equal(canReconcileChecklistSummary(base,{...base,revision:4,notes:'Earlier note\nTroubleshooting: checked.'},base.notes),true);
});
test('concurrent field or local history edits are never silently rebased',()=>{
  assert.equal(canReconcileChecklistSummary(base,{...base,revision:4,status:'Closed',notes:'Earlier note\nSummary'},base.notes),false);
  assert.equal(canReconcileChecklistSummary(base,{...base,revision:4,notes:'Replaced note'},base.notes),false);
  assert.equal(canReconcileChecklistSummary(base,{...base,revision:4,notes:'Earlier note\nSummary'},'local changes'),false);
  assert.equal(canReconcileChecklistSummary(base,{...base,revision:2,notes:'Earlier note\nSummary'},base.notes),false);
});
