import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { loadTs } from './helpers/load-ts.mjs';
import * as matching from '../src/lib/manual-document-match.ts';
import * as source from '../src/lib/manual-source.ts';
import * as actions from '../src/lib/uploaded-manual-actions.ts';
import * as roles from '../src/lib/server/roles.ts';
import * as access from '../src/lib/server/access.ts';
import { isUuid } from '../src/lib/uuid.ts';
import { normalizeManualKnowledge } from '../src/lib/manual-knowledge.ts';
import { deriveTroubleshootingChecklistContext } from '../src/lib/work-orders/troubleshooting-checklist.ts';
import * as guideMedia from '../src/lib/server/uploaded-guide-media.ts';

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
function pdf(lines) {
  const escape = text => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = 'BT /F1 12 Tf 14 TL 72 740 Td\n' + lines.map(line => `(${escape(line)}) Tj T*`).join('\n') + '\nET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
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
const file = { id: 'file-original', name: 'Washer service manual.pdf', storage_path: path, preferred: false, created_at: '2026-11-07T12:00:00Z', updated_at: '2026-11-07T12:00:00Z' };

function fixture(overrides = {}) {
  const state = { asset: structuredClone(asset), files: [structuredClone(file)], bytes: new Map([[path, original]]), registryReads: 0, downloads: [], queries: [], network: 0, extractions: 0, inspections: 0, renders: 0, failDownload: false, authenticated: true, role: 'Maintenance Technician', secondary: [], mutateRegistry: null, ...overrides };
  const client = {
    from(table) {
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
  const reader = loadTs('src/lib/server/uploaded-asset-guide.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/constants': { HOTEL_ID: hotel }, '@/lib/uuid': { isUuid }, '@/lib/server/roles': roles, '@/lib/server/access': access,
    '@/lib/server/auth': { requireUser: async () => state.authenticated ? { admin: client, principal } : null },
    '@/lib/server/asset-file-register': { listRegisteredAssetFiles: async () => { state.registryReads++; if (state.mutateRegistry && state.registryReads === 2) state.mutateRegistry(state); return { data: structuredClone(state.files), error: null }; } },
    '@/lib/manual-pdf-knowledge': { ...realPdf, extractManualPdfText: async bytes => { state.extractions++; return realPdf.extractManualPdfText(bytes); } }, '@/lib/manual-document-match': matching, '@/lib/manual-source': source, '@/lib/uploaded-manual-actions': actions, '@/lib/server/pdf-troubleshooting-tables': { extractPdfTroubleshootingTables: async () => [] },
    '@/lib/server/uploaded-guide-media': { ...guideMedia, inspectUploadedGuideMedia: async (...args) => { state.inspections++; const result = await guideMedia.inspectUploadedGuideMedia(...args); if (state.circularMedia && result[0]) result[0].cycle = result[0]; return result; }, renderUploadedGuideMedia: async (...args) => { state.renders++; return guideMedia.renderUploadedGuideMedia(...args); } },
  }, { Response, Uint8Array, Error, fetch: () => { state.network++; throw Error('No external recognition or provider requests are permitted.'); } });
  return { state, principal, load: () => reader.loadUploadedAssetGuide(client, state.asset), request: async (id = assetId, image = {}) => {
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
  assert.equal(h.state.extractions, 2); assert.equal(h.state.inspections, 2);
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

test('the selected asset attachment is used without separate review', async () => {
  const link = { object_id: file.id, storage_path: path, manufacturer: 'ACME', selected_model: 'W1', applicability: 'confirmed_model', file_verified: true, sha256: hash(original) };
  const h = fixture({ asset: { ...asset, documentation_verified_at: null, pdf_import_links: [link] } });
  assert.equal((await h.load()).documentation_status, 'verified');
  h.state.asset.pdf_import_links[0].sha256 = 'b'.repeat(64);
  const changed = await h.load(); assert.equal(changed.documentation_status, 'verified'); assert.equal(changed.manualKnowledge.source.sha256, hash(original));
});

test('preferred source is authoritative, and ambiguous matching attachments require explicit source selection', async () => {
  const secondPath = `${hotel}/${assetId}/second.pdf`;
  const second = { ...file, id: 'second', name: 'Second manual.pdf', storage_path: secondPath };
  const h = fixture({ files: [file, second], bytes: new Map([[path, original], [secondPath, original]]) });
  assert.equal((await h.load()).documentation_status, 'ambiguous_uploaded_documents');
  h.state.files[1].preferred = true;
  const preferred = await h.load(); assert.equal(preferred.documentation_status, 'verified'); assert.equal(preferred.manualKnowledge.source.storage_path, secondPath);
  h.state.bytes.set(secondPath, pdf(['OTHER Z9', 'Troubleshooting', 'Symptom: Washer not draining', '1. Replace everything.']));
  const wrong = await h.load(); assert.equal(wrong.documentation_status, 'verified'); assert.equal(wrong.manualKnowledge.source.storage_path, secondPath);
  assert.equal(h.state.downloads.at(-1), secondPath, 'a preferred mismatch never falls back to a different attachment');
});

test('image-only scans and invalid PDF signatures yield explicit source errors without invented steps', async () => {
  const h = fixture({ bytes: new Map([[path, pdf([])]]) });
  const scan = await h.load(); assert.equal(scan.documentation_status, 'uploaded_document_needs_ocr'); assert.equal(scan.manualKnowledge, null); assert.match(scan.documentation_reason, /on-device OCR/);
  h.state.bytes.set(path, new Uint8Array(Buffer.from('<html>not a PDF</html>')));
  const invalid = await h.load(); assert.equal(invalid.documentation_status, 'unreadable_uploaded_document'); assert.equal(invalid.manualKnowledge, null);
});

test('source byte changes invalidate checklist context even when extracted actions stay identical', async () => {
  const h = fixture(); const first = await h.load();
  const a = deriveTroubleshootingChecklistContext({ issue: 'Washer not draining', asset }, normalizeManualKnowledge(first.manualKnowledge));
  h.state.bytes.set(path, new Uint8Array(Buffer.concat([Buffer.from(original), Buffer.from('% revised source bytes\n')])));
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

test('future attached PDFs are discovered from the current register without separate review', async () => {
  const h = fixture({ files: [], asset: { ...asset, documentation_verified_at: null } });
  assert.equal((await h.load()).documentation_status, 'no_uploaded_document');
  const later = { ...file, id: 'future-registration', name: 'Future manufacturer instructions.PDF', storage_path: `${hotel}/${assetId}/2030-new-document.PDF`, preferred: true, updated_at: '2030-01-02T03:04:05Z' };
  h.state.files.push(later); h.state.bytes.set(later.storage_path, original);
  assert.equal((await h.load()).documentation_status, 'verified');
  h.state.asset.pdf_import_links = [{ object_id: later.id, storage_path: later.storage_path, manufacturer: 'ACME', selected_model: 'W1', applicability: 'confirmed_model', file_verified: true, sha256: hash(original) }];
  const reviewed = await h.load();
  assert.equal(reviewed.documentation_status, 'verified');
  assert.equal(reviewed.manualKnowledge.source.source_file_name, later.name); assert.equal(reviewed.manualKnowledge.source.storage_path, later.storage_path);
  assert.equal(reviewed.manualKnowledge.source.registered_file_id, later.id); assert.equal(reviewed.manualKnowledge.source.sha256, hash(original));
  assert.deepEqual(Array.from(reviewed.manualKnowledge.symptom_rules[0].steps), ['Clean the drain filter.', 'Check the drain hose.']);
  assert.equal(h.state.network, 0); assert.deepEqual(h.state.queries, ['assets', 'assets']);
});

test('unsupported future sources fail closed and never silently select an older PDF instead', async () => {
  const future = { ...file, id: 'future-docx', name: 'Preferred future procedure.docx', storage_path: `${hotel}/${assetId}/future.docx`, preferred: true };
  const h = fixture({ files: [file, future] });
  const unsupported = await h.load();
  assert.equal(unsupported.documentation_status, 'unsupported_uploaded_document'); assert.equal(unsupported.manualKnowledge, null);
  assert.match(unsupported.documentation_reason, /attached PDF sources.*not supported.*no older PDF/i);
  assert.equal(h.state.downloads.length, 0);
  h.state.files[1].preferred = false;
  const ambiguous = await h.load(); assert.equal(ambiguous.documentation_status, 'ambiguous_uploaded_documents'); assert.equal(ambiguous.manualKnowledge, null);
  h.state.files = [future];
  const onlyUnsupported = await h.load(); assert.equal(onlyUnsupported.documentation_status, 'unsupported_uploaded_document'); assert.equal(onlyUnsupported.manualKnowledge, null);
  assert.equal(h.state.network, 0);
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
