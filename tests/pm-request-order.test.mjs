import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const page = readFileSync(path.join(root, 'app/engineering/preventive-maintenance/page.tsx'), 'utf8');
const dashboard = readFileSync(path.join(root, 'app/engineering/page.tsx'), 'utf8');
const proposalRoute = readFileSync(path.join(root, 'app/api/preventive-maintenance/route.ts'), 'utf8');
const reviewRoute = readFileSync(path.join(root, 'app/api/preventive-maintenance/review/route.ts'), 'utf8');
const workOrderPmRoute = readFileSync(path.join(root, 'app/api/work-orders/[id]/preventive-maintenance/route.ts'), 'utf8');

test('PM workspace loads CMPRI records and stages technician saves', () => {
  assert.match(page, /fetch\("\/api\/preventive-maintenance"/);
  assert.match(page, /\/api\/preventive-maintenance\/review/);
  assert.match(page, /status === "pending"/);
  assert.match(page, /\/api\/preventive-maintenance\/task/);
  assert.doesNotMatch(page, /Google Sheets sync is temporarily disabled|Google Sheets integration is disconnected/);
  assert.match(proposalRoute, /workbook: emptyPmWorkbook\(week\)/);
  assert.match(proposalRoute, /spreadsheet_sync_enabled: false/);
  assert.doesNotMatch(page, /\/api\/corporate-pm/);
});

test('PM visibility is capability-gated and source forms can be opened read-only', () => {
  assert.match(dashboard, /hasCapability\(session, "view_pm"\) && \{ key: "\/engineering\/preventive-maintenance"/);
  assert.match(page, /\["pending", "processing"\]\.includes\(existingSingle\?\.status \|\| ""\) && !existingSingle\?\.can_edit_entry/);
  assert.match(page, /\["pending", "processing"\]\.includes\(entry\?\.status \|\| ""\) && !entry\?\.can_edit_entry/);
  assert.match(page, /disabled=\{!activeCanEdit \|\| !!savingKey\}/);
  assert.match(page, /setCanEdit\(result\.can_edit === true \|\| result\.can_review === true\)/);
  assert.match(page, /can_edit_entry/);
  assert.match(page, /taskEditable\(state, actor\)/);
  assert.match(page, /The PM service resolved this session as read-only/);
  assert.match(page, /disabled=\{!canEdit \|\| !taskEditable\(state, actor\) \|\| !liveWorkbook \|\| savingFor\(period\)\}/);
  assert.doesNotMatch(page, /disabled=\{!canEdit \|\| loading \|\| savingFor\(period\)\}/);
  assert.doesNotMatch(page, /Refreshing PM records\. You can continue using the last loaded checklist/);
  assert.match(page, /type="date" disabled=\{!activeCanEdit \|\| !!savingKey\}/);
});

test('PM submission API persists proposals and never updates legacy native entries', () => {
  assert.match(proposalRoute, /cmpri_pm_proposals/);
  assert.doesNotMatch(proposalRoute, /readLivePmWeek|resolveLivePmChanges/);
  assert.match(proposalRoute, /spreadsheet_sync_enabled: false/);
  assert.match(proposalRoute, /const proposedCells: PmProposedCell\[\] = \[\]/);
  assert.match(proposalRoute, /profileHasRole\(auth\.principal\.profile, "system_admin"\)/);
  assert.doesNotMatch(proposalRoute, /cmpri_pm_entries/);
});

test('PM reviewer approval never accesses Google Sheets while sync is disabled', () => {
  assert.doesNotMatch(reviewRoute, /applyLivePmChanges|readLivePm/);
  assert.match(reviewRoute, /Google Sheets sync is disabled/);
  assert.match(reviewRoute, /profileHasRole\(auth\.principal\.profile, "system_admin"\)/);
  assert.match(reviewRoute, /profileHasRole\(auth\.principal\.profile, "engineer"\)/);
  assert.match(workOrderPmRoute, /Direct PM spreadsheet edits from work orders are disabled/);
  assert.doesNotMatch(workOrderPmRoute, /setCorporatePmCheckbox/);
});
