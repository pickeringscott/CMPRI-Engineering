import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { createCanvas } from '@napi-rs/canvas';
import { loadTs } from './helpers/load-ts.mjs';
import * as applicability from '../src/lib/manual-applicability.ts';
import * as matching from '../src/lib/manual-document-match.ts';
import * as source from '../src/lib/manual-source.ts';
import * as manualHtml from '../src/lib/manual-document-html.ts';
import * as actions from '../src/lib/uploaded-manual-actions.ts';
import * as ocrActions from '../src/lib/server/manual-ocr-actions.ts';
import * as roles from '../src/lib/server/roles.ts';
import * as access from '../src/lib/server/access.ts';
import { isUuid } from '../src/lib/uuid.ts';
import { normalizeManualKnowledge } from '../src/lib/manual-knowledge.ts';
import { deriveTroubleshootingChecklistContext } from '../src/lib/work-orders/troubleshooting-checklist.ts';
import * as guideMedia from '../src/lib/server/uploaded-guide-media.ts';
import * as procedureReferences from '../src/lib/manual-procedure-references.ts';

const require = createRequire(import.meta.url);
const originalGlobalFetch = globalThis.fetch;
let outboundFetches = 0;
// The real PDF runtime and the strict reader both run with external/provider
// networking disabled. Only the supplied private-storage mock serves source bytes.
globalThis.fetch = async () => { outboundFetches++; throw new Error('External or AI/provider requests are forbidden for troubleshooting guides.'); };
after(() => { globalThis.fetch = originalGlobalFetch; assert.equal(outboundFetches, 0); });
const hotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6', assetId = '00000000-0000-4000-8000-000000000011';
const path = `${hotel}/${assetId}/washer.pdf`;
const actorId = '00000000-0000-4000-8000-000000000012';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// A real, tiny PDF with positioned text; pdf.js performs the extraction in tests.
function pdf(lines, additionalPage) {
  const escape = text => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = 'BT /F1 12 Tf 14 TL 72 740 Td\n' + lines.map(line => `(${escape(line)}) Tj T*`).join('\n') + '\nET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  if (additionalPage) {
    let secondStream = 'BT /F1 12 Tf 14 TL 72 740 Td\n' + (additionalPage === 'scan' ? [] : additionalPage).map(line => `(${escape(line)}) Tj T*`).join('\n') + '\nET';
    let scanImage = '';
    if (additionalPage === 'scan') {
      const canvas = createCanvas(600, 160), context = canvas.getContext('2d');
      context.fillStyle = '#fff';context.fillRect(0, 0, 600, 160);context.fillStyle = '#000';context.font = '24px sans-serif';
      ['Door lock stuck', '1. Inspect the latch.', '2. Check the wiring.'].forEach((text, index) => context.fillText(text, 20, 40 + 45 * index));
      const pixels = context.getImageData(0, 0, 600, 160).data;
      const rgb = Buffer.alloc(600 * 160 * 3);
      for (let source = 0, target = 0; source < pixels.length; source += 4) { rgb[target++] = pixels[source];rgb[target++] = pixels[source + 1];rgb[target++] = pixels[source + 2]; }
      const hex = rgb.toString('hex') + '>';
      scanImage = `<< /Type /XObject /Subtype /Image /Width 600 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`;
      secondStream = 'q 540 0 0 144 36 600 cm /Scan Do Q';
    }
    objects[1] = '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${scanImage ? '/XObject << /Scan 8 0 R >>' : ''} >> /Contents 7 0 R >>`, `<< /Length ${Buffer.byteLength(secondStream)} >>\nstream\n${secondStream}\nendstream`);
    if (scanImage) objects.push(scanImage);
  }
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(result));
}
const realPdf = loadTs('src/lib/manual-pdf-knowledge.ts', { 'node:crypto': { createHash }, '@/lib/manual-document-match': matching, 'pdfjs-dist/legacy/build/pdf.mjs': require('pdfjs-dist/legacy/build/pdf.mjs') });
const original = pdf(['ACME W1 Laundry service manual', 'Troubleshooting', 'Symptom: Washer not draining', '1. Clean the drain filter.', '2. Check the drain hose.']);
const asset = { id: assetId, hotel_id: hotel, active: true, manufacturer: 'ACME', model_family: 'Laundry', model_number: 'W1', documentation_key: 'attached-washer', documentation_revision_id: null, documentation_verified_at: '2026-11-08T12:00:00Z', pdf_import_links: [] };
const file = { id: '00000000-0000-4000-8000-000000000021', name: 'Washer service manual.pdf', storage_path: path, preferred: false, created_at: '2026-11-07T12:00:00Z', updated_at: '2026-11-07T12:00:00Z' };

