import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Explicit, versioned same-origin assets. Tesseract defaults to external CDNs
// if paths are omitted; build only the LSTM runtimes used by this application.
// The exact package versions are part of the immutable URL. Bump this path
// whenever a runtime, model, or PDF worker is changed.
const target = 'public/local-ocr/tesseract-7.0.0-core-7.0.0-eng-1.0.0-pdf-6.3.289-app-v1';
for (const [name, expected] of [
  ['tesseract.js', '7.0.0'], ['tesseract.js-core', '7.0.0'],
  ['@tesseract.js-data/eng', '1.0.0'], ['pdfjs-dist', '6.3.289'],
]) {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  if (metadata.version !== expected) throw new Error(`Local OCR asset version mismatch for ${name}; update the versioned path before rebuilding.`);
}
const files = [
  ['scripts/local-ocr-worker.js', 'worker-bootstrap.js'],
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt'],
  ['node_modules/tesseract.js/LICENSE.md', 'licenses/tesseract-js.txt'],
  ['node_modules/tesseract.js-core/LICENSE', 'licenses/tesseract-core.txt'],
  ['node_modules/pdfjs-dist/LICENSE', 'licenses/pdfjs.txt'],
  ['node_modules/@tesseract.js-data/eng/package.json', 'licenses/eng-package.json'],
  ['node_modules/@tesseract.js-data/eng/README.md', 'licenses/eng-readme.md'],
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ...['', '-simd', '-relaxedsimd'].map(variant => [
    `node_modules/tesseract.js-core/tesseract-core${variant}-lstm.wasm.js`,
    `tesseract-core${variant}-lstm.wasm.js`,
  ]),
];

for (const [source, destination] of files) {
  const output = join(target, destination);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(source, output);
}
await writeFile(join(target, 'licenses', 'NOTICE.txt'),
  'CMPRI local OCR bundles tesseract.js and tesseract.js-core (Apache-2.0), PDF.js (Apache-2.0), and @tesseract.js-data/eng (MIT as stated in its package metadata). See the accompanying notices and package metadata.\n');
