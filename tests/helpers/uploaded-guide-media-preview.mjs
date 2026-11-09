// Build browser media fixtures through the real PDF text, action and image code.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadTs } from './load-ts.mjs';
import * as matching from '../../src/lib/manual-document-match.ts';
import { uploadedManualActions } from '../../src/lib/uploaded-manual-actions.ts';
import { manualSourcePassages } from '../../src/lib/manual-source.ts';
import { inspectUploadedGuideMedia, renderUploadedGuideMedia } from '../../src/lib/server/uploaded-guide-media.ts';

const require = createRequire(import.meta.url);
const { extractManualPdfText, manualPdfSha256 } = loadTs('src/lib/manual-pdf-knowledge.ts', {
  'node:crypto': { createHash }, '@/lib/manual-document-match': matching,
  'pdfjs-dist/legacy/build/pdf.mjs': require('pdfjs-dist/legacy/build/pdf.mjs'),
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.argv[2] || '/tmp/cmpri-guide-media-browser');
await mkdir(output, { recursive: true });
const externalAttempts = [];
globalThis.fetch = async (input) => {
  externalAttempts.push(String(input));
  throw new Error('PDF media fixtures must not make network requests.');
};
const variants = [];
for (const [index, file] of ['uploaded-guide-diagrams.pdf', 'uploaded-guide-diagrams-replacement.pdf'].entries()) {
  const bytes = new Uint8Array(await readFile(path.join(root, 'tests/fixtures', file)));
  const sha256 = manualPdfSha256(bytes);
  const text = await extractManualPdfText(bytes);
  const actions = uploadedManualActions(text);
  const steps = [...actions.symptom_rules.flatMap(rule => rule.steps.map(stepLabel => ({ stepLabel, sourcePages: rule.source_pages || [] }))),
    ...actions.error_codes.map(code => ({ stepLabel: code.action, sourcePages: code.source_pages || [] }))];
  const inspected = await inspectUploadedGuideMedia(bytes, { sha256, steps });
  if (!inspected.length) throw new Error('The real PDF did not produce any associated diagrams.');
  const mediaFiles = {};
  for (const image of inspected) {
    if (!/^[a-z0-9_-]+$/i.test(image.descriptor.id)) throw new Error('Unsafe diagram fixture id.');
    const png = await renderUploadedGuideMedia(bytes, image);
    const filename = path.join(output, image.descriptor.id + '.png');
    await writeFile(filename, png);
    mediaFiles[image.descriptor.id] = filename;
  }
  variants.push({
    knowledge: {
      manufacturer: 'Fixture Laundry', model_family: 'Demonstrator', model_number: 'TEST-1',
      source: {
        verified: true, type: 'Verbatim uploaded PDF excerpts', title: 'Washer service manual.pdf',
        source_file_name: 'Washer service manual.pdf', source_kind: 'asset-upload',
        file_url: 'http://127.0.0.1:3116/guides/guest-room.pdf',
        storage_path: '00000000-0000-4000-8000-000000000002/asset-files/Washer service manual.pdf',
        sha256, registered_file_id: '00000000-0000-4000-8000-000000000011',
        registered_updated_at: index ? '2026-11-09T06:00:00Z' : '2026-11-08T12:00:00Z',
      },
      symptom_rules: actions.symptom_rules, error_codes: actions.error_codes,
      source_passages: manualSourcePassages(text), step_media: inspected.map(image => image.descriptor),
      general_checks: [], manual_tests: [],
    },
    mediaFiles,
  });
}
if (externalAttempts.length) throw new Error('Unexpected external requests: ' + externalAttempts.join(', '));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ variants, externalAttempts }, null, 2));
console.log(path.join(output, 'manifest.json'));