function chosen(file, bytes = original, identity = asset) {
  return { object_id: file.id, storage_path: file.storage_path, sha256: hash(bytes), applicability: 'confirmed_model',
    applicability_review: { ...applicability.manualAssetIdentity(identity), confirmed: true } };
}
function fixture(overrides = {}) {
  const state = { asset: structuredClone(asset), files: [structuredClone(file)], bytes: new Map([[path, original]]), registryReads: 0, downloads: [], queries: [], network: 0, extractions: 0, inspections: 0, renders: 0, failDownload: false, authenticated: true, ocrStatus: 'unavailable', ocrPages: [], ocrEnqueues: 0, reviewedPages: [], role: 'Maintenance Technician', secondary: [], mutateRegistry: null, ...overrides };
  if (!overrides.asset) state.asset.pdf_import_links = state.files.map(file => chosen(file, state.bytes.get(file.storage_path) || original, state.asset));
  const client = {
    from(table) {
      if (table === 'troubleshooting_cache' && state.useReviewedStore) {
        const filters = []; state.reviewedRows ||= new Map();
        const query = { select() { return query; }, eq(k, v) { filters.push(row => row[k] === v); return query; }, like(k, v) { filters.push(row => row[k].startsWith(v.slice(0, -1))); return query; },
          async limit() { return { data: [...state.reviewedRows.values()].filter(row => filters.every(filter => filter(row))), error: null }; },
          async upsert(rows) { for (const row of rows) state.reviewedRows.set(row.cache_key, structuredClone(row)); return { error: null }; },
        }; return query;
      }
      state.queries.push(table); assert.equal(table, 'assets', 'strict reads must never query catalog or troubleshooting caches');
      const filters = [];
      const query = { select() { return query; }, eq(key, value) { filters.push(row => row[key] === value); return query; }, async maybeSingle() { return { data: filters.every(filter => filter(state.asset)) ? state.asset : null, error: null }; } };
      return query;
    },
    storage: { from(bucket) { assert.equal(bucket, 'asset-documentation'); return {
      async download(storagePath) { state.downloads.push(storagePath); const bytes = state.bytes.get(storagePath); return { data: !state.failDownload && bytes ? new Blob([bytes]) : null, error: state.failDownload ? new Error('Unavailable') : null }; },
      async createSignedUrl(storagePath) { return { data: { signedUrl: `https://private.example/${encodeURIComponent(storagePath)}?token=local` }, error: null }; },
    }; } },
  };
  const principal = { identity: { id: actorId }, profile: { id: actorId, role: state.role, secondary_roles: state.secondary, full_name: 'Synthetic Technician', active: true }, hotelId: hotel, membership: { user_id: actorId, hotel_id: hotel, role: 'admin', active: true }, permissions: [] };
  const reviewedStore = state.useReviewedStore ? loadTs('src/lib/server/reviewed-manual-text.ts', {
    'node:crypto': { createHash }, '@/lib/constants': { HOTEL_ID: hotel }, '@/lib/uuid': { isUuid },
    '@/lib/server/asset-file-register': { listRegisteredAssetFiles: async () => ({ data: structuredClone(state.files), error: null }) },
    '@/lib/server/manual-ocr': { manualOcrPageCount: async bytes => { const task = require('pdfjs-dist/legacy/build/pdf.mjs').getDocument({ data: bytes.slice() }); try { return (await task.promise).numPages; } finally { await task.destroy(); } } },
  }, { Uint8Array }) : null;
  const reviewedRoute = reviewedStore ? loadTs('src/app/api/assets/documentation/reviewed-text/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } }, '@/lib/constants': { HOTEL_ID: hotel },
    '@/lib/server/auth': { requireUser: async () => state.authenticated ? { admin: client, principal } : null },
    '@/lib/server/access': access, '@/lib/server/roles': roles, '@/lib/server/reviewed-manual-text': reviewedStore,
  }, { TextDecoder, Uint8Array }) : null;
  const reader = loadTs('src/lib/server/uploaded-asset-guide.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/manual-applicability': applicability,
    '@/lib/server/stored-pdf-status': { withStoredPdfStatus: async (_admin, files) => { if (state.statusFailure) throw Error('Quarantine status unavailable'); return files.map(file => ({ ...file, catalog_status: state.quarantined?.includes(file.id) ? 'content_mismatch' : 'complete' })); } },
    '@/lib/constants': { HOTEL_ID: hotel }, '@/lib/uuid': { isUuid }, '@/lib/server/roles': roles, '@/lib/server/access': access,
    '@/lib/server/auth': { requireUser: async () => state.authenticated ? { admin: client, principal } : null },
    '@/lib/server/asset-file-register': { listRegisteredAssetFiles: async () => { state.registryReads++; if (state.mutateRegistry && state.registryReads === 2) state.mutateRegistry(state); return { data: structuredClone(state.files), error: null }; } },
    '@/lib/server/reviewed-manual-text': reviewedStore || { readReviewedManualPages: async () => { if (state.failReviewedRead) throw Error('Unavailable'); return state.reviewedPages; } },
    '@/lib/server/manual-ocr-queue': { enqueueManualOcr: async () => { state.ocrEnqueues++; if (state.ocrStatus === 'unavailable') throw Error('unavailable'); state.ocrStatus = 'pending'; }, readManualOcr: async () => ({ status: state.ocrStatus, pages: state.ocrPages }) }, '@/lib/server/manual-ocr-actions': ocrActions,
    './manual-preview': { manualPreviewReadOnly: () => false },
    './manual-derivative-cache': { inspectCachedManualPdf: async (_admin, bytes) => { state.extractions++; if (state.failExtraction) throw Error('Text extraction unavailable'); return realPdf.inspectManualPdf(bytes, {includeEmptyPages:true}); } },
    '@/lib/manual-procedure-references': procedureReferences,
    '@/lib/manual-pdf-knowledge': realPdf, '@/lib/manual-document-match': matching, '@/lib/manual-source': source, '@/lib/manual-document-html': manualHtml, '@/lib/uploaded-manual-actions': actions, '@/lib/server/pdf-troubleshooting-tables': { extractPdfManualStructure: async () => ({symptom_rules:[], error_codes:[], warnings:[]}) },
    '@/lib/server/uploaded-guide-media': { ...guideMedia, inspectUploadedGuideMedia: async (...args) => { state.inspections++; if (state.mutateReviewedDuringInspection) state.mutateReviewedDuringInspection(state); if (state.failInspection) throw Error('Figure inspection unavailable'); const result = await guideMedia.inspectUploadedGuideMedia(...args); if (state.circularMedia && result[0]) result[0].cycle = result[0]; return result; }, renderUploadedGuideMedia: async (...args) => { state.renders++; return guideMedia.renderUploadedGuideMedia(...args); }, renderUploadedGuidePage: async (...args) => { state.renders++; return guideMedia.renderUploadedGuidePage(...args); } },
  }, { Response, Uint8Array, TextEncoder, Error, fetch: () => { state.network++; throw Error('No external recognition or provider requests are permitted.'); } });
  return { state, principal, saveReviewed: async input => { const response = await reviewedRoute.POST(new Request('https://cmpri.example/api/assets/documentation/reviewed-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })); return { status: response.status, body: await response.json() }; }, load: async () => structuredClone(await reader.loadUploadedAssetGuide(client, state.asset)), request: async (id = assetId, image = {}) => {
    const query = new URLSearchParams({ source: 'asset-upload', assetId: id, ...image });
    const response = await reader.readUploadedAssetMaintenanceReference({ nextUrl: new URL(`https://cmpri.example/api/maintenance-reference?${query}`) });
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.startsWith('image/png') ? new Uint8Array(await response.arrayBuffer()) : await response.json() };
  } };
}

