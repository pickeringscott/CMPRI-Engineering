import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { prepareManuals } from '../scripts/ingest-all-manuals.mjs';

test('manual preparation preserves source and page-independent text without AI or database credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cmpri-manual-test-'));
  try {
    const source = path.join(root, 'manual.txt');
    await fs.writeFile(source, 'Manufacturer instructions\nCode 3: inspect the filter.');
    const result = await prepareManuals(source);
    assert.equal(result.ai_used, false); assert.equal(result.database_modified, false);
    assert.equal(result.documents[0].verified, false);
    assert.equal(result.documents[0].text, await fs.readFile(source, 'utf8'));
    assert.match(result.documents[0].sha256, /^[a-f0-9]{64}$/);
    const output = path.join(root, 'review.json');
    execFileSync(process.execPath, ['scripts/ingest-all-manuals.mjs', source, `--output=${output}`], { env: { PATH: process.env.PATH } });
    assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).documents.length, 1);
    assert.throws(() => execFileSync(process.execPath, ['scripts/ingest-all-manuals.mjs', source, `--output=${source}`], { stdio: 'pipe' }));
    assert.equal(await fs.readFile(source, 'utf8'), result.documents[0].text);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('nested ZIPs are processed in memory; empty text remains unverified', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cmpri-zip-test-'));
  try {
    const inner = new AdmZip(); inner.addFile('manual.md', Buffer.from(''));
    const outer = new AdmZip(); outer.addFile('inner.zip', inner.toBuffer()); outer.addFile('ignored.exe', Buffer.from('ignored'));
    const file = path.join(root, 'manuals.zip'); await fs.writeFile(file, outer.toBuffer());
    const result = await prepareManuals(file);
    assert.equal(result.documents.length, 1); assert.equal(result.documents[0].status, 'no_readable_text');
    assert.deepEqual(await fs.readdir(root), ['manuals.zip']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
