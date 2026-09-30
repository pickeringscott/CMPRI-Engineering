import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));

function fixture(config = {}) {
  const calls = [];
  const monthValues = Array.from({ length: 38 }, () => []);
  const monthFormulas = Array.from({ length: 38 }, () => []);
  monthValues[0][0] = 'MAINTENANCE SCHEDULE | DAILY / WEEKLY CHECKLIST';
  monthValues[3][0] = 'DAILY';
  monthValues[4][8] = 'DATE';
  monthValues[4][9] = '01/05/26';
  monthValues[4][10] = '01/06/26';
  monthValues[5][0] = 'FIRE/LIFE SAFETY';
  monthValues[6][0] = 'Check Fire Panel for Troubles';
  monthValues[6][9] = 'TRUE';
  monthValues[6][10] = 'FALSE';
  monthValues[7][0] = 'Check Fire Pump';
  monthValues[7][9] = 'FALSE';
  monthValues[7][10] = 'TRUE';
  monthValues[16][0] = 'WEEKLY';
  monthValues[17][12] = 'WK1';
  monthValues[17][19] = 'WK2';
  monthValues[18][0] = 'Weekly Property Walk';
  monthValues[18][12] = 'TRUE';
  monthValues[18][19] = 'FALSE';
  monthValues[25][0] = 'MAINTENANCE SCHEDULE | JANUARY MONTHLY / QUARTERLY CHECKLIST';
  monthValues[28][0] = 'TRUE';
  monthValues[28][1] = '1';
  monthValues[28][2] = 'Inspect rooftop drains';
  monthValues[29][0] = 'FALSE';
  monthValues[29][1] = '2';
  monthValues[29][2] = 'Inspect exterior lighting';
  monthFormulas[6][10] = config.formulaCell ? '=FORMULA' : '';

  const yearValues = Array.from({ length: 12 }, () => []);
  const yearFormulas = Array.from({ length: 12 }, () => []);
  yearValues[8] = ['Room Number', 'Q1', 'Q2', 'Q3', 'Q4'];
  yearValues[9] = ['101', '1/2/2026', '', '9/21/2026', ''];
  yearFormulas[9][4] = config.quarterFormula ? '=FORMULA' : '';

  const modulePath = path.join(root, 'lib/server/live-pm.ts');
  const exports = {};
  const source = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const googleSheetsRequest = async (spreadsheet, requestPath, init = {}) => {
    calls.push({ spreadsheet, requestPath });
    if (requestPath === '/values:batchUpdate') {
      const body = JSON.parse(init.body);
      for (const item of body.data) {
        const match = item.range.match(/!([A-Z]+)(\d+)$/);
        const column = [...match[1]].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        monthValues[Number(match[2]) - 1][column] = item.values[0][0] === 'TRUE' || item.values[0][0] === 'FALSE'
          ? item.values[0][0]
          : item.values[0][0];
      }
      return {};
    }
    const range = decodeURIComponent(requestPath.slice('/values/'.length).split('?')[0]);
    const sheet = range.match(/^'([^']+)'/)?.[1] || '';
    const formulas = requestPath.includes('valueRenderOption=FORMULA');
    if (sheet === '2026') return { values: formulas ? yearFormulas : yearValues };
    if (sheet === 'JAN') return { values: formulas ? monthFormulas : monthValues };
    return { values: [] };
  };
  vm.runInNewContext(source, {
    exports,
    process: { env: {
      CMPRI_LIVE_PM_SPREADSHEET_ID: config.spreadsheetId ?? 'live-pm-sheet',
      CMPRI_LIVE_PM_WRITES_ENABLED: config.writesEnabled ? 'true' : 'false',
    } },
    Date,
    Map,
    Promise,
    Error,
    encodeURIComponent,
    require(name) {
      if (name === 'server-only') return {};
      if (name === '@/lib/server/google-sheets') return { googleSheetsRequest };
      if (name === '@/lib/pm/catalog') return {
        findPmTemplate(id) {
          return id === 'daily' ? {
            id,
            kind: 'routine',
            cadence: 'daily',
            checklist: [{ id: 'fire-panel', label: 'Check Fire Panel for Troubles' }],
          } : null;
        },
        pmWeekStart(value) {
          const date = new Date(`${value}T12:00:00Z`);
          date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
          return date.toISOString().slice(0, 10);
        },
      };
      if (name === '@/lib/server/integrations-safe-mode') {
        return { IntegrationConfigurationError: class IntegrationConfigurationError extends Error {
          constructor(message) {
            super(message);
            this.name = 'IntegrationConfigurationError';
          }
        } };
      }
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { api: exports, calls, monthValues };
}

test('Live PM reads daily, weekly, monthly, and quarterly room cells from the workbook', async () => {
  const f = fixture();
  const result = await f.api.readLivePmWeek('2026-01-05');
  assert.equal(result.year, 2026);
  assert.deepEqual(JSON.parse(JSON.stringify(result.daily['2026-01-05'].map((task) => [task.label, task.targets[0].value]))), [
    ['Check Fire Panel for Troubles', 'TRUE'],
    ['Check Fire Pump', 'FALSE'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.weekly.JAN.map((task) => [task.label, task.targets.map((target) => target.period)]))), [
    ['Weekly Property Walk', ['WK1']],
  ]);
  assert.equal(result.monthly.JAN[0].label, 'Inspect rooftop drains');
  assert.equal(result.rooms[0].room, '101');
  assert.equal(result.rooms[0].quarters.Q1.value, '1/2/2026');
  assert.equal(f.calls.length, 4);
});

test('Live PM excludes formula-backed checklist and quarterly date cells', async () => {
  const f = fixture({ formulaCell: true, quarterFormula: true });
  const result = await f.api.readLivePmWeek('2026-01-05');
  assert.equal(result.daily['2026-01-06'].some((task) => task.label === 'Check Fire Panel for Troubles'), false);
  assert.equal(result.rooms[0].quarters.Q4, null);
});

test('Live PM requires a configured source workbook', async () => {
  const f = fixture({ spreadsheetId: '' });
  await assert.rejects(
    () => f.api.readLivePmWeek('2026-01-05'),
    (error) => error.name === 'IntegrationConfigurationError' && /CMPRI_LIVE_PM_SPREADSHEET_ID/.test(error.message),
  );
});

test('Live PM proposes cell changes against current values without writing', async () => {
  const f = fixture();
  const changes = await f.api.resolveLivePmChanges({
    templateId: 'daily',
    periodStart: '2026-01-05',
    scopeKey: 'property',
    responses: { 'fire-panel': false },
    completedOn: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{
    sheet: 'JAN',
    row: 7,
    column: 10,
    label: 'Check Fire Panel for Troubles',
    kind: 'checkbox',
    expectedValue: 'TRUE',
    proposedValue: 'FALSE',
  }]);
  assert.equal(f.calls.every(({ requestPath }) => !requestPath.includes(':batchUpdate')), true);
});

test('Live PM approval is blocked unless the separate write gate is enabled', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.api.applyLivePmChanges([{
      sheet: 'JAN',
      row: 7,
      column: 10,
      label: 'Check Fire Panel for Troubles',
      kind: 'checkbox',
      expectedValue: 'TRUE',
      proposedValue: 'FALSE',
    }]),
    /CMPRI_LIVE_PM_WRITES_ENABLED/,
  );
  assert.equal(f.calls.length, 0);
});

test('Live PM approval rechecks an editable checkbox and verifies its write', async () => {
  const f = fixture({ writesEnabled: true });
  const result = await f.api.applyLivePmChanges([{
    sheet: 'JAN',
    row: 7,
    column: 10,
    label: 'Check Fire Panel for Troubles',
    kind: 'checkbox',
    expectedValue: 'TRUE',
    proposedValue: 'FALSE',
  }]);
  assert.equal(result.written, 1);
  assert.equal(f.monthValues[6][9], 'FALSE');
  assert.equal(f.calls.filter(({ requestPath }) => requestPath === '/values:batchUpdate').length, 1);
});
