import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

// Use real browser IndexedDB/structured cloning, including closing the complete
// browser process. All navigation is fulfilled locally; no app or server runs.
const { chromium } = createRequire(import.meta.url)('playwright');
const source = await readFile(new URL('../src/lib/work-orders/attachment-draft.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const scope = { hotelId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', editorId: 'create' };
const uploadId = '00000000-0000-4000-8000-000000000003';
const ticketId = '00000000-0000-4000-8000-000000000004';
let profile, context, page;

async function start() {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Attachment fixture</title>' }));
  page = context.pages()[0] || await context.newPage();
  await page.goto('http://attachment-draft.invalid/');
  await page.addScriptTag({ content: `(() => { const exports = {}; ${code}\nwindow.attachmentDraft = exports; })();` });
}
before(async () => { profile = await mkdtemp(join(tmpdir(), 'cmpri-attachment-draft-')); await start(); });
after(async () => { await context?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });

test('actual File bytes, names, dates and upload retry identities survive a complete browser restart in the exact account/property/editor', async () => {
  await page.evaluate(async ({ scope, uploadId, ticketId }) => {
    await window.attachmentDraft.saveAttachmentDraft(scope, {
      draftIdentity: `draft:${ticketId}:7`,
      files: [{ file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 255])], 'inspection.png', { type: 'image/png', lastModified: 1234567 }), uploadId, previewUrl: 'blob:never-retain' }],
      uploads: [{ workOrderId: ticketId, displayId: 'workorder_261120001', uploadId, signedUrl: 'https://never-retain.invalid/?token=secret' }],
      access_token: 'never-retain',
    });
  }, { scope, uploadId, ticketId });
  await context.close();
  await start();
  const restored = await page.evaluate(async ({ scope, ticketId }) => {
    const row = await window.attachmentDraft.readAttachmentDraft(scope);
    const file = row.files[0].file;
    const other = '00000000-0000-4000-8000-000000000099';
    return {
      isFile: file instanceof File, name: file.name, type: file.type, lastModified: file.lastModified,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())), uploadId: row.files[0].uploadId,
      draftIdentity: row.draftIdentity, uploads: row.uploads, keys: Object.keys(row), fileKeys: Object.keys(row.files[0]),
      foreign: await Promise.all([{ ...scope, hotelId: other }, { ...scope, userId: other }, { ...scope, editorId: ticketId }].map(next => window.attachmentDraft.readAttachmentDraft(next))),
    };
  }, { scope, ticketId });
  assert.deepEqual(restored, {
    isFile: true, name: 'inspection.png', type: 'image/png', lastModified: 1234567,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0, 1, 255], uploadId, draftIdentity: `draft:${ticketId}:7`,
    uploads: [{ workOrderId: ticketId, displayId: 'workorder_261120001', uploadId }],
    keys: ['draftIdentity', 'files', 'uploads'], fileKeys: ['file', 'uploadId'], foreign: [null, null, null],
  });
});

test('queued snapshots commit in order, empty selections stay explicit, and confirmed clearing touches only its editor', async () => {
  const result = await page.evaluate(async ({ scope, ticketId, uploadId }) => {
    const lib = window.attachmentDraft;
    const detail = { ...scope, editorId: ticketId };
    const record = name => ({ draftIdentity: '', files: [{ file: new File([name], `${name}.jpg`, { type: 'image/jpeg', lastModified: 5 }), uploadId }] });
    await lib.saveAttachmentDraft(detail, { ...record('detail'), draftIdentity: `ticket:${ticketId}:9` });
    const one = lib.saveAttachmentDraft(scope, record('one'));
    const two = lib.saveAttachmentDraft(scope, record('two'));
    const three = lib.readAttachmentDraft(scope);
    await Promise.all([one, two]);
    const latest = await three;
    await lib.clearAttachmentDraft(scope);
    const cleared = await lib.readAttachmentDraft(scope);
    const preserved = await lib.readAttachmentDraft(detail);
    await lib.saveAttachmentDraft(scope, { draftIdentity: '', files: [] });
    return { latest: await latest.files[0].file.text(), cleared, preserved: await preserved.files[0].file.text(), empty: await lib.readAttachmentDraft(scope) };
  }, { scope, ticketId, uploadId });
  assert.deepEqual(result, { latest: 'two', cleared: null, preserved: 'detail', empty: { draftIdentity: '', files: [] } });
});

