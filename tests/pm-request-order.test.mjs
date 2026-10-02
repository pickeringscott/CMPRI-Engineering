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

test('PM workspace reads workbook data and stages technician saves', () => {
  assert.match(page, /fetch\("\/api\/preventive-maintenance"/);
  assert.match(page, /\/api\/preventive-maintenance\/review/);
  assert.match(page, /status === "pending"/);
  assert.match(page, /Review &amp; confirm…/);
  assert.match(page, /has not changed the live workbook/);
  assert.doesNotMatch(page, /\/api\/corporate-pm/);
});

test('PM is available to dashboard viewers and source forms can be opened read-only', () => {
  assert.match(dashboard, /hasCapability\(session, "view_dashboard"\) && \{ key: "\/engineering\/preventive-maintenance"/);
  assert.match(page, /!canEdit \? "View form"/);
  assert.match(page, /!canEdit \? "View PM form"/);
  assert.match(page, /disabled=\{!canEdit \|\| !!savingKey\}/);
  assert.match(page, /setCanEdit\(result\.can_edit === true \|\| result\.can_review === true\)/);
  assert.match(page, /The PM service resolved this session as read-only/);
  assert.match(page, /type="date" disabled=\{!canEdit \|\| !!savingKey\}/);
});

test('PM submission API persists proposals and never updates legacy native entries', () => {
  assert.match(proposalRoute, /cmpri_pm_proposals/);
  assert.match(proposalRoute, /resolveLivePmChanges/);
  assert.match(proposalRoute, /profileHasRole\(auth\.principal\.profile, "system_admin"\)/);
  assert.doesNotMatch(proposalRoute, /cmpri_pm_entries/);
});

test('only reviewer approval invokes the live workbook apply path', () => {
  assert.match(reviewRoute, /applyLivePmChanges\(cells\)/);
  assert.match(reviewRoute, /profileHasRole\(auth\.principal\.profile, "system_admin"\)/);
  assert.match(workOrderPmRoute, /Direct PM spreadsheet edits from work orders are disabled/);
  assert.doesNotMatch(workOrderPmRoute, /setCorporatePmCheckbox/);
});
