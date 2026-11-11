import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { manualOcrPageCount } from './manual-ocr';

/** Queue a content-addressed source once; existing progress is never reset. */
export async function enqueueManualOcr(admin: SupabaseClient, source: { hotelId: string; assetId: string; path: string; sha256: string; bytes: Uint8Array }, retryFailed = false) {
  if (!process.env.CRON_SECRET) throw new Error('OCR scheduling is unavailable.');
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || createHash('sha256').update(source.bytes).digest('hex') !== source.sha256) throw new Error('The source fingerprint is invalid.');
  const totalPages = await manualOcrPageCount(source.bytes);
  const { error } = await admin.from('cmpri_asset_manual_ocr_jobs').upsert({ hotel_id: source.hotelId, asset_id: source.assetId, source_path: source.path, source_sha256: source.sha256, total_pages: totalPages }, { onConflict: 'hotel_id,asset_id,source_sha256', ignoreDuplicates: true });
  if (error) throw new Error('The source was saved but OCR could not be queued.');
  const retryStates = retryFailed ? ['cancelled', 'failed'] : ['cancelled'];
  const retried = await admin.from('cmpri_asset_manual_ocr_jobs').update({ source_path: source.path, status: 'pending', attempts: 0, error: null, updated_at: new Date().toISOString() })
    .eq('hotel_id', source.hotelId).eq('asset_id', source.assetId).eq('source_sha256', source.sha256).in('status', retryStates);
  if (retried.error) throw new Error('The source was saved but OCR could not be queued.');
  return totalPages;
}

type OcrJob = { hotel_id: string; asset_id: string; source_path: string; source_sha256: string; total_pages: number; next_page: number; attempts: number; lease_token: string };

/** Process one leased batch. Revalidate the asset, association and bytes before publishing. */
export async function processManualOcrJob(admin: SupabaseClient, hotelId: string): Promise<'idle' | 'processed' | 'retry' | 'cancelled'> {
  const { data, error } = await admin.rpc('cmpri_claim_asset_manual_ocr_job', { p_hotel: hotelId });
  if (error) throw new Error('OCR jobs are unavailable.');
  const job = Array.isArray(data) ? data[0] as OcrJob | undefined : undefined;
  if (!job) return 'idle';
  const finish = async (values: Record<string, unknown>) => {
    const result = await admin.from('cmpri_asset_manual_ocr_jobs').update({ ...values, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() })
      .eq('hotel_id', job.hotel_id).eq('asset_id', job.asset_id).eq('source_sha256', job.source_sha256).eq('lease_token', job.lease_token).select('asset_id');
    if (result.error || !result.data?.length) throw new Error('The OCR lease changed.');
  };
  try {
    if (job.hotel_id !== hotelId || !job.lease_token || !/^[a-f0-9]{64}$/.test(job.source_sha256) || job.next_page < 1 || job.next_page > job.total_pages || job.total_pages > 600) {
      await finish({ status: 'cancelled', error: 'The queued source is unavailable.' }); return 'cancelled';
    }
    const { listRegisteredAssetFiles } = await import('./asset-file-register');
    const readSource = async () => {
      const asset = await admin.from('assets').select('id,hotel_id,active').eq('hotel_id', job.hotel_id).eq('id', job.asset_id).maybeSingle();
      if (asset.error) throw new Error('Asset unavailable.');
      if (!asset.data || asset.data.active === false) return null;
      const files = await listRegisteredAssetFiles(admin, job.asset_id);
      if (files.error) throw new Error('Source register unavailable.');
      if (!files.data.some(file => file.storage_path === job.source_path && file.id)) return null;
      const download = await admin.storage.from('asset-documentation').download(job.source_path);
      if (download.error || !download.data) throw new Error('Source unavailable.');
      const bytes = new Uint8Array(await download.data.arrayBuffer());
      return createHash('sha256').update(bytes).digest('hex') === job.source_sha256 ? bytes : null;
    };
    const bytes = await readSource();
    if (!bytes) { await finish({ status: 'cancelled', error: 'The source was changed or unlinked.' }); return 'cancelled'; }
    const pages = Array.from({ length: Math.min(5, job.total_pages-job.next_page+1) }, (_, index) => job.next_page+index);
    const { recognizeManualPages } = await import('./manual-ocr');
    const result = await recognizeManualPages(bytes, pages);
    if (result.totalPages !== job.total_pages || !await readSource()) { await finish({ status: 'cancelled', error: 'The source was changed or unlinked.' }); return 'cancelled'; }
    const rows = result.pages.map(page => ({ hotel_id: job.hotel_id, asset_id: job.asset_id, source_sha256: job.source_sha256, page_number: page.page, text: page.text, confidence: page.confidence }));
    if (rows.some(row => row.text.length > 50000 || !Number.isFinite(row.confidence))) throw new Error('OCR output exceeded its supported size.');
    const saved = await admin.from('cmpri_asset_manual_ocr_pages').upsert(rows, { onConflict: 'hotel_id,asset_id,source_sha256,page_number' });
    if (saved.error) throw new Error('OCR pages could not be saved.');
    const next = pages.at(-1)!+1;
    await finish({ status: next > job.total_pages ? 'complete' : 'pending', next_page: next, attempts: 0, error: null });
    return 'processed';
  } catch {
    await finish({ status: job.attempts >= 3 ? 'failed' : 'pending', error: 'OCR could not complete this batch.' });
    return 'retry';
  }
}

export async function readManualOcr(admin: SupabaseClient, source: { hotelId: string; assetId: string; sha256: string }): Promise<{ status: string; pages: { page: number; text: string; confidence: number }[] }> {
  const job = await admin.from('cmpri_asset_manual_ocr_jobs').select('status').eq('hotel_id', source.hotelId).eq('asset_id', source.assetId).eq('source_sha256', source.sha256).maybeSingle();
  if (job.error) throw new Error('OCR status is unavailable.');
  const status = String(job.data?.status || 'missing');
  if (status !== 'complete') return { status, pages: [] };
  const result = await admin.from('cmpri_asset_manual_ocr_pages').select('page_number,text,confidence').eq('hotel_id', source.hotelId).eq('asset_id', source.assetId).eq('source_sha256', source.sha256).order('page_number');
  if (result.error) throw new Error('OCR pages are unavailable.');
  const pages = (result.data || []).flatMap((row: { page_number: unknown; text: unknown; confidence: unknown }) => {
    const page = Number(row.page_number), confidence = Number(row.confidence);
    return Number.isSafeInteger(page) && page > 0 && page <= 600 && typeof row.text === 'string' && row.text.length <= 50000 && Number.isFinite(confidence) && confidence >= 0 && confidence <= 100 ? [{ page, text: row.text, confidence }] : [];
  });
  return { status, pages };
}