test('concurrent and repeat reads reuse byte-derived work but reauthorize and recheck current source', async () => {
  const h = fixture();
  const [first, second] = await Promise.all([h.request(), h.request()]);
  assert.equal(first.body.documentation_status, 'verified'); assert.equal(second.body.documentation_status, 'verified');
  assert.equal(h.state.extractions, 1); assert.equal(h.state.inspections, 1);
  assert.equal(h.state.downloads.length, 2); assert.equal(h.state.registryReads, 4);
  await h.request();
  assert.equal(h.state.extractions, 1); assert.equal(h.state.inspections, 1);
  assert.equal(h.state.downloads.length, 3); assert.equal(h.state.registryReads, 6);
  h.state.bytes.set(path, new Uint8Array(Buffer.concat([Buffer.from(original), Buffer.from('% replacement\n')])));
  await h.request();
  assert.equal(h.state.extractions, 1); assert.equal(h.state.inspections, 1);
  h.state.authenticated = false;
  assert.equal((await h.request()).status, 401); assert.equal(h.state.downloads.length, 4);
  h.state.authenticated = true; h.state.files = [];
  assert.equal((await h.request()).body.documentation_status, 'no_uploaded_document');
  assert.equal(h.state.downloads.length, 4, 'cached derivatives do not authorize an unlinked source');
});

test('failed extraction is retried instead of caching a failure', async () => {
  const h = fixture({ bytes: new Map([[path, new Uint8Array(Buffer.from('%PDF-invalid'))]]) });
  assert.equal((await h.load()).documentation_status, 'unreadable_uploaded_document');
  assert.equal((await h.load()).documentation_status, 'unreadable_uploaded_document');
  assert.equal(h.state.extractions, 2);
});

test('attached PDF bytes produce verbatim page-linked actions and immutable source provenance without catalog access', async () => {
  const h = fixture(); const result = await h.request();
  assert.equal(result.status, 200); assert.equal(result.body.documentation_status, 'verified');
  const guide = result.body.manualKnowledge;
  assert.equal(guide.source.source_kind, 'asset-upload'); assert.equal(guide.source.storage_path, path);
  assert.equal(guide.source.sha256, hash(original)); assert.equal(guide.source.registered_file_id, file.id);
  assert.equal(guide.source.source_file_name, file.name);
  assert.deepEqual(guide.symptom_rules[0].steps, ['Clean the drain filter.', 'Check the drain hose.']);
  assert.deepEqual(guide.symptom_rules[0].source_pages, [1]); assert.match(guide.source_passages[0].text, /Washer not draining/);
  assert.match(guide.source_passages[0].html, /data-source-page="1"/); assert.match(guide.source_passages[0].html, /<ol>/); assert.equal(guide.source_passages[0].source_file_name, file.name);
  const normalized = normalizeManualKnowledge(guide);
  assert.equal(normalized.source.sha256, hash(original)); assert.equal(normalized.source.storage_path, path);
  assert.equal(deriveTroubleshootingChecklistContext({ issue: 'Washer not draining', asset }, normalized).steps.length, 2);
  assert.deepEqual(h.state.queries, ['assets', 'assets']); assert.equal(h.state.registryReads, 2); assert.equal(h.state.network, 0);
});

test('missing, unreadable and unapproved uploaded documents do not substitute any catalog or cached guide', async () => {
  for (const [overrides, expected] of [[{ files: [] }, 'no_uploaded_document'], [{ failDownload: true }, 'unreadable_uploaded_document']]) {
    const h = fixture(overrides); const result = await h.load();
    assert.equal(result.documentation_status, expected); assert.equal(result.manualKnowledge, null);
    assert.equal(h.state.queries.length, 0); assert.equal(h.state.network, 0);
    if (expected === 'documentation_unverified') assert.equal(h.state.downloads.length, 0);
  }
});

test('explicit user choice is required and changed original bytes cannot reuse the choice', async () => {
  const h = fixture({ asset: { ...asset, pdf_import_links: [chosen(file)] } });
  assert.equal((await h.load()).documentation_status, 'verified');
  h.state.asset.pdf_import_links[0].sha256 = 'b'.repeat(64);
  assert.equal((await h.load()).documentation_status, 'uploaded_document_changed');
});

test('all chosen manuals retain separate same-page and identical-step provenance even with duplicate bytes', async () => {
  const secondPath = `${hotel}/${assetId}/second.pdf`;
  const second = { ...file, id: '00000000-0000-4000-8000-000000000022', name: 'Second manual.pdf', storage_path: secondPath, preferred: true };
  const h = fixture({ files: [file, second], bytes: new Map([[path, original], [secondPath, original]]) });
  const result = await h.load();
  assert.equal(result.documentation_status, 'verified');
  const knowledge = normalizeManualKnowledge(result.manualKnowledge);
  assert.equal(knowledge.sources.length, 2);
  assert.deepEqual(new Set(knowledge.source_passages.filter(p => p.page === 1).map(p => p.source_document_id)), new Set([file.id, second.id]));
  const context = deriveTroubleshootingChecklistContext({ issue: 'Washer not draining', asset: h.state.asset }, knowledge);
  const identical = context.steps.filter(step => step.label === 'Clean the drain filter.');
  assert.equal(identical.length, 2);
  assert.deepEqual(new Set(identical.map(step => step.source_document_id)), new Set([file.id, second.id]));
  assert.ok(identical.every(step => step.source_sha256 === hash(original)));
  assert.equal(JSON.parse(context.contextIdentity).sources.length, 2);
  const image = await h.request(assetId, { pageImage: '1', sha256: hash(original), fileId: second.id });
  assert.equal(image.status, 200);
  assert.equal(h.state.downloads.at(-1), secondPath);
  h.state.bytes.set(secondPath, pdf(['Changed PDF']));
  const changed = await h.load();
  assert.equal(changed.manualKnowledge.sources.length, 1);
  assert.equal(changed.manualKnowledge.source.search_incomplete, true);
  assert.match(changed.documentation_warnings.join(' '), /Second manual.*bytes changed/);
});

