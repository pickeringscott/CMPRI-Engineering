import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { loadImage } from '@napi-rs/canvas';
import { loadTs } from './helpers/load-ts.mjs';
import * as matching from '../src/lib/manual-document-match.ts';
import { uploadedManualActions } from '../src/lib/uploaded-manual-actions.ts';
import { inspectUploadedGuideMedia, renderUploadedGuideMedia, renderUploadedGuidePage } from '../src/lib/server/uploaded-guide-media.ts';

const require = createRequire(import.meta.url);
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
const pdfUtility = loadTs('src/lib/manual-pdf-knowledge.ts', {
  'node:crypto': { createHash }, '@/lib/manual-document-match': matching,
  'pdfjs-dist/legacy/build/pdf.mjs': { ...pdfjs, getDocument: input => pdfjs.getDocument({ ...input, verbosity: 0 }) },
});
const bytes = new Uint8Array(readFileSync(new URL('./fixtures/uploaded-guide-diagrams.pdf', import.meta.url)));
const replacement = new Uint8Array(readFileSync(new URL('./fixtures/uploaded-guide-diagrams-replacement.pdf', import.meta.url)));
const sha = data => createHash('sha256').update(data).digest('hex');
const sha256 = sha(bytes);
const originalFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = async () => { externalRequests++; throw new Error('PDF media may not fetch remote images, providers or catalogs.'); };
after(() => { globalThis.fetch = originalFetch; assert.equal(externalRequests, 0); });
let actual;
async function extracted() {
  if (actual) return actual;
  const text = await pdfUtility.extractManualPdfText(bytes);
  const actions = uploadedManualActions(text);
  const steps = [...actions.symptom_rules.flatMap(rule => rule.steps.map(stepLabel => ({ stepLabel, sourcePages: rule.source_pages }))),
    ...actions.error_codes.map(code => ({ stepLabel: code.action, sourcePages: code.source_pages }))];
  const media = await inspectUploadedGuideMedia(bytes, { sha256, steps });
  return actual = { text, actions, steps, media };
}

