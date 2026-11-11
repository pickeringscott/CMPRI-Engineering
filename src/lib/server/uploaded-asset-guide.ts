import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { HOTEL_ID } from '@/lib/constants';
import { isUuid } from '@/lib/uuid';
import { allows } from '@/lib/server/access';
import { requireUser } from '@/lib/server/auth';
import { listRegisteredAssetFiles, type RegisteredAssetFile } from '@/lib/server/asset-file-register';
import { extractManualPdfText, manualPdfSha256 } from '@/lib/manual-pdf-knowledge';
import { manualPartsPassages, manualReferencePages, manualSourcePassages, type SourcePassage } from '@/lib/manual-source';
import { uploadedManualHtmlActions } from '@/lib/uploaded-manual-actions';
import { structureManualDocument, structureManualPage, sourcePageHtml } from '@/lib/manual-document-html';
import { readReviewedManualPages } from '@/lib/server/reviewed-manual-text';
import { extractPdfTroubleshootingTables } from '@/lib/server/pdf-troubleshooting-tables';
import type { ManualKnowledge } from '@/lib/manual-knowledge';
import { inspectUploadedGuideMedia, renderUploadedGuideMedia, renderUploadedGuidePage, type InspectedUploadedGuideMedia } from '@/lib/server/uploaded-guide-media';

const bucket = 'asset-documentation';
const verificationMarker = '_cmpri-verification.json';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization' };
// These are derived only from the downloaded bytes, never from a user's access
// or an asset's approval. Every request still downloads and hashes the source,
// verifies the current association, and rechecks the asset/register afterward.
// This bounded warm-instance cache avoids re-parsing the same PDF for each
// guide and illustration request; failures are never cached.
const derivativeLimit = 16 * 1024 * 1024, derivativeEntries = 32, derivativeTtl = 5 * 60 * 1000;
type Derivative = { promise: Promise<unknown>; bytes: number; expires: number };
const derivatives = new Map<string, Derivative>();
function cachedDerivative<T>(key: string, calculate: () => Promise<T> | T): Promise<T> {
  const old = derivatives.get(key);
  if (old && old.expires > Date.now()) {
    derivatives.delete(key); derivatives.set(key, old);
    return old.promise as Promise<T>;
  }
  if (old) derivatives.delete(key);
  const entry: Derivative = { promise: Promise.resolve().then(calculate), bytes: 0, expires: Date.now() + derivativeTtl };
  derivatives.set(key, entry);
  const trim = () => {
    let bytes = [...derivatives.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (derivatives.size > derivativeEntries || bytes > derivativeLimit) {
      const first = derivatives.entries().next().value as [string, Derivative] | undefined;
      if (!first) break;
      derivatives.delete(first[0]); bytes -= first[1].bytes;
    }
  };
  trim();
  void entry.promise.then(value => {
    if (derivatives.get(key) !== entry) return;
    try {
      // UTF-16 JSON size is a conservative estimate for the cached objects.
      const serialized = value instanceof Uint8Array ? null : JSON.stringify(value);
      if (serialized === undefined) throw new Error('Derivative size is unavailable');
      entry.bytes = value instanceof Uint8Array ? value.byteLength : serialized!.length * 2;
      entry.expires = Date.now() + derivativeTtl;
      trim();
    } catch {
      // Do not retain an unaccounted value or reject an otherwise valid read.
      if (derivatives.get(key) === entry) derivatives.delete(key);
    }
  }, () => { if (derivatives.get(key) === entry) derivatives.delete(key); });
  return entry.promise as Promise<T>;
}
type Asset = {
  id: string;
  hotel_id: string;
  active: boolean | null;
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
  documentation_key: string | null;
  documentation_revision_id: string | null;
  documentation_verified_at: string | null;
  pdf_import_links?: unknown;
};
type GuideResult = { documentation_status: string; documentation_reason: string; manualKnowledge: ManualKnowledge | null; documentation_warnings: string[]; media_image?: Uint8Array };
const unavailable = (documentation_status: string, documentation_reason: string, documentation_warnings: string[] = []): GuideResult => ({ documentation_status, documentation_reason, manualKnowledge: null, documentation_warnings });

function registeredIdentity(files: RegisteredAssetFile[]) {
  return JSON.stringify(files.map(file => ({ id: file.id, name: file.name, storage_path: file.storage_path, preferred: file.preferred, created_at: file.created_at, updated_at: file.updated_at }))
    .sort((a, b) => a.storage_path.localeCompare(b.storage_path) || a.id.localeCompare(b.id)));
}

function assetReviewIdentity(asset: Asset) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(Object.fromEntries(['id', 'hotel_id', 'active', 'manufacturer', 'model_family', 'model_number', 'documentation_key', 'documentation_revision_id', 'documentation_verified_at', 'pdf_import_links']
    .map(key => [key, asset[key as keyof Asset] ?? null]))));
}