test('unselected references and unacknowledged quarantine are excluded; explicit acknowledgment preserves user choice', async () => {
  const h = fixture({ asset: { ...asset, pdf_import_links: [{ ...chosen(file), applicability: 'general_reference' }] } });
  assert.equal((await h.load()).documentation_status, 'manual_applicability_unresolved');
  assert.equal(h.state.downloads.length, 0);
  h.state.asset.pdf_import_links = [chosen(file)]; h.state.quarantined = [file.id];
  assert.equal((await h.load()).documentation_status, 'manual_applicability_unresolved');
  assert.equal(h.state.downloads.length, 0);
  h.state.asset.pdf_import_links[0].quarantine_acknowledged = true;
  const acknowledged = await h.load();
  assert.equal(acknowledged.documentation_status, 'verified');
  assert.match(acknowledged.documentation_warnings.join(' '), /deliberately selected/);
  h.state.quarantined = []; h.state.statusFailure = true;
  await assert.rejects(h.load, /Quarantine status unavailable/);
});

test('image-only scans and invalid PDF signatures yield explicit source errors without invented steps', async () => {
  const h = fixture({ bytes: new Map([[path, pdf([], 'scan')]]) });
  const scan = await h.load(); assert.equal(scan.documentation_status, 'uploaded_document_needs_ocr'); assert.ok(scan.manualKnowledge.source.file_url); assert.deepEqual(scan.manualKnowledge.symptom_rules, []); assert.match(scan.documentation_reason, /no readable text/);
  h.state.bytes.set(path, new Uint8Array(Buffer.from('<html>not a PDF</html>')));
  const invalid = await h.load(); assert.equal(invalid.documentation_status, 'unreadable_uploaded_document'); assert.equal(invalid.manualKnowledge, null);
});

test('source byte changes invalidate checklist context even when extracted actions stay identical', async () => {
  const h = fixture(); const first = await h.load();
  const a = deriveTroubleshootingChecklistContext({ issue: 'Washer not draining', asset }, normalizeManualKnowledge(first.manualKnowledge));
  h.state.bytes.set(path, new Uint8Array(Buffer.concat([Buffer.from(original), Buffer.from('% revised source bytes\n')])));
  assert.equal((await h.load()).documentation_status, 'uploaded_document_changed');
  h.state.asset.pdf_import_links = [chosen(file, h.state.bytes.get(path))];
  const second = await h.load();
  const b = deriveTroubleshootingChecklistContext({ issue: 'Washer not draining', asset }, normalizeManualKnowledge(second.manualKnowledge));
  assert.deepEqual(a.steps.map(step => step.label), b.steps.map(step => step.label));
  assert.notEqual(a.contextIdentity, b.contextIdentity); assert.notEqual(first.manualKnowledge.source.sha256, second.manualKnowledge.source.sha256);
});

test('register changes during extraction fail closed instead of returning detached source instructions', async () => {
  const h = fixture({ mutateRegistry: state => { state.files = []; } });
  const changed = await h.load(); assert.equal(changed.documentation_status, 'uploaded_document_changed'); assert.equal(changed.manualKnowledge, null);
});

test('asset identity and documentation approval are rechecked before publishing a guide after extraction', async () => {
  for (const change of [
    current => { current.asset.active = false; },
    current => { current.asset.manufacturer = 'Another manufacturer'; },
    current => { current.asset.model_number = 'Replacement-model'; },
    current => { current.asset.documentation_revision_id = actorId; },
    current => { current.asset.documentation_verified_at = null; },
    current => { current.asset.pdf_import_links = [{ storage_path: path, applicability: 'general_reference' }]; },
  ]) {
    // Mutation occurs after the PDF was read and passed its initial exact-model
    // checks, without changing the public file-register snapshot.
    const h = fixture({ mutateRegistry: change });
    const result = await h.load();
    assert.equal(result.documentation_status, 'uploaded_document_changed');
    assert.equal(result.manualKnowledge, null);
    assert.match(result.documentation_reason, /equipment identity, activation or documentation review changed/i);
    assert.deepEqual(h.state.queries, ['assets']);
    assert.equal(h.state.network, 0);
  }
});

test('new registered PDFs require explicit user choice before guide use', async () => {
  const h = fixture({ files: [], asset: { ...asset, documentation_verified_at: null } });
  assert.equal((await h.load()).documentation_status, 'no_uploaded_document');
  const later = { ...file, id: 'future-registration', name: 'Future manufacturer instructions.PDF', storage_path: `${hotel}/${assetId}/2030-new-document.PDF`, preferred: true, updated_at: '2030-01-02T03:04:05Z' };
  h.state.files.push(later); h.state.bytes.set(later.storage_path, original);
  assert.equal((await h.load()).documentation_status, 'manual_applicability_unresolved');
  h.state.asset.pdf_import_links = [chosen(later)];
  const reviewed = await h.load();
  assert.equal(reviewed.documentation_status, 'verified');
  assert.equal(reviewed.manualKnowledge.source.source_file_name, later.name); assert.equal(reviewed.manualKnowledge.source.storage_path, later.storage_path);
  assert.equal(reviewed.manualKnowledge.source.registered_file_id, later.id); assert.equal(reviewed.manualKnowledge.source.sha256, hash(original));
  assert.deepEqual(Array.from(reviewed.manualKnowledge.symptom_rules[0].steps), ['Clean the drain filter.', 'Check the drain hose.']);
  assert.equal(h.state.network, 0); assert.deepEqual(h.state.queries, ['assets']);
});

test('unsupported attachments warn without displacing explicitly chosen PDFs', async () => {
  const future = { ...file, id: 'future-docx', name: 'Future procedure.docx', storage_path: `${hotel}/${assetId}/future.docx`, preferred: true };
  const h = fixture({ files: [file, future] });
  const result = await h.load();
  assert.equal(result.documentation_status, 'verified');
  assert.equal(result.manualKnowledge.sources.length, 1);
  assert.match(result.documentation_warnings.join(' '), /Future procedure/);
  h.state.files = [future];
  assert.equal((await h.load()).documentation_status, 'manual_applicability_unresolved');
});

