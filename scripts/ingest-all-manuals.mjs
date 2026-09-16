#!/usr/bin/env node
// Local preparation only. No provider calls, database writes, or verification claims.
// Usage: node scripts/ingest-all-manuals.mjs SOURCE --output=review.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const supported = new Set(['.pdf', '.docx', '.txt', '.md', '.zip']);
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export async function prepareManuals(source) {
  const documents = [];
  const state = { count: 0, bytes: 0 };
  async function document(name, bytes, depth = 0) {
    const extension = path.extname(name).toLowerCase();
    if (!supported.has(extension)) return;
    if (++state.count > MAX_FILES || bytes.length > MAX_BYTES || (state.bytes += bytes.length) > MAX_TOTAL_BYTES) throw new Error('Manual collection exceeds the supported size. Split it into smaller batches.');
    if (extension === '.zip') {
      if (depth >= 4) throw new Error('ZIP nesting exceeds four levels.');
      const { default: AdmZip } = await import('adm-zip');
      for (const entry of new AdmZip(bytes).getEntries()) {
        if (entry.isDirectory || !supported.has(path.extname(entry.entryName).toLowerCase())) continue;
        // Check declared expansion before allocating decompressed bytes; never extract paths.
        if (entry.header.size > MAX_BYTES || state.bytes + entry.header.size > MAX_TOTAL_BYTES) throw new Error('Expanded manual exceeds the supported size.');
        await document(`${name}/${entry.entryName}`, entry.getData(), depth + 1);
      }
      return;
    }
    let text = '';
    const pages = [];
    if (extension === '.pdf') {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
      try {
        for (let number = 1; number <= pdf.numPages; number++) {
          const content = await (await pdf.getPage(number)).getTextContent();
          pages.push({ page: number, text: content.items.map(item => 'str' in item ? item.str : '').join(' ').trim() });
        }
      } finally { await pdf.destroy(); }
      text = pages.map(page => `[PAGE ${page.page}]\n${page.text}`).join('\n\n');
    } else if (extension === '.docx') {
      const { default: mammoth } = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else text = bytes.toString('utf8');
    documents.push({ source_file: name, sha256: createHash('sha256').update(bytes).digest('hex'),
      extraction_method: 'local_text', verified: false, requires_review: true,
      status: text.trim() ? 'text_extracted' : 'no_readable_text', text, pages });
  }
  async function visit(file, relative) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
    } else if (stat.isFile() && supported.has(path.extname(file).toLowerCase())) {
      if (stat.size > MAX_BYTES) throw new Error('Manual exceeds 50 MiB.');
      await document(relative, await fs.readFile(file));
    }
  }
  await visit(path.resolve(source), path.basename(source));
  if (!documents.length) throw new Error('No supported manuals found.');
  return { format_version: 1, prepared_at: new Date().toISOString(), ai_used: false,
    database_modified: false, documents };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const source = args.find(arg => !arg.startsWith('--'));
    const output = args.find(arg => arg.startsWith('--output='))?.slice(9);
    if (!source || !output || args.some(arg => arg.startsWith('--') && !arg.startsWith('--output='))) throw new Error('Usage: node scripts/ingest-all-manuals.mjs SOURCE --output=review.json');
    const result = await prepareManuals(source);
    // Exclusive creation protects both source files and earlier review artifacts.
    await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(`Prepared ${result.documents.length} manuals for review. No AI calls or database changes.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