/** Read only the PDFs currently registered on this asset; never consult a catalog. */
export async function loadUploadedAssetGuide(admin: SupabaseClient, asset: Asset, image?: { id: string; sha256: string; page?: number }): Promise<GuideResult> {
  const assetSnapshot = assetReviewIdentity(asset);
  if (asset.hotel_id !== HOTEL_ID || asset.active === false) return unavailable('no_uploaded_document', 'The saved equipment is unavailable at this property.');
  const registered = await listRegisteredAssetFiles(admin, asset.id);
  if (registered.error) throw new Error('The authorized asset attachment register could not be read.');
  const files = registered.data;
  let recheckReviewedText: (() => Promise<boolean>) | null = null;
  const recheckSource = async (): Promise<GuideResult | null> => {
    // Rendering is not authorization: recheck the association and asset after
    // all byte-derived work, including the independent full-page render path.
    const current = await listRegisteredAssetFiles(admin, asset.id);
    if (current.error || registeredIdentity(current.data) !== registeredIdentity(files)) return unavailable('uploaded_document_changed', 'The attached source document changed while it was being read. Reload the guide before using its instructions.');
    const currentAsset = await admin.from('assets').select('id,hotel_id,active,manufacturer,model_family,model_number,documentation_key,documentation_revision_id,documentation_verified_at,pdf_import_links')
      .eq('hotel_id', HOTEL_ID).eq('id', asset.id).maybeSingle();
    if (currentAsset.error || !currentAsset.data || assetReviewIdentity(currentAsset.data as Asset) !== assetSnapshot) return unavailable('uploaded_document_changed', 'The equipment identity, activation or documentation review changed while the attachment was being read. Reload the guide before using its instructions.');
    if (recheckReviewedText && !await recheckReviewedText()) return unavailable('uploaded_document_changed', 'Reviewed source text changed while the guide was being prepared. Reload the guide before using its instructions.');
    return null;
  };
  const documents = files.filter(file => file.name !== verificationMarker && file.storage_path);
  const preferred = documents.filter(file => file.preferred);
  if (preferred.length > 1) return unavailable('ambiguous_uploaded_documents', 'More than one attachment is marked as the guide. Select one preferred PDF source document.');
  if (preferred.length && !/\.pdf$/i.test(preferred[0].name || '')) return unavailable('unsupported_uploaded_document', `${preferred[0].name}: troubleshooting currently reads attached PDF sources. This preferred attachment is not supported; no older PDF, catalog manual or AI fallback was substituted.`);
  const pdfs = documents.filter(file => /\.pdf$/i.test(file.name || ''));
  if (!pdfs.length && documents.length) return unavailable('unsupported_uploaded_document', 'Troubleshooting currently reads attached PDF sources. The attached document format is not supported; attach and review a PDF source. No catalog or AI fallback was used.');
  if (!pdfs.length) return unavailable('no_uploaded_document', 'No uploaded PDF is attached to this asset. Attach and review its source document to provide a troubleshooting guide.');
  if (!preferred.length && documents.length !== pdfs.length) return unavailable('ambiguous_uploaded_documents', 'Some attached document formats cannot be checked. Select the intended preferred PDF source before showing a troubleshooting guide.');
  const candidates = preferred.length ? preferred : pdfs;
  const matching: { file: RegisteredAssetFile; text: string; sha256: string; bytes: Uint8Array; reviewed: Awaited<ReturnType<typeof readReviewedManualPages>> }[] = [];
  const failures: { status: string; message: string }[] = [];
  for (const file of candidates) {
    const path = file.storage_path;
    if (!file.id || path.startsWith('/') || path.includes('://') || path.split('/').some(part => part === '..')
      || !(path.startsWith(`${HOTEL_ID}/`) || /^asset docs\//i.test(path))) {
      failures.push({ status: 'unreadable_uploaded_document', message: `${file.name}: the registered PDF path is not an authorized property document.` });
      continue;
    }
    const stored = await admin.storage.from(bucket).download(path);
    if (stored.error || !stored.data) {
      failures.push({ status: 'unreadable_uploaded_document', message: `${file.name}: the attached PDF could not be read. Restore or review this attachment; no other manual was substituted.` });
      continue;
    }
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await stored.data.arrayBuffer()); }
    catch { failures.push({ status: 'unreadable_uploaded_document', message: `${file.name}: this attachment's bytes could not be read.` }); continue; }
    if (bytes.length < 5 || ![37,80,68,70,45].every((value, index) => bytes[index] === value)) {
      failures.push({ status: 'unreadable_uploaded_document', message: `${file.name}: the saved attachment is not a valid PDF.` });
      continue;
    }
    const sha256 = manualPdfSha256(bytes);
    let reviewed: Awaited<ReturnType<typeof readReviewedManualPages>> = [];
    if (image?.page === undefined) {
      try { reviewed = await readReviewedManualPages(admin, { hotelId: HOTEL_ID, assetId: asset.id, sha256, file }); }
      catch { return unavailable('uploaded_reviewed_text_unavailable', 'Saved reviewed text could not be checked. Reload the guide before using its instructions.'); }
    }
    let text: string;
    // A whole source page does not depend on extracting checklist text or
    // associating cropped figures with steps. Those can fail on scanned PDFs
    // even when the original page can be rendered faithfully.
    try { text = image?.page !== undefined ? '' : await cachedDerivative(`text:v2:${sha256}`, () => extractManualPdfText(bytes, { includeEmptyPages: true })); }
    catch {
      if (!reviewed.length) {
        failures.push({ status: 'unreadable_uploaded_document', message: `${file.name}: readable text could not be extracted from the attached PDF. Open it for review or use on-device OCR with human verification.` });
        continue;
      }
      // Reviewed converter output remains usable when native extraction fails.
      // Preserve every page slot so a partial review cannot imply full coverage.
      text = Array.from({ length: reviewed[0].totalPages }, (_, index) => `PAGE ${index + 1}\n`).join('\n\n');
      failures.push({ status: 'uploaded_native_text_unavailable', message: 'Native PDF text could not be read. Only saved reviewed text is available until the remaining pages are processed.' });
    }
    // A readable PDF with no text can still be opened as a source. Never turn
    // an image-only page into guessed checklist instructions.
    matching.push({ file, text, sha256, bytes, reviewed });
  }
  if (matching.length > 1) return unavailable('ambiguous_uploaded_documents', 'More than one attached PDF matches this equipment. Select one preferred source document before showing a guide.');
  if (!matching.length) {
    const first = failures[0] || { status: 'no_uploaded_document', message: 'No usable uploaded source document is attached to this asset.' };
    return unavailable(first.status, first.message, failures.slice(1).map(failure => failure.message));
  }
  if (!preferred.length && candidates.length > 1 && failures.some(failure => failure.status === 'unreadable_uploaded_document' || failure.status === 'uploaded_document_needs_ocr')) {
    return unavailable('ambiguous_uploaded_documents', 'Some attached PDFs could not be checked. Select the intended preferred source document before using a guide.', failures.map(failure => failure.message));
  }
  const selected = matching[0];
  if (image?.page === undefined) {
    const snapshot = JSON.stringify(selected.reviewed);
    recheckReviewedText = async () => snapshot === JSON.stringify(await readReviewedManualPages(admin, { hotelId: HOTEL_ID, assetId: asset.id, sha256: selected.sha256, file: selected.file }));
  }
  if (image && image.sha256 !== selected.sha256) return unavailable('uploaded_document_changed', 'The uploaded PDF changed. Reload the guide before opening its image.');
  if (image?.page !== undefined) {
    let rendered: Uint8Array;
    try { rendered = await cachedDerivative(`page:v1:${selected.sha256}:${image.page}`, () => renderUploadedGuidePage(selected.bytes, selected.sha256, image.page!)); }
    catch { return unavailable('uploaded_image_unavailable', 'The source page could not be rendered safely. Open the approved source PDF instead.'); }
    const changed = await recheckSource();
    if (changed) return changed;
    return { documentation_status: 'verified', documentation_reason: '', manualKnowledge: null, documentation_warnings: [], media_image: rendered };
  }
  // Keep empty-page markers when extracting this source. A readable cover or
  // index must not prevent image-only procedure pages from reaching OCR.
  const extractedPages = [...selected.text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)];
  const reviewedPageNumbers = new Set(selected.reviewed.map(page => page.page));
  const hasNativeText = extractedPages.some(page => page[2].trim()) || selected.reviewed.length > 0;
  const emptyTextPages = new Set(extractedPages.filter(page => !page[2].trim() && !reviewedPageNumbers.has(Number(page[1]))).map(page => Number(page[1])));
  let ocrStatus = '';
  let ocrPages: { page: number; text: string; confidence: number }[] = [];
  if (emptyTextPages.size && image?.page === undefined) {
    try {
      const { enqueueManualOcr, readManualOcr } = await import('@/lib/server/manual-ocr-queue');
      const recognized = await readManualOcr(admin, { hotelId: HOTEL_ID, assetId: asset.id, sha256: selected.sha256 });
      ocrStatus = recognized.status;
      ocrPages = recognized.pages.filter(page => emptyTextPages.has(page.page));
      if (!image && (ocrStatus === 'missing' || ocrStatus === 'cancelled')) {
        await enqueueManualOcr(admin, { hotelId: HOTEL_ID, assetId: asset.id, path: selected.file.storage_path, sha256: selected.sha256, bytes: selected.bytes });
        ocrStatus = 'pending';
      }
    } catch { failures.push({ status: 'uploaded_ocr_unavailable', message: 'Text recognition is unavailable. Open the attached source PDF.' }); }
  }
  const nativeDocument = structureManualDocument(selected.text).filter(page => !reviewedPageNumbers.has(page.page));
  const actions = uploadedManualHtmlActions(nativeDocument);
  const reviewedActions = uploadedManualHtmlActions(selected.reviewed.map(page => structureManualPage(page.text, page.page, 'reviewed')));
  actions.symptom_rules.push(...reviewedActions.symptom_rules.map(rule => ({ ...rule, steps: rule.steps.map(step => `Human-reviewed text: ${step}`) })));
  actions.error_codes.push(...reviewedActions.error_codes.map(code => ({ ...code, action: `Human-reviewed text: ${code.action}` })));
  if (ocrStatus === 'complete') {
    const { ocrManualActions } = await import('@/lib/server/manual-ocr-actions');
    actions.symptom_rules.push(...ocrManualActions(ocrPages));
  }
  try {
    const tableRules = await cachedDerivative(`tables:v7:${selected.sha256}`, () => extractPdfTroubleshootingTables(selected.bytes));
    // Do not reintroduce the uncorrected PDF instruction on a reviewed page.
    actions.symptom_rules.push(...tableRules.filter(rule => !rule.source_pages?.some(page => reviewedPageNumbers.has(page))));
  } catch {
    failures.push({ status: 'uploaded_table_unavailable', message: 'Some source tables could not be read. Open the source PDF to review them.' });
  }
  let media: InspectedUploadedGuideMedia[] = [];
  try {
    const steps = [
      ...actions.symptom_rules.flatMap(rule => rule.steps.map(stepLabel => ({ stepLabel, sourcePages: rule.source_pages || [] }))),
      ...actions.error_codes.map(code => ({ stepLabel: code.action, sourcePages: code.source_pages || [] })),
    ];
    const instructionHash = manualPdfSha256(new TextEncoder().encode(JSON.stringify(steps)));
    media = await cachedDerivative(`media:v2:${selected.sha256}:${instructionHash}`, () => inspectUploadedGuideMedia(selected.bytes, { sha256: selected.sha256, steps }));
  } catch {
    if (image) return unavailable('uploaded_image_unavailable', 'The source illustration could not be read safely. Open the approved source PDF instead.');
    failures.push({ status: 'uploaded_image_unavailable', message: 'Some source illustrations could not be read safely. The instructions remain verbatim; open the approved source PDF to view its figures.' });
  }
  let rendered: Uint8Array | undefined;
  if (image) {
    const selectedMedia = media.find(item => item.descriptor.id === image.id);
    if (!selectedMedia) return unavailable('uploaded_image_unavailable', 'This image is not associated with a current instruction in the approved source PDF. Reload the guide.');
    try { rendered = await cachedDerivative(`image:v1:${selected.sha256}:${image.id}`, () => renderUploadedGuideMedia(selected.bytes, selectedMedia!)); }
    catch { return unavailable('uploaded_image_unavailable', 'The source illustration could not be rendered safely. Open the approved source PDF instead.'); }
  }
  const changed = await recheckSource();
  if (changed) return changed;
  if (rendered) return { documentation_status: 'verified', documentation_reason: '', manualKnowledge: null, documentation_warnings: [], media_image: rendered };
  const signed = await admin.storage.from(bucket).createSignedUrl(selected.file.storage_path, 3600);
  if (signed.error || !signed.data?.signedUrl) throw new Error('The attached source PDF could not be opened for comparison.');
  const sourceUrl = signed.data.signedUrl;
  const actionPages = new Set([...actions.symptom_rules, ...actions.error_codes].flatMap(entry => entry.source_pages || []));
  const passages = manualSourcePassages(selected.text);
  for (const page of manualPartsPassages(selected.text)) if (!passages.some(existing => existing.page === page.page)) passages.push(page);
  for (const match of selected.text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)) {
    const page = Number(match[1]);
    if (match[2].trim() && actionPages.has(page) && !passages.some(passage => passage.page === page)) passages.push({ page, text: match[2].trim(), kind: 'troubleshooting' });
  }
  for (const page of manualReferencePages(selected.text)) if (!passages.some(existing => existing.page === page.page)) passages.push(page);
  if (ocrStatus === 'complete') for (const page of ocrPages) if (page.text.trim() && !passages.some(existing => existing.page === page.page)) passages.push({ page: page.page, text: page.text, kind: 'reference', origin: 'ocr' });
  for (const page of selected.reviewed) {
    const previous = passages.findIndex(passage => passage.page === page.page);
    const passage: SourcePassage = { page: page.page, text: page.text, kind: actionPages.has(page.page) ? 'troubleshooting' : 'reference', origin: 'reviewed' };
    if (previous < 0) passages.push(passage); else passages[previous] = passage;
  }
  const source_passages: SourcePassage[] = passages.map(passage => ({
    ...passage, origin: passage.origin || 'pdf',
    html: sourcePageHtml(passage.text, passage.page, passage.origin || 'pdf'),
    source_file_name: selected.file.name, source_url: sourceUrl,
  }));
  const indexedOcrPages = new Set(ocrPages.filter(page => page.text.trim()).map(page => page.page));
  const searchIncomplete = hasNativeText && [...emptyTextPages].some(page => !indexedOcrPages.has(page));
  const manualKnowledge: ManualKnowledge = {
    step_media: media.map(item => item.descriptor),
    manufacturer: asset.manufacturer || '', model_family: asset.model_family || '', model_number: asset.model_number || '',
    source: {
      search_incomplete: searchIncomplete,
      type: selected.reviewed.length ? 'Uploaded PDF with human-reviewed text' : 'Verbatim uploaded PDF excerpts', title: selected.file.name, source_file_name: selected.file.name, verified: true,
      manufacturer: asset.manufacturer || '', model_family: asset.model_family || '', file_url: sourceUrl,
      source_kind: 'asset-upload', storage_path: selected.file.storage_path, sha256: selected.sha256,
      registered_file_id: selected.file.id, registered_updated_at: selected.file.updated_at,
    },
    source_passages,
    symptom_rules: actions.symptom_rules.map(rule => ({ ...rule, source_url: sourceUrl })),
    error_codes: actions.error_codes.map(code => ({ ...code, source_url: sourceUrl })),
    general_checks: [], manual_tests: [],
  };
  const available = source_passages.some(passage => passage.kind !== 'reference') || actions.symptom_rules.length > 0 || actions.error_codes.length > 0;
  const indexedOcr = ocrStatus === 'complete' && ocrPages.some(page => page.text.trim());
  const needsOcr = !hasNativeText && !indexedOcr;
  const processingOcr = needsOcr && ['pending', 'processing'].includes(ocrStatus);
  const failedOcr = needsOcr && ocrStatus === 'failed';
  return { documentation_status: processingOcr ? 'uploaded_document_ocr_processing' : failedOcr ? 'uploaded_document_ocr_failed' : needsOcr ? 'uploaded_document_needs_ocr' : available ? 'verified' : 'no_guidance', documentation_reason: processingOcr
    ? `Text recognition is processing ${selected.file.name}. The source remains available.`
    : failedOcr ? `Text recognition could not finish ${selected.file.name}. Open the source or retry processing the stored file.`
    : needsOcr ? `${selected.file.name} contains no readable text. Open the source; text recognition is needed to search it.`
    : searchIncomplete ? `Some pages of ${selected.file.name} have no readable text. ${['pending', 'processing'].includes(ocrStatus) ? 'Text recognition is processing those pages.' : ocrStatus === 'failed' ? 'Text recognition could not finish those pages.' : ocrStatus === 'complete' ? 'Text recognition did not recover searchable text from every page.' : 'Text recognition is unavailable for those pages.'} Search results may be incomplete; open the source PDF to review them.`
    : available ? `Troubleshooting information comes only from the attached ${selected.file.name}. Compare the cited source pages before acting.`
    : `${selected.file.name} matches the equipment, but no extractable troubleshooting section or explicit actions were found. Open the attached PDF.`, manualKnowledge, documentation_warnings: failures.map(failure => failure.message) };
}

