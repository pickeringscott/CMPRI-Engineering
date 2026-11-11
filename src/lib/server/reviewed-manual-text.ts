import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HOTEL_ID } from '@/lib/constants';
import { isUuid } from '@/lib/uuid';
import { listRegisteredAssetFiles, type RegisteredAssetFile } from '@/lib/server/asset-file-register';
import { manualOcrPageCount } from '@/lib/server/manual-ocr';

const cacheType = 'asset_manual_knowledge';
const assetFields = 'id,hotel_id,active,manufacturer,model_family,model_number,documentation_key,documentation_revision_id,documentation_verified_at,pdf_import_links';
type Source = { hotelId: string; assetId: string; sha256: string; file: RegisteredAssetFile; totalPages?: number };
type Page = { page: number; text: string };
type Submission = { assetId: string; sha256: string; totalPages: number; pages: Page[]; reviewConfirmed: true };
export class ReviewedManualError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const fail = (message: string, status = 409): never => { throw new ReviewedManualError(message, status); };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)])) : item;
  return JSON.stringify(sort(value));
}
const fileIdentity = (file: RegisteredAssetFile) => ({ id: file.id, storage_path: file.storage_path, updated_at: file.updated_at, created_at: file.created_at, name: file.name, preferred: file.preferred });
const prefix = (source: Source) => `reviewed-upload-${source.assetId}-${source.sha256}-${sha(canonical(fileIdentity(source.file)))}-`;
function choose(files: RegisteredAssetFile[]): RegisteredAssetFile {
  const documents = files.filter(file => file.name !== '_cmpri-verification.json' && file.storage_path);
  const preferred = documents.filter(file => file.preferred);
  if (preferred.length > 1) return fail('More than one preferred attachment exists. Select one preferred PDF before saving reviewed text.');
  if (preferred.length && !/\.pdf$/i.test(preferred[0].name)) return fail('The preferred attachment is not a PDF. Select the intended preferred PDF.');
  const pdfs = documents.filter(file => /\.pdf$/i.test(file.name));
  if (!pdfs.length) return fail('The original PDF is not attached to this saved equipment. Attach the original PDF first.');
  if (!preferred.length && (pdfs.length !== 1 || documents.length !== 1)) return fail('Multiple or unsupported attachments exist. Select one preferred PDF before saving reviewed text.');
  return preferred[0] || pdfs[0];
}
async function readAsset(admin: SupabaseClient, assetId: string) {
  const result = await admin.from('assets').select(assetFields).eq('hotel_id', HOTEL_ID).eq('id', assetId).maybeSingle();
  if (result.error) return fail('The saved equipment could not be checked. Retry saving reviewed text.', 503);
  if (!result.data || result.data.hotel_id !== HOTEL_ID || result.data.active === false) return fail('The saved equipment is unavailable at this property.', 404);
  return result.data;
}
async function registered(admin: SupabaseClient, assetId: string) {
  const result = await listRegisteredAssetFiles(admin, assetId);
  if (result.error) return fail('The attachment register could not be checked. Retry saving reviewed text.', 503);
  return result.data;
}
async function sourceBytes(admin: SupabaseClient, file: RegisteredAssetFile) {
  const path = file.storage_path;
  if (!file.id || path.startsWith('/') || path.includes('://') || path.split('/').some(part => part === '..') || !(path.startsWith(`${HOTEL_ID}/`) || /^asset docs\//i.test(path))) return fail('The original PDF has an unauthorized attachment path. Restore its registered attachment.');
  const stored = await admin.storage.from('asset-documentation').download(path);
  if (stored.error || !stored.data) return fail('The attached original PDF could not be downloaded. Restore the original attachment and retry.', 503);
  if (stored.data.size > 50 * 1024 * 1024) return fail('The original PDF exceeds the supported 50 MB size.', 400);
  const bytes = new Uint8Array(await stored.data.arrayBuffer());
  if (bytes.length > 50 * 1024 * 1024 || bytes.length < 5 || ![37, 80, 68, 70, 45].every((v, i) => bytes[i] === v)) return fail('The original attachment is not a supported PDF.', 400);
  return bytes;
}
export function validateReviewedManualSubmission(input: unknown): Submission {
  const value = input as Submission | null;
  if (!value || typeof value !== 'object' || !isUuid(value.assetId) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return fail('A saved asset ID and original PDF SHA-256 fingerprint are required.', 400);
  if (value.reviewConfirmed !== true) return fail('Confirm that you compared every submitted page with the original PDF.', 400);
  if (!Number.isSafeInteger(value.totalPages) || value.totalPages < 1 || value.totalPages > 600) return fail('The original PDF must have 1–600 pages.', 400);
  if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 10 || new Set(value.pages.map(page => page?.page)).size !== value.pages.length
    || value.pages.some(page => !page || !Number.isSafeInteger(page.page) || page.page < 1 || page.page > value.totalPages || typeof page.text !== 'string' || !page.text.trim() || page.text.length > 50000)) return fail('Submit up to ten distinct source pages with nonempty text of at most 50,000 characters per page.', 400);
  return { assetId: value.assetId, sha256: value.sha256, totalPages: value.totalPages, reviewConfirmed: true, pages: value.pages.map(({ page, text }) => ({ page, text })) };
}

/** Only dedicated reviewed-page records qualify. Generic uploaded/manual caches never do.
 * Caller must derive sha256 from current source bytes; current association is also checked here.
 * Text remains plain text, including any HTML-looking characters; render only through escaping.
 */
export async function readReviewedManualPages(admin: SupabaseClient, source: Source): Promise<Array<Page & { totalPages: number }>> {
  if (source.hotelId !== HOTEL_ID || !isUuid(source.assetId) || !/^[a-f0-9]{64}$/.test(source.sha256)) return [];
  const assetSnapshot = canonical(await readAsset(admin, source.assetId));
  const files = await registered(admin, source.assetId);
  if (!files.some(file => canonical(fileIdentity(file)) === canonical(fileIdentity(source.file)))) return [];
  let selected: RegisteredAssetFile;
  try { selected = choose(files); } catch (error) { if (error instanceof ReviewedManualError) return []; throw error; }
  if (canonical(fileIdentity(selected)) !== canonical(fileIdentity(source.file))) return [];
  const keyPrefix = prefix(source);
  const result = await admin.from('troubleshooting_cache').select('cache_key,payload').eq('hotel_id', source.hotelId).eq('cache_type', cacheType).like('cache_key', `${keyPrefix}%`).limit(600);
  if (result.error) return fail('Saved reviewed pages could not be read. Retry loading the guide.', 503);
  const pages = new Map<number, Page & { totalPages: number }>();
  for (const row of result.data || []) {
    const p = row.payload;
    if (!p || p.version !== 1 || p.kind !== 'reviewed-upload-page' || p.hotel_id !== source.hotelId || p.asset_id !== source.assetId || p.sha256 !== source.sha256 || canonical(p.file) !== canonical(fileIdentity(source.file))
      || !Number.isSafeInteger(p.totalPages) || p.totalPages < 1 || p.totalPages > 600 || (source.totalPages !== undefined && p.totalPages !== source.totalPages)
      || !Number.isSafeInteger(p.page) || p.page < 1 || p.page > p.totalPages || row.cache_key !== `${keyPrefix}${p.page}` || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 50000
      || !isUuid(p.reviewed_by) || typeof p.reviewed_at !== 'string' || !Number.isFinite(Date.parse(p.reviewed_at))) continue;
    pages.set(p.page, { page: p.page, text: p.text, totalPages: p.totalPages });
  }
  const after = await registered(admin, source.assetId);
  if (canonical(await readAsset(admin, source.assetId)) !== assetSnapshot) return [];
  if (canonical(after) !== canonical(files)) return [];
  // Inconsistent totals are corrupt, not an invitation to guess the source length.
  if (new Set([...pages.values()].map(page => page.totalPages)).size > 1) return [];
  return [...pages.values()].sort((a, b) => a.page - b.page);
}

export async function saveReviewedManualPages(admin: SupabaseClient, actorId: string, input: unknown) {
  const value = validateReviewedManualSubmission(input);
  if (!isUuid(actorId)) return fail('A signed-in reviewer is required.', 403);
  const asset = await readAsset(admin, value.assetId);
  const files = await registered(admin, value.assetId);
  const file = choose(files);
  const bytes = await sourceBytes(admin, file);
  if (sha(bytes) !== value.sha256) return fail('The converter original does not match the currently attached PDF. Open that original in the converter, review it, and retry.');
  let actualPages: number;
  try { actualPages = await manualOcrPageCount(bytes); } catch { return fail('The original PDF page count could not be verified. Restore a readable PDF and retry.', 400); }
  if (actualPages !== value.totalPages) return fail('The converter page count does not match the attached original PDF. Reopen the original and retry.');
  const source: Source = { hotelId: HOTEL_ID, assetId: value.assetId, sha256: value.sha256, file, totalPages: actualPages };
  const recheck = async () => {
    if (canonical(await readAsset(admin, value.assetId)) !== canonical(asset) || canonical(await registered(admin, value.assetId)) !== canonical(files)) return fail('The equipment or original PDF attachment changed while saving. Reload and review the current original.');
    if (sha(await sourceBytes(admin, file)) !== value.sha256) return fail('The original PDF bytes changed while saving. Reload and review the current original.');
  };
  await recheck();
  const reviewedAt = new Date().toISOString();
  const result = await admin.from('troubleshooting_cache').upsert(value.pages.map(page => ({
    hotel_id: HOTEL_ID, cache_type: cacheType, cache_key: `${prefix(source)}${page.page}`, expires_at: null,
    payload: { version: 1, kind: 'reviewed-upload-page', hotel_id: HOTEL_ID, asset_id: value.assetId, sha256: value.sha256, file: fileIdentity(file), totalPages: actualPages, ...page, reviewed_by: actorId, reviewed_at: reviewedAt },
  })), { onConflict: 'hotel_id,cache_type,cache_key' });
  if (result.error) return fail('Reviewed text could not be saved. The original PDF is unchanged; retry this batch.', 503);
  await recheck();
  const saved = await readReviewedManualPages(admin, source);
  if (value.pages.some(page => !saved.some(found => found.page === page.page && found.text === page.text && found.totalPages === actualPages))) return fail('Reviewed text save could not be verified. Reload and retry this batch.', 503);
  await recheck();
  return { saved: true, pages: value.pages.map(page => page.page), message: 'Reviewed pages saved and verified against the attached original. The original PDF is unchanged.' };
}
