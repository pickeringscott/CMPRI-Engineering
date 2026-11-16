import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { runInNewContext } from 'node:vm';
import { createPoolReport, reportMonths, reportReading } from '../src/lib/pool-report.ts';

test('inclusive MM/YY ranges span years and validate input', () => {
  assert.deepEqual(reportMonths('12/25', '02/26'), ['2025-12', '2026-01', '2026-02']);
  assert.equal(reportMonths('01/26', '12/26').length, 12);
  for (const [a,b] of [['13/26','12/26'], ['1/26','12/26'], ['12/26','01/26'], ['01/00','01/99']]) assert.throws(() => reportMonths(a,b));
});

test('shared samples fill both ends; distinct historical values remain intact', () => {
  const row = { log_date: '2026-01-01', ph_am: 7.4, sanitizer_band_am: '3-6', ph_deep_pm: 7.2, ph_shallow_pm: 7.6 };
  for (const end of ['shallow', 'deep']) {
    assert.equal(reportReading(row, 'ph', end, 'am'), '7.4');
    assert.equal(reportReading(row, 'sanitizer', end, 'am'), '3-6');
    assert.equal(reportReading(row, 'sanitizer', end, 'pm'), '');
  }
  assert.equal(reportReading(row, 'ph', 'deep', 'pm'), '7.2');
  assert.equal(reportReading(row, 'ph', 'shallow', 'pm'), '7.6');
});

test('annual output keeps the official Letter pages and adds readable long remarks', async () => {
  const template = readFileSync(new URL('../public/forms/swimming-facility-daily-operational-report.pdf', import.meta.url));
  const logs = [{ log_date: '2026-01-01', ph_am: 7.4, ph_pm: 7.6, sanitizer_band_am: '3-6', sanitizer_band_pm: '5-10', flow_rate_gpm: 80, temperature_f: 86, main_drain_visible: true, filter_backwashed: false, completed_by_initials: 'SP', remarks: 'Normal daily inspection.' }];
  const bytes = await createPoolReport(template, reportMonths('01/26','12/26'), logs);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 12);
  for (const page of pdf.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 792 });
  if (process.env.POOL_REPORT_SAMPLE) writeFileSync(process.env.POOL_REPORT_SAMPLE, bytes);
  const long = await createPoolReport(template, ['2026-01'], [{ ...logs[0], remarks: 'Long note with Unicode 🏊. '.repeat(500) }]);
  assert.ok((await PDFDocument.load(long)).getPageCount() > 2);
});


test('PDF template buffers from the desktop parent window are accepted', async () => {
  const bytes = readFileSync(new URL('../public/forms/swimming-facility-daily-operational-report.pdf', import.meta.url));
  const parentBuffer = runInNewContext('new Uint8Array(bytes).buffer', { bytes: Array.from(bytes) });
  assert.equal(parentBuffer instanceof ArrayBuffer, false);
  const report = await createPoolReport(parentBuffer, ['2026-01'], []);
  assert.equal((await PDFDocument.load(report)).getPageCount(), 1);
});
