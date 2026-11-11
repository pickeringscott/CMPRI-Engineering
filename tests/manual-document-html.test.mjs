import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { structureManualDocument, structureManualPage, renderManualPageHtml, sourcePageHtml, manualHtmlGuideText } from '../src/lib/manual-document-html.ts';
import { uploadedManualHtmlActions, uploadedManualActions } from '../src/lib/uploaded-manual-actions.ts';
import { ocrManualActions } from '../src/lib/server/manual-ocr-actions.ts';
import { normalizeManualKnowledge } from '../src/lib/manual-knowledge.ts';
import { guideRulesForIssue } from '../src/lib/work-orders/guide-selection.ts';

test('source pages become semantic headings, ordered steps and tables without losing page evidence', () => {
  const text = 'PAGE 7\nTROUBLESHOOTING\nProblem: Washer not draining\n1. Disconnect power.\n2. Clean the filter.\n\nPAGE 12\nProblem | Cause | Remedy\nNo heat | Blocked inlet | Inspect the inlet.';
  const pages = structureManualDocument(text);
  assert.deepEqual(pages.map(page => page.page), [7, 12]);
  const dom = new JSDOM(pages.map(renderManualPageHtml).join(''));
  assert.equal(dom.window.document.querySelector('[data-source-page="7"] h3').textContent, 'TROUBLESHOOTING');
  assert.deepEqual([...dom.window.document.querySelectorAll('ol li')].map(item => item.textContent), ['Disconnect power.', 'Clean the filter.']);
  assert.equal(dom.window.document.querySelector('[data-source-page="12"] td').textContent, 'No heat');
  const rules = uploadedManualHtmlActions(pages);
  assert.deepEqual(rules.symptom_rules[0].source_pages, [7]);
  assert.deepEqual(rules.symptom_rules[0].steps, ['Disconnect power.', 'Clean the filter.']);
  assert.deepEqual(rules.symptom_rules[1].source_pages, [12]);
  assert.equal(guideRulesForIssue({ source: { verified: true }, ...rules }, 'washer not draining').length, 1);
});

test('complete wrapped list items retain their entire safety condition in HTML and guide steps', () => {
  const text = 'PAGE 3\nProblem: Not draining\n1. Disconnect electrical power only after\nclosing the supply valve.\n2. Remove the cover.';
  const pages = structureManualDocument(text);
  assert.match(renderManualPageHtml(pages[0]), /only after<br>closing the supply valve/);
  assert.match(manualHtmlGuideText(pages), /Disconnect electrical power only after closing the supply valve\./);
  assert.deepEqual(uploadedManualHtmlActions(pages).symptom_rules[0].steps, ['Disconnect electrical power only after closing the supply valve.', 'Remove the cover.']);
  assert.equal(pages[0].text, text.slice('PAGE 3\n'.length), 'the original source text remains unchanged');
});

test('HTML does not invent page associations, reorder numbered items or turn unlabelled prose into repair steps', () => {
  const text = 'PAGE 4\nGeneral checks\n3. Inspect the valve.\n5. Replace the filter.\n\nPAGE 5\nProblem: Not draining\nSafety\n1. Remove the cover.';
  const pages = structureManualDocument(text);
  const dom = new JSDOM(renderManualPageHtml(pages[0]));
  assert.deepEqual([...dom.window.document.querySelectorAll('li')].map(item => item.getAttribute('value')), ['3', '5']);
  assert.deepEqual(uploadedManualHtmlActions(pages), { symptom_rules: [], error_codes: [] });
  assert.deepEqual(structureManualDocument('Problem: Not draining\n1. Clean the filter.'), []);
});

test('PDF and OCR markup is escaped, never interpreted as active HTML', () => {
  const attack = 'Problem: <img src=x onerror=alert(1)>\n1. Inspect <script>alert(1)</script> & the valve.\n2. Check </li><svg onload=alert(2)> wiring.\n<a href="javascript:alert(3)">unsafe</a>';
  const html = sourcePageHtml(attack, 2, 'ocr');
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('script,img,svg,a,iframe,style'), null);
  assert.match(dom.window.document.body.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(dom.window.document.body.textContent, /OCR text: compare with the original source page/);
  for (const element of dom.window.document.querySelectorAll('*')) for (const attribute of element.attributes) assert.ok(!attribute.name.startsWith('on'));
  assert.throws(() => structureManualPage('text', 0), /Invalid/);
  assert.throws(() => structureManualPage('text', 601), /Invalid/);
});

test('supplied HTML is discarded and source metadata survives knowledge normalization', () => {
  const knowledge = normalizeManualKnowledge({ source: { verified: true, source_kind: 'asset-upload', source_file_name: 'Valve.pdf', sha256: 'a'.repeat(64) }, source_passages: [{ page: 6, kind: 'reference', origin: 'ocr', text: 'Door lock stuck\n1. Inspect the latch.\n2. Check the wiring.', html: '<img src=x onerror=alert(1)>' }] });
  const page = knowledge.source_passages[0];
  assert.equal(new JSDOM(page.html).window.document.querySelector('img'), null);
  assert.match(page.html, /data-source-page="6"/);
  assert.match(page.html, /<ol>/);
  assert.equal(knowledge.source.source_file_name, 'Valve.pdf');
  assert.equal(knowledge.source.sha256, 'a'.repeat(64));
});

test('OCR uses the same semantic lists while preserving confidence gates and warning labels', () => {
  const page = { page: 8, confidence: 95, text: 'Door lock stuck\nDisconnect power before servicing.\n1. Inspect the latch only after\nchecking that the power is off.\n2. Check the wiring.' };
  const document = structureManualPage(page.text, page.page, 'ocr', page.confidence);
  assert.match(renderManualPageHtml(document), /data-source-origin="ocr"/);
  const rules = ocrManualActions([page]);
  assert.equal(rules.length, 1);
  assert.match(rules[0].steps[0], /^OCR — Door lock stuck — Disconnect power before servicing\. — 1\. Inspect the latch only after checking that the power is off\./);
  assert.deepEqual(rules[0].source_pages, [8]);
  assert.deepEqual(ocrManualActions([{ ...page, confidence: 40 }]), []);
  assert.deepEqual(ocrManualActions([{ ...page, page: 601 }]), []);
  assert.deepEqual(ocrManualActions([{ ...page, confidence: Number.NaN }]), []);
  assert.deepEqual(uploadedManualActions('PAGE 1\nProblem: Not draining\n1. Disconnect power.\nClose the valve before opening.\n2. Remove the cover.'), { symptom_rules: [], error_codes: [] });
});