// A positioned, real vector PDF exercises ambiguity and huge page geometry.
function vectorPdf({ captions, drawings, width = 612, height = 792, externalAnnotation = false }) {
  const escape = value => value.replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&');
  const stream = captions.map(({ text, x, y }) => `BT /F1 12 Tf ${x} ${y} Td (${escape(text)}) Tj ET`).join('\n')
    + '\n' + drawings.map(({ x, y, width, height }) => `${x} ${y} ${width} ${height} re S`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R${externalAnnotation ? ' /Annots [6 0 R]' : ''} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...(externalAnnotation ? ['<< /Type /Annot /Subtype /Link /Rect [1 1 10 10] /A << /S /URI /URI (https://invalid.example/private-source.png) >> >>'] : []),
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

test('real uploaded PDF bytes yield only cited drain/fill figures and an actual vector diagram', async () => {
  const { text, steps, media } = await extracted();
  assert.match(text, /Fixture Laundry/); assert.match(text, /Demonstrator/); assert.match(text, /TEST-1/);
  assert.equal(media.length, 5);
  assert.deepEqual(media.map(item => item.descriptor.sourcePage), [3, 4, 4, 5, 5]);
  assert.equal(media.filter(item => /drain hose|drain pump/.test(item.descriptor.stepLabel)).length, 2);
  assert(media.every(item => steps.some(step => step.stepLabel === item.descriptor.stepLabel && step.sourcePages.includes(item.descriptor.sourcePage))));
  assert(!media.some(item => item.descriptor.sourcePage === 1 || item.descriptor.sourcePage === 6), 'cover logo and unillustrated diagnostic page cannot become step images');
  const uniquePages = [...new Map(media.map(item => [item.descriptor.sourcePage, item])).values()];
  const renderedHashes = [];
  for (const item of uniquePages) {
    const png = await renderUploadedGuideMedia(bytes, item);
    assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    const image = await loadImage(Buffer.from(png));
    assert.equal(image.width, item.descriptor.width); assert.equal(image.height, item.descriptor.height);
    assert(image.width <= 1400 && image.height <= 1400 && image.width * image.height <= 2_000_000);
    renderedHashes.push(sha(png));
  }
  assert.equal(new Set(renderedHashes).size, 3, 'drain, fill and vector source drawings must remain distinct');
  assert.equal(sha(bytes), sha256, 'PDF.js transfer must not destroy the original uploaded bytes');
});

test('a step needs its own explicit figure reference, source page and unique matching caption', async () => {
  const result = await inspectUploadedGuideMedia(bytes, { sha256, steps: [
    { stepLabel: 'Inspect the drain hose.', sourcePages: [4] },
    { stepLabel: 'Inspect Figure 2.', sourcePages: [4] },
    { stepLabel: 'Inspect Figure 1.', sourcePages: [1] },
    { stepLabel: 'Inspect Figure 99.', sourcePages: [3, 4, 5] },
    { stepLabel: 'Inspect Figure 1.', sourcePages: [0, -1, 1.5, 9999] },
  ] });
  assert.deepEqual(result, []);
  const requested = (await extracted()).steps.find(step => /drain hose/.test(step.stepLabel));
  const duplicates = await inspectUploadedGuideMedia(bytes, { sha256, steps: [requested, requested] });
  assert.equal(duplicates.length, 1);
});

test('duplicate captions or multiple plausible illustrations fail closed rather than showing a guessed image', async () => {
  for (const input of [
    { captions: [{ text: 'Figure 1: First caption.', x: 50, y: 500 }, { text: 'Figure 1: Duplicate caption.', x: 50, y: 480 }], drawings: [{ x: 50, y: 300, width: 400, height: 130 }] },
    { captions: [{ text: 'Figure 1: Two unrelated drawings below the same caption.', x: 40, y: 500 }], drawings: [{ x: 50, y: 300, width: 150, height: 130 }, { x: 280, y: 300, width: 150, height: 130 }] },
  ]) {
    const pdf = vectorPdf(input);
    assert.deepEqual(await inspectUploadedGuideMedia(pdf, { sha256: sha(pdf), steps: [{ stepLabel: 'Inspect Figure 1.', sourcePages: [1] }] }), []);
  }
});

test('a main figure excluded by size or unsupported geometry cannot leave a nearby logo as its replacement', async () => {
  for (const main of [
    { x: 30, y: 140, width: 550, height: 600 },
    { x: -10, y: 140, width: 590, height: 600 },
    { x: 45, y: 150, width: 18, height: 18 },
  ]) {
    const pdf = vectorPdf({
      captions: [{ text: 'Figure 1: Main panel.', x: 40, y: 50 }],
      drawings: [main, { x: 40, y: 89, width: 60, height: 30 }],
    });
    assert.deepEqual(await inspectUploadedGuideMedia(pdf, { sha256: sha(pdf), steps: [{ stepLabel: 'Inspect the main panel in Figure 1.', sourcePages: [1] }] }), []);
  }
});

test('an oversized raster cannot silently disappear and leave a nearby logo as its replacement', async () => {
  const compressed = deflateSync(Buffer.alloc(5000 * 5000 * 3, 255));
  const stream = 'q 550 0 0 600 30 140 cm /Main Do Q\n40 89 60 30 re S\nBT /F1 12 Tf 40 50 Td (Figure 1: Main panel.) Tj ET';
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Main 6 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 5000 /Height 5000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0];
  let length = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    parts.push(part); length += part.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  const pdf = new Uint8Array(Buffer.concat(parts));
  assert.deepEqual(await inspectUploadedGuideMedia(pdf, { sha256: sha(pdf), steps: [{ stepLabel: 'Inspect the main panel in Figure 1.', sourcePages: [1] }] }), []);
});

test('replaced uploaded bytes invalidate old media IDs and tampered private crop data is rejected', async () => {
  const { steps, media } = await extracted();
  await assert.rejects(inspectUploadedGuideMedia(replacement, { sha256, steps }), /SHA-256/);
  await assert.rejects(renderUploadedGuideMedia(replacement, media[1]), /SHA-256/);
  const updated = await inspectUploadedGuideMedia(replacement, { sha256: sha(replacement), steps });
  assert(updated.length > 0); assert(updated.every(item => !media.some(old => old.descriptor.id === item.descriptor.id)));
  for (const changed of [
    { ...media[1], region: [0, 0, 100, 100] },
    { ...media[1], descriptor: { ...media[1].descriptor, sourcePage: 1 } },
    { ...media[1], descriptor: { ...media[1].descriptor, width: 100000 } },
    { ...media[1], descriptor: { ...media[1].descriptor, id: 'media-' + '0'.repeat(64) } },
  ]) await assert.rejects(renderUploadedGuideMedia(bytes, changed), /selection|dimensions/);
});

test('large vector diagrams are rendered within pixel bounds and PDF URLs are never fetched', async () => {
  const pdf = vectorPdf({ width: 5000, height: 5000,
    captions: [{ text: 'Figure 9: Large actual vector outline.', x: 100, y: 2700 }],
    drawings: [{ x: 100, y: 100, width: 4800, height: 2500 }], externalAnnotation: true });
  const inspected = await inspectUploadedGuideMedia(pdf, { sha256: sha(pdf), steps: [{ stepLabel: 'Inspect the outline in Figure 9.', sourcePages: [1] }] });
  assert.equal(inspected.length, 1);
  assert(inspected[0].descriptor.width <= 1400 && inspected[0].descriptor.height <= 1400);
  const rendered = await loadImage(Buffer.from(await renderUploadedGuideMedia(pdf, inspected[0])));
  assert(rendered.width * rendered.height <= 2_000_000);
  assert.equal(externalRequests, 0);
});


test('full source pages render their diagrams and tables within mobile-safe bounds', async () => {
  const png = await renderUploadedGuidePage(bytes, sha256, 3);
  const image = await loadImage(Buffer.from(png));
  assert.ok(image.width > 0 && image.width <= 1400);
  assert.ok(image.width * image.height <= 3010000);
  await assert.rejects(renderUploadedGuidePage(replacement, sha256, 3), /SHA-256/);
  await assert.rejects(renderUploadedGuidePage(bytes, sha256, 999), /page/);
});

test('a cited diagram retains its entire page, including captions and disconnected labels outside painted bounds', async () => {
  const pdf = vectorPdf({ captions: [{text:'Figure 1: Panel diagram and safety labels.',x:40,y:500}],drawings:[{x:50,y:300,width:400,height:130}] });
  const [selected] = await inspectUploadedGuideMedia(pdf,{sha256:sha(pdf),steps:[{stepLabel:'Inspect Figure 1.',sourcePages:[1]}]});
  assert.deepEqual(selected.region,[0,0,612,792]);
  const image = await loadImage(Buffer.from(await renderUploadedGuideMedia(pdf,selected)));
  assert.ok(Math.abs(image.width/image.height-612/792)<0.002);
});