test('invalid identities, unsafe metadata, unsupported files and limits reject without replacing retained bytes', async () => {
  const result = await page.evaluate(async ({ scope, ticketId, uploadId }) => {
    const lib = window.attachmentDraft;
    const base = { draftIdentity: '', files: [{ file: new File(['original'], 'original.png', { type: 'image/png', lastModified: 10 }), uploadId }] };
    await lib.saveAttachmentDraft(scope, base);
    const oversize = new File(['small'], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversize, 'size', { value: lib.ATTACHMENT_DRAFT_LIMITS.fileBytes + 1 });
    const bad = [
      [{ ...scope, userId: '' }, base], [{ ...scope, editorId: 'different-editor' }, base],
      [scope, { ...base, draftIdentity: 'https://signed.invalid/?token=secret' }],
      [{ ...scope, editorId: ticketId }, { ...base, draftIdentity: 'ticket:00000000-0000-4000-8000-000000000099:1' }],
      [scope, { ...base, files: [{ ...base.files[0], file: new File(['html'], 'unsafe.html', { type: 'text/html' }) }] }],
      [scope, { ...base, files: [{ ...base.files[0], file: new File(['svg'], 'unsafe.svg', { type: 'image/svg+xml' }) }] }],
      [scope, { ...base, files: [{ ...base.files[0], file: new File(['x'], '../unsafe.png', { type: 'image/png' }) }] }],
      [scope, { ...base, files: [{ ...base.files[0], file: oversize }] }],
      [scope, { ...base, files: [base.files[0], base.files[0]] }],
      [scope, { ...base, files: Array.from({ length: 26 }, (_, index) => ({ ...base.files[0], uploadId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}` })) }],
      [scope, { ...base, uploads: [{ workOrderId: ticketId, displayId: 'workorder_1', uploadId: ticketId }] }],
    ];
    const failures = [];
    for (const [identity, record] of bad) {
      try { await lib.saveAttachmentDraft(identity, record); failures.push(false); }
      catch (error) { failures.push(error.message.includes('Keep this window open') || error.message.includes('keep this window open')); }
    }
    return { failures, bytes: await (await lib.readAttachmentDraft(scope)).files[0].file.text() };
  }, { scope, ticketId, uploadId });
  assert.deepEqual(result.failures, Array(11).fill(true));
  assert.equal(result.bytes, 'original');
});

test('transaction abort, quota and disabled IndexedDB fail visibly and preserve the prior committed selection', async () => {
  const result = await page.evaluate(async ({ scope, uploadId }) => {
    const lib = window.attachmentDraft;
    const record = text => ({ draftIdentity: '', files: [{ file: new File([text], 'inspection.jpg', { type: 'image/jpeg' }), uploadId }] });
    await lib.saveAttachmentDraft(scope, record('before'));
    const put = IDBObjectStore.prototype.put;
    let aborted = false;
    IDBObjectStore.prototype.put = function (...args) {
      const result = put.apply(this, args);
      if (this.name === 'drafts') queueMicrotask(() => this.transaction.abort());
      return result;
    };
    try { await lib.saveAttachmentDraft(scope, record('after')); }
    catch (error) { aborted = error.message.includes('Keep this window open'); }
    finally { IDBObjectStore.prototype.put = put; }
    const failures = [];
    for (const name of ['QuotaExceededError', 'SecurityError']) {
      try { await lib.saveAttachmentDraft(scope, record('never'), { open() { throw new DOMException('synthetic', name); } }); }
      catch (error) { failures.push(error.message); }
    }
    const preserved = await lib.readAttachmentDraft(scope);
    return { aborted, failures, text: await preserved.files[0].file.text() };
  }, { scope, uploadId });
  assert.equal(result.aborted, true);
  assert.match(result.failures[0], /insufficient storage.*Keep this window open/);
  assert.match(result.failures[1], /enable browser storage.*retry before closing/);
  assert.equal(result.text, 'before');
});

test('device budget never evicts other pending work and malformed stored bytes are reported without deletion', async () => {
  const result = await page.evaluate(async ({ scope, uploadId }) => {
    const lib = window.attachmentDraft;
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('cmpri-work-order-attachments-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    async function mutate(callback) {
      await new Promise((resolve, reject) => { const tx = db.transaction(['drafts', 'metadata'], 'readwrite'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); callback(tx); });
    }
    await mutate(tx => tx.objectStore('metadata').put({ count: lib.ATTACHMENT_DRAFT_LIMITS.editors, bytes: lib.ATTACHMENT_DRAFT_LIMITS.deviceBytes }, 'usage'));
    let quota = '';
    try {
      await lib.saveAttachmentDraft({ ...scope, editorId: '00000000-0000-4000-8000-000000000088' }, { draftIdentity: '', files: [{ file: new File(['new'], 'new.png', { type: 'image/png' }), uploadId }] });
    } catch (error) { quota = error.message; }
    const preserved = await lib.readAttachmentDraft(scope);
    const key = JSON.stringify([scope.hotelId, scope.userId, scope.editorId]);
    await mutate(tx => tx.objectStore('drafts').put({ version: 1, ...scope, key, bytes: 1, draftIdentity: '', files: [{ blob: 'missing bytes', name: 'photo.png', type: 'image/png', lastModified: 1, uploadId }] }));
    let corrupt = '';
    try { await lib.readAttachmentDraft(scope); } catch (error) { corrupt = error.message; }
    const remains = await new Promise(resolve => { const request = db.transaction('drafts').objectStore('drafts').get(key); request.onsuccess = () => resolve(Boolean(request.result)); });
    db.close();
    return { quota, before: await preserved.files[0].file.text(), corrupt, remains };
  }, { scope, uploadId });
  assert.match(result.quota, /insufficient storage/);
  assert.equal(result.before, 'before');
  assert.match(result.corrupt, /could not be restored.*reselect/);
  assert.equal(result.remains, true);
});
