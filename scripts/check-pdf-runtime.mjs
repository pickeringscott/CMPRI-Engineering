// Run after `npm run build`. Optional arguments are existing local PDFs.
// Materialize only traced PDF dependencies outside the checkout to catch
// accidental resolution against the developer's full node_modules directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pdfs = process.argv.slice(2).map(file => path.resolve(file));
for (const route of ['maintenance-reference', 'work-orders/[id]/troubleshooting', 'assets/documentation', 'assets', 'engineering/po-pdf-review', 'engineering/po-scan-review', 'engineering/po-import-reviewed', 'integrations/drive-po/notify', 'integrations/drive-po/control', 'integrations/drive-po/maintenance']) {
  const tracePath = path.resolve(`.next/server/app/api/${route}/route.js.nft.json`);
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const runtimeFiles = trace.files.map(file => path.resolve(path.dirname(tracePath), file))
    .filter(file => /node_modules[\\/](pdfjs-dist|@napi-rs)[\\/]/.test(file));
  assert(runtimeFiles.some(file => /pdf\.mjs$/.test(file)), `${route}: PDF.js missing`);
  assert(runtimeFiles.some(file => /pdf\.worker\.mjs$/.test(file)), `${route}: worker missing`);
  assert(runtimeFiles.some(file => /canvas[\\/]index\.js$/.test(file)), `${route}: canvas loader missing`);
  assert(runtimeFiles.some(file => /\.node$/.test(file)), `${route}: canvas native binary missing`);
  const guideMedia = ['maintenance-reference','work-orders/[id]/troubleshooting','assets/documentation','assets'].includes(route);
  if (guideMedia) {
    assert(runtimeFiles.some(file => /standard_fonts[\\/].*\.pfb$/.test(file)), `${route}: local PDF fonts missing`);
    assert(runtimeFiles.some(file => /cmaps[\\/].*\.bcmap$/.test(file)), `${route}: local PDF character maps missing`);
    assert(runtimeFiles.some(file => /wasm[\\/].*\.wasm$/.test(file)), `${route}: local PDF image runtime missing`);
  }
  const isolated = await mkdtemp(path.join(tmpdir(), 'cmpri-pdf-runtime-'));
  try {
  const stream = 'BT /F1 12 Tf 20 100 Td (CMPRI PDF runtime verification) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let fixture = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(fixture));
    fixture += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(fixture);
  fixture += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const fixturePath = path.join(isolated, 'runtime.pdf');
  await writeFile(fixturePath, fixture);
  for (const file of runtimeFiles) {
    const relative = path.relative(process.cwd(), file);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative));
    const target = path.join(isolated, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
  }
  const probe = `
    import { readFile } from 'node:fs/promises';
    import { getDocument } from './node_modules/pdfjs-dist/legacy/build/pdf.mjs';
    import { createCanvas } from './node_modules/@napi-rs/canvas/index.js';
    for (const file of process.argv.slice(2)) {
      const task = getDocument({ data: new Uint8Array(await readFile(file)), ...(${JSON.stringify(guideMedia)} ? {
        standardFontDataUrl: new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname,
        cMapUrl: new URL('./node_modules/pdfjs-dist/cmaps/', import.meta.url).pathname,
        cMapPacked: true,
        wasmUrl: new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url).pathname,
        useWorkerFetch: false, useSystemFonts: false,
      } : {}) });
      try {
        const pdf = await task.promise;
        let characters = 0;
        for (let page = 1; page <= Math.min(pdf.numPages, 40); page++) {
          characters += (await (await pdf.getPage(page)).getTextContent()).items
            .map(item => 'str' in item ? item.str : '').join(' ').length;
        }
        if (!characters) throw new Error('No PDF text extracted');
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
        const png = canvas.toBuffer('image/png');
        if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('No PDF illustration PNG rendered');
        console.log(JSON.stringify({ pages: pdf.numPages, characters, renderedPngBytes: png.length }));
      } finally { await task.destroy(); }
    }
  `;
  await writeFile(path.join(isolated, 'probe.mjs'), probe);
  const result = spawnSync(process.execPath, ['probe.mjs', fixturePath, ...pdfs], { cwd: isolated, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  console.log(JSON.stringify({ route, runtimeFiles: runtimeFiles.length, extraction: result.stdout.trim() }));
  } finally { await rm(isolated,{recursive:true,force:true}); }
}