/** Strict, source-restricted branch used by work orders, before catalog staging. */
export async function readUploadedAssetMaintenanceReference(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: 'Sign in is required.' }, { status: 401, headers });
  if (auth.principal.hotelId !== HOTEL_ID || !['view_work_orders', 'view_dashboard', 'view_pm'].every(capability => allows(auth.principal, capability as 'view_work_orders' | 'view_dashboard' | 'view_pm'))) return NextResponse.json({ error: 'Authorized work-order and PM reference access is required.' }, { status: 403, headers });
  const assetId = request.nextUrl.searchParams.get('assetId')?.trim() || '';
  if (!isUuid(assetId)) return NextResponse.json({ error: 'A valid saved asset is required.' }, { status: 400, headers });
  const imageId = request.nextUrl.searchParams.get('imageId');
  const pageValue = request.nextUrl.searchParams.get('pageImage');
  const pageNumber = pageValue === null ? null : Number(pageValue);
  const sourceSha256 = request.nextUrl.searchParams.get('sha256') || '';
  if (pageValue !== null && (imageId !== null || !/^\d{1,3}$/.test(pageValue) || !pageNumber || pageNumber > 600 || !/^[a-f0-9]{64}$/.test(sourceSha256))) return NextResponse.json({ error: 'A valid source page and PDF fingerprint are required.' }, { status: 400, headers });
  if (imageId !== null && (!/^media-[a-f0-9]{64}$/.test(imageId) || !/^[a-f0-9]{64}$/.test(sourceSha256))) return NextResponse.json({ error: 'A current source image identifier and PDF fingerprint are required.' }, { status: 400, headers });
  const assetResult = await auth.admin.from('assets').select('id,hotel_id,active,manufacturer,model_family,model_number,documentation_key,documentation_revision_id,documentation_verified_at,pdf_import_links')
    .eq('hotel_id', HOTEL_ID).eq('id', assetId).maybeSingle();
  if (assetResult.error) return NextResponse.json({ error: 'The saved asset could not be read.' }, { status: 503, headers });
  if (!assetResult.data || assetResult.data.active === false) return NextResponse.json({ error: 'This asset is not available at this property.' }, { status: 404, headers });
  try {
    const result = await loadUploadedAssetGuide(auth.admin, assetResult.data as Asset, imageId ? { id: imageId, sha256: sourceSha256 } : pageNumber ? { id: '', sha256: sourceSha256, page: pageNumber } : undefined);
    if (imageId || pageNumber) {
      if (result.media_image) return new Response(result.media_image.slice().buffer as ArrayBuffer, { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' } });
      return NextResponse.json({ error: result.documentation_reason, documentation_status: result.documentation_status }, { status: result.documentation_status === 'uploaded_document_changed' ? 409 : 404, headers });
    }
    return NextResponse.json({ ...result, assets: [assetResult.data], technicians: [], asset_id: assetId, documentation_key: assetResult.data.documentation_key || null, can_edit_equipment: allows(auth.principal, 'manage_assets') }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The attached source document could not be read.' }, { status: 503, headers });
  }
}

