// Run after `npm run build`. Optional arguments are existing local PDFs.
// Materialize only traced PDF dependencies outside the checkout to catch
// accidental resolution against the developer's full node_modules directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pdfs = process.argv.slice(2).map(file => path.resolve(file));
for (const route of ['maintenance-reference', 'assets/documentation']) {
  const tracePath = path.resolve(`.next/server/app/api/${route}/route.js.nft.json`);
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const runtimeFiles = trace.files.map(file => path.resolve(path.dirname(tracePath), file))
    .filter(file => /node_modules[\\/](pdfjs-dist|@napi-rs)[\\/]/.test(file));
  assert(runtimeFiles.some(file => /pdf\.mjs$/.test(file)), `${route}: PDF.js missing`);
  assert(runtimeFiles.some(file => /pdf\.worker\.mjs$/.test(file)), `${route}: worker missing`);
  assert(runtimeFiles.some(file => /canvas[\\/]index\.js$/.test(file)), `${route}: canvas loader missing`);
  assert(runtimeFiles.some(file => /\.node$/.test(file)), `${route}: canvas native binary missing`);
  const isolated = await mkdtemp(path.join(tmpdir(), 'cmpri-pdf-runtime-'));
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
    for (const file of process.argv.slice(2)) {
      const task = getDocument({ data: new Uint8Array(await readFile(file)) });
      const pdf = await task.promise;
      let characters = 0;
      for (let page = 1; page <= Math.min(pdf.numPages, 40); page++) {
        characters += (await (await pdf.getPage(page)).getTextContent()).items
          .map(item => 'str' in item ? item.str : '').join(' ').length;
      }
      if (!characters) throw new Error('No PDF text extracted');
      console.log(JSON.stringify({ pages: pdf.numPages, characters }));
    }
  `;
  await writeFile(path.join(isolated, 'probe.mjs'), probe);
  const result = spawnSync(process.execPath, ['probe.mjs', fixturePath, ...pdfs], { cwd: isolated, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  console.log(JSON.stringify({ route, runtimeFiles: runtimeFiles.length, extraction: result.stdout.trim() }));
}