test('strict source endpoint checks active account, equipment roles including secondary assignments, asset and hotel scope', async () => {
  const denied = fixture({ role: 'Front Desk' }); assert.equal((await denied.request()).status, 403); assert.equal(denied.state.registryReads, 0);
  const secondary = fixture({ role: 'Front Desk', secondary: ['Maintenance Technician'] }); assert.equal((await secondary.request()).status, 200);
  const manager = fixture({ role: 'General Manager' }); assert.equal((await manager.request()).status, 200, 'authorized PM viewers can read without editing equipment');
  secondary.principal.membership.active = false; assert.equal((await secondary.request()).status, 403);
  const foreign = fixture({ asset: { ...asset, hotel_id: actorId } }); assert.equal((await foreign.request()).status, 404);
  const unsigned = fixture({ authenticated: false }); assert.equal((await unsigned.request()).status, 401);
});

test('asset-upload routing runs before consolidation dispatch and cannot invoke the catalog branch', async () => {
  const route = readFileSync(new URL('../src/app/api/maintenance-reference/route.ts', import.meta.url), 'utf8');
  const exports = {}; let strict = 0;
  vm.runInNewContext(ts.transpileModule(route, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require(name) {
    if (name === '@/lib/server/uploaded-asset-guide') return { readUploadedAssetMaintenanceReference: async () => { strict++; return Response.json({ source: 'attached-only' }); } };
    if (name === '@/lib/server/consolidation-stage') return { dispatchConsolidation: () => { throw Error('Strict source must bypass consolidation/catalog selection.'); } };
    return {};
  } });
  const response = await exports.GET({ nextUrl: new URL('https://cmpri.example/api/maintenance-reference?source=asset-upload') });
  assert.equal((await response.json()).source, 'attached-only'); assert.equal(strict, 1);
});

const diagramPdf = new Uint8Array(readFileSync(new URL('./fixtures/uploaded-guide-diagrams.pdf', import.meta.url)));
const replacementDiagramPdf = new Uint8Array(readFileSync(new URL('./fixtures/uploaded-guide-diagrams-replacement.pdf', import.meta.url)));
const diagramAsset = { ...asset, manufacturer: 'Fixture Laundry', model_family: 'Demonstrator', model_number: 'TEST-1' };
diagramAsset.pdf_import_links = [chosen(file, diagramPdf, diagramAsset)];

test('a derivative that cannot be sized is evicted without failing the authorized guide', async () => {
  const h = fixture({ asset: structuredClone(diagramAsset), bytes: new Map([[path, diagramPdf]]), circularMedia: true });
  assert.equal((await h.request()).body.documentation_status, 'verified');
  assert.equal((await h.request()).body.documentation_status, 'verified');
  assert.equal(h.state.extractions, 1); assert.equal(h.state.inspections, 2);
});

test('authorized uploaded PDF figures become bounded private PNGs only for explicit current source steps', async () => {
  const h = fixture({ asset: structuredClone(diagramAsset), bytes: new Map([[path, diagramPdf]]) });
  const loaded = await h.request(); assert.equal(loaded.status, 200);
  const guide = loaded.body.manualKnowledge;
  assert.ok(guide.step_media.length >= 3);
  assert.ok(guide.step_media.every(item => [3, 4, 5].includes(item.sourcePage)), 'cover logo and image-free code page are excluded');
  const drain = guide.step_media.find(item => item.sourcePage === 4);
  assert.ok(drain); assert.match(drain.stepLabel, /Figure 1/i);
  const normalized = normalizeManualKnowledge(guide);
  const current = deriveTroubleshootingChecklistContext({ issue: 'Washer will not drain', asset: diagramAsset }, normalized);
  assert.ok(current.steps.some(step => step.media?.some(item => item.id === drain.id)));
  assert.ok(!current.steps.some(step => step.media?.some(item => item.sourcePage === 5)), 'fill diagram is not attached to drain steps');
  const image = await h.request(assetId, { imageId: drain.id, sha256: guide.source.sha256 });
  assert.equal(image.status, 200); assert.deepEqual([...image.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const again = await h.request(assetId, { imageId: drain.id, sha256: guide.source.sha256 });
  assert.deepEqual(again.body, image.body); assert.equal(h.state.extractions, 1); assert.equal(h.state.inspections, 1); assert.equal(h.state.renders, 1);
  assert.equal(h.state.downloads.length, 3); assert.equal(h.state.registryReads, 6);
  assert.match(image.headers.get('cache-control'), /private.*no-store/); assert.equal(image.headers.get('vary'), 'Authorization');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff'); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok(drain.width <= 1400 && drain.height <= 1400 && drain.width * drain.height <= 2_000_000);
  assert.ok(h.state.downloads.every(storagePath => storagePath === path)); assert.equal(h.state.network, 0);
});

test('source image requests reject stale hashes, guessed identifiers and changed approval or registry', async () => {
  const h = fixture({ asset: structuredClone(diagramAsset), bytes: new Map([[path, diagramPdf]]) });
  const first = await h.request(); const sourceGuide = first.body.manualKnowledge;
  const id = sourceGuide.step_media.find(item => item.sourcePage === 4).id;
  assert.equal((await h.request(assetId, { imageId: id, sha256: 'b'.repeat(64) })).status, 409);
  assert.equal((await h.request(assetId, { imageId: `media-${'b'.repeat(64)}`, sha256: sourceGuide.source.sha256 })).status, 404);
  assert.equal((await h.request(assetId, { imageId: 'https://external.example/figure.png', sha256: sourceGuide.source.sha256 })).status, 400);
  assert.equal((await h.request(assetId, { imageId: id })).status, 400);
  h.state.bytes.set(path, replacementDiagramPdf);
  assert.equal((await h.request(assetId, { imageId: id, sha256: sourceGuide.source.sha256 })).status, 409);
  h.state.asset.pdf_import_links = [chosen(file, replacementDiagramPdf, diagramAsset)];
  const replaced = await h.request(); const replacement = replaced.body.manualKnowledge;
  assert.notEqual(replacement.source.sha256, sourceGuide.source.sha256);
  assert.equal((await h.request(assetId, { imageId: id, sha256: replacement.source.sha256 })).status, 404);
  h.state.asset.documentation_revision_id = actorId;
  const unreviewed = await h.request(assetId, { imageId: replacement.step_media[0].id, sha256: replacement.source.sha256 });
  assert.equal(unreviewed.status, 200);
  h.state.asset.documentation_revision_id = null;
  h.state.registryReads = 0; h.state.mutateRegistry = current => { current.files = []; };
  const detached = await h.request(assetId, { imageId: replacement.step_media[0].id, sha256: replacement.source.sha256 });
  assert.equal(detached.status, 409); assert.equal(detached.body.documentation_status, 'uploaded_document_changed');
  assert.equal(h.state.network, 0);
});

test('image serving retains active account, property and PM reference read authorization', async () => {
  const image = { imageId: `media-${'a'.repeat(64)}`, sha256: hash(diagramPdf) };
  for (const [overrides, status] of [[{ authenticated: false }, 401], [{ role: 'Front Desk' }, 403], [{ asset: { ...diagramAsset, hotel_id: actorId } }, 404], [{ asset: { ...diagramAsset, active: false } }, 404]]) {
    const h = fixture({ bytes: new Map([[path, diagramPdf]]), ...overrides });
    assert.equal((await h.request(assetId, image)).status, status); assert.equal(h.state.downloads.length, 0);
  }
});

test('an unlabelled future manual exposes searchable source pages without inventing checklist steps',async()=>{
 const bytes=pdf(['Door latch wiring diagram', 'Door lock wiring and mechanical assembly.']);
 const h=fixture({bytes:new Map([[path,bytes]])});const result=await h.load();
 assert.equal(result.documentation_status,'no_guidance');assert.equal(result.manualKnowledge.symptom_rules.length,0);
 const normalized=normalizeManualKnowledge(result.manualKnowledge);
 assert.equal(normalized.source_passages[0].kind,'reference');
 assert.deepEqual(source.relevantSourcePassages(normalized.source_passages,'door lock broken').map(page=>page.page),[1]);
 assert.equal(deriveTroubleshootingChecklistContext({issue:'door lock broken',asset},normalized).steps.length,0);
});


test('OCR waits for a complete source-specific scan and then exposes source-linked checks',async()=>{
 const h=fixture({bytes:new Map([[path,pdf([], 'scan')]]),ocrStatus:'processing'});const pending=await h.load();assert.equal(pending.documentation_status,'uploaded_document_ocr_processing');assert.deepEqual(pending.manualKnowledge.symptom_rules,[]);
 h.state.ocrStatus='complete';h.state.ocrPages=[{page:2,confidence:95,text:'Door lock stuck\n1. Inspect the latch.\n2. Check the wiring.'}];const ready=await h.load();assert.equal(ready.documentation_status,'verified');assert.equal(ready.manualKnowledge.symptom_rules.length,1);assert.ok(ready.manualKnowledge.symptom_rules[0].steps.every(step=>step.startsWith('OCR — ')));assert.deepEqual(ready.manualKnowledge.symptom_rules[0].source_pages,[2]);
});


test('an existing scanned asset is queued once and remains openable while OCR runs',async()=>{
 const h=fixture({bytes:new Map([[path,pdf([], 'scan')]]),ocrStatus:'missing'});const first=await h.load();assert.equal(first.documentation_status,'uploaded_document_ocr_processing');assert.ok(first.manualKnowledge.source.file_url);assert.equal(h.state.ocrEnqueues,1);const second=await h.load();assert.equal(second.documentation_status,'uploaded_document_ocr_processing');assert.equal(h.state.ocrEnqueues,1);
});



test('whole source pages render independently of text and cropped-figure extraction', async () => {
  const h = fixture({ bytes: new Map([[path, diagramPdf]]), failExtraction: true, failInspection: true });
  const image = { pageImage: '3', sha256: hash(diagramPdf) };
  const first = await h.request(assetId, image);
  assert.equal(first.status, 200);
  assert.deepEqual([...first.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.match(first.headers.get('cache-control'), /private.*no-store/);
  assert.equal(first.headers.get('vary'), 'Authorization');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(h.state.extractions, 0);
  assert.equal(h.state.inspections, 0);
  assert.equal(h.state.ocrEnqueues, 0);
  const again = await h.request(assetId, image);
  assert.deepEqual(again.body, first.body);
  assert.equal(h.state.renders, 1);
  assert.equal(h.state.downloads.length, 2);
  assert.equal(h.state.registryReads, 4);
  assert.deepEqual(h.state.queries, ['assets', 'assets', 'assets', 'assets']);
});

test('whole source pages validate input and retain source, account and property checks', async () => {
  const image = { pageImage: '3', sha256: hash(diagramPdf) };
  for (const invalid of [{ pageImage: '0' }, { pageImage: '10001' }, { pageImage: '1.5' }, { pageImage: '-1' }, { pageImage: 'abc' }, { sha256: '' }, { imageId: `media-${'a'.repeat(64)}` }]) {
    const h = fixture({ bytes: new Map([[path, diagramPdf]]) });
    assert.equal((await h.request(assetId, { ...image, ...invalid })).status, 400);
    assert.equal(h.state.downloads.length, 0);
  }
  for (const [overrides, status] of [[{ authenticated: false }, 401], [{ role: 'Front Desk' }, 403], [{ asset: { ...asset, hotel_id: actorId } }, 404], [{ asset: { ...asset, active: false } }, 404]]) {
    const h = fixture({ bytes: new Map([[path, diagramPdf]]), ...overrides });
    assert.equal((await h.request(assetId, image)).status, status);
    assert.equal(h.state.downloads.length, 0);
  }
  const h = fixture({ bytes: new Map([[path, diagramPdf]]) });
  assert.equal((await h.request(assetId, { ...image, sha256: 'b'.repeat(64) })).status, 409);
  assert.equal((await h.request(assetId, { ...image, pageImage: '600' })).status, 404);
  h.state.mutateRegistry = state => { state.files = []; };
  h.state.registryReads = 0;
  assert.equal((await h.request(assetId, image)).status, 409);
  const changedAsset = fixture({ bytes: new Map([[path, diagramPdf]]), mutateRegistry: state => { state.asset.active = false; } });
  assert.equal((await changedAsset.request(assetId, image)).status, 409);
});


test('mixed manuals queue image-only pages without hiding readable source content', async () => {
  const bytes = pdf(['ACME W1 service manual', 'Troubleshooting', 'Symptom: Washer not draining', '1. Clean the drain filter.'], 'scan');
  const h = fixture({ bytes: new Map([[path, bytes]]), ocrStatus: 'missing' });
  const pending = await h.load();
  assert.equal(h.state.ocrEnqueues, 1);
  assert.equal(pending.documentation_status, 'verified', 'readable native instructions remain available');
  assert.equal(pending.manualKnowledge.source.search_incomplete, true);
  assert.match(pending.documentation_reason, /Text recognition is processing.*Search results may be incomplete/);
  assert.deepEqual(pending.manualKnowledge.symptom_rules[0].steps, ['Clean the drain filter.']);
  assert.deepEqual(pending.manualKnowledge.source_passages.map(page => page.page), [1]);
  await h.load();assert.equal(h.state.ocrEnqueues, 1);
  h.state.ocrStatus = 'complete';
  h.state.ocrPages = [
    { page: 1, confidence: 95, text: 'Native page must not be replaced by this OCR text.' },
    { page: 2, confidence: 95, text: 'Door lock stuck\n1. Inspect the latch.\n2. Check the wiring.' },
  ];
  const ready = await h.load();
  assert.equal(ready.manualKnowledge.source.search_incomplete, false);
  assert.deepEqual(ready.manualKnowledge.source_passages.map(page => page.page), [1, 2]);
  assert.match(ready.manualKnowledge.source_passages[0].text, /ACME W1 service manual/);
  assert.deepEqual(source.relevantSourcePassages(ready.manualKnowledge.source_passages, 'door lock stuck').map(page => page.page), [2]);
  assert.equal(ready.manualKnowledge.source_passages[1].origin, 'ocr');
  assert.match(ready.manualKnowledge.source_passages[1].html, /OCR text: compare with the original source page/);
  assert.equal(ready.manualKnowledge.source_passages[1].source_url, ready.manualKnowledge.source.file_url);
  assert.equal(ready.manualKnowledge.symptom_rules.length, 2);
  assert.ok(ready.manualKnowledge.symptom_rules[1].steps.every(step => step.startsWith('OCR — ')));
  assert.deepEqual(ready.manualKnowledge.symptom_rules[1].source_pages, [2]);
  assert.equal(normalizeManualKnowledge(pending.manualKnowledge).source.search_incomplete, true);
});

test('failed mixed-manual OCR reports incomplete search rather than absence of instructions', async () => {
  const h = fixture({ bytes: new Map([[path, pdf(['Readable cover'], 'scan')]]), ocrStatus: 'failed' });
  const result = await h.load();
  assert.equal(result.documentation_status, 'no_guidance');
  assert.equal(result.manualKnowledge.source.search_incomplete, true);
  assert.match(result.documentation_reason, /could not finish.*Search results may be incomplete/);
  assert.deepEqual(result.manualKnowledge.symptom_rules, []);
  assert.equal(h.state.ocrEnqueues, 0);
});


test('completed OCR with missing, blank or unrelated pages retains the incomplete-search warning', async () => {
  for (const pages of [[], [{ page: 2, confidence: 95, text: '   ' }], [{ page: 3, confidence: 95, text: 'Door lock stuck' }]]) {
    const h = fixture({ bytes: new Map([[path, pdf(['Readable cover'], 'scan')]]), ocrStatus: 'complete', ocrPages: pages });
    const result = await h.load();
    assert.equal(result.manualKnowledge.source.search_incomplete, true);
    assert.match(result.documentation_reason, /did not recover searchable text from every page/);
    assert.deepEqual(result.manualKnowledge.source_passages.map(page => page.page), [1]);
    assert.deepEqual(result.manualKnowledge.symptom_rules, []);
  }
});

test('genuinely blank pages do not consume OCR or shift native page numbers', async () => {
  const h = fixture({ bytes: new Map([[path, pdf([], ['Door latch native reference'])]]), ocrStatus: 'complete', ocrPages: [{ page: 1, confidence: 95, text: 'Door lock scanned reference' }] });
  const result = await h.load();
  assert.equal(result.manualKnowledge.source.search_incomplete, false);
  assert.equal(result.manualKnowledge.source_passages.find(page => page.page === 1), undefined);
  assert.equal(h.state.ocrEnqueues, 0);
  assert.match(result.manualKnowledge.source_passages.find(page => page.page === 2).text, /Door latch native reference/);
});

test('saved reviewed converter pages override native actions and render escaped source-linked HTML', async () => {
  const h = fixture({ reviewedPages: [{ page: 1, totalPages: 1, text: 'Troubleshooting\nSymptom: Washer not draining\n1. Inspect the drain outlet with power disconnected.\n2. Check the pump connector.\n<script>not markup</script>' }] });
  const { body } = await h.request();
  assert.equal(body.documentation_status, 'verified');
  const knowledge = normalizeManualKnowledge(body.manualKnowledge);
  assert.equal(knowledge.source.type, 'Uploaded PDF with human-reviewed text');
  assert.ok(knowledge.symptom_rules.some(rule => rule.steps.some(step => step.includes('Inspect the drain outlet'))));
  assert.ok(!knowledge.symptom_rules.some(rule => rule.steps.some(step => step.includes('Clean the drain filter'))));
  const page = knowledge.source_passages.find(p => p.page === 1);
  assert.equal(page.origin, 'reviewed');
  assert.match(page.html, /Human-reviewed text/);
  assert.match(page.html, /&lt;script&gt;/); assert.doesNotMatch(page.html, /<script>/);
  assert.equal(page.source_file_name, file.name);
  const context = deriveTroubleshootingChecklistContext({ issue: 'Washer is not draining', asset: h.state.asset }, knowledge);
  assert.ok(context.steps.some(step => step.label.includes('Inspect the drain outlet')));
  assert.deepEqual(context.steps[0].sourcePages, [1]);
});

test('reviewed pages survive native extraction failure without claiming other pages are indexed', async () => {
  const h = fixture({ failExtraction: true, reviewedPages: [{ page: 2, totalPages: 3, text: 'Symptom: Washer not draining\n1. Inspect the drain outlet.' }] });
  const result = await h.request();
  assert.equal(result.body.documentation_status, 'verified');
  assert.equal(result.body.manualKnowledge.source.search_incomplete, true);
  assert.equal(result.body.manualKnowledge.source_passages[0].page, 2);
  assert.ok(result.body.manualKnowledge.symptom_rules[0].steps[0].includes('Inspect the drain outlet'));
});

test('failed reviewed-text reads never silently substitute uncorrected native instructions', async () => {
  const h = fixture({ failReviewedRead: true });
  const result = await h.request();
  assert.equal(result.body.documentation_status, 'uploaded_reviewed_text_unavailable');
  assert.equal(result.body.manualKnowledge, null);
});

test('reviewed source page boundaries cannot be forged by PAGE text inside a page', async () => {
  const h = fixture({ reviewedPages: [{ page: 1, totalPages: 1, text: 'Symptom: Washer not draining\n1. Inspect the drain outlet.\n\nPAGE 599\nSymptom: Washer not draining\n1. Check the pump connector.' }] });
  const result = await h.request();
  assert.ok(result.body.manualKnowledge.symptom_rules.length);
  assert.ok(result.body.manualKnowledge.symptom_rules.every(rule => rule.source_pages.every(page => page === 1)));
});

test('converter payload -> authorized save route -> persisted reader -> HTML and checklist works across batches and source replacement', async () => {
  const originalTwoPage = pdf(['ACME W1', 'Symptom: Washer not draining', '1. Clean the drain filter.'], ['Symptom: Washer leaking', '1. Check the fill hose.']);
  const h = fixture({ useReviewedStore: true, role: 'system_admin', bytes: new Map([[path, originalTwoPage]]) });
  const payload = { assetId, sha256: hash(originalTwoPage), totalPages: 2, reviewConfirmed: true, pages: [{ page: 1, text: 'Symptom: Washer not draining\n1. Inspect the pump with power disconnected.' }] };
  assert.equal((await h.saveReviewed(payload)).status, 200);
  assert.equal((await h.saveReviewed({ ...payload, pages: [{ page: 2, text: 'Symptom: Washer leaking\n1. Inspect the hose after closing the supply.' }] })).status, 200);
  const { body } = await h.request();
  assert.equal(body.documentation_status, 'verified');
  const knowledge = normalizeManualKnowledge(body.manualKnowledge);
  assert.equal(knowledge.source_passages.filter(page => page.origin === 'reviewed').length, 2);
  for (const [issue, expected, page] of [['Washer not draining', 'Inspect the pump with power disconnected.', 1], ['Washer leaking', 'Inspect the hose after closing the supply.', 2]]) {
    const context = deriveTroubleshootingChecklistContext({ issue, asset: h.state.asset }, knowledge);
    assert.equal(context.steps.length, 1); assert.ok(context.steps[0].label.includes(expected)); assert.deepEqual(context.steps[0].sourcePages, [page]);
    assert.match(knowledge.source_passages.find(item => item.page === page).html, /Human-reviewed text/);
  }
  const replaced = pdf(['ACME W1', 'Replacement manual', 'Symptom: Washer not draining', '1. Check the new manual instruction.']);
  h.state.bytes.set(path, replaced);
  assert.equal((await h.saveReviewed(payload)).status, 409);
  const changed = await h.request();
  assert.equal(changed.body.documentation_status, 'uploaded_document_changed');
  assert.equal(changed.body.manualKnowledge, null);
  h.state.files = [];
  assert.equal((await h.request()).body.documentation_status, 'no_uploaded_document');
});


test('a concurrent reviewed-text correction invalidates an in-flight guide even when PDF and register are unchanged', async () => {
  for (const reviewedPages of [[], [{ page: 1, totalPages: 1, text: 'Symptom: Washer not draining\n1. Inspect the original reviewed instruction.' }]]) {
    const h = fixture({ reviewedPages, mutateReviewedDuringInspection: state => { state.reviewedPages = [{ page: 1, totalPages: 1, text: 'Symptom: Washer not draining\n1. Inspect the newly corrected instruction.' }]; } });
    const result = await h.request();
    assert.equal(result.body.documentation_status, 'uploaded_document_changed');
    assert.equal(result.body.manualKnowledge, null);
    h.state.mutateReviewedDuringInspection = null;
    const current = await h.request();
    assert.equal(current.body.documentation_status, 'verified');
    assert.ok(current.body.manualKnowledge.symptom_rules[0].steps[0].includes('newly corrected'));
  }
});

test('a reviewed numeric serial range gates the actual troubleshooting source', async () => {
  const h = fixture();
  h.state.asset.pdf_import_links[0].serial_range = { kind: 'numeric', from: '100', to: '199' };
  h.state.asset.serial_number = '150';
  assert.equal((await h.load()).documentation_status, 'verified');
  h.state.asset.serial_number = '200';
  const outside = await h.load();
  assert.equal(outside.documentation_status, 'manual_applicability_unresolved');
  assert.match(outside.documentation_reason, /outside this manual's reviewed range/i);
  h.state.asset.serial_number = '';
  const missing = await h.load();
  assert.equal(missing.documentation_status, 'manual_applicability_unresolved');
  assert.match(missing.documentation_reason, /requires a numeric asset serial number/i);
  h.state.asset.serial_number = 'A150';
  assert.equal((await h.load()).documentation_status, 'manual_applicability_unresolved');
});
