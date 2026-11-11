import type { SupabaseClient } from '@supabase/supabase-js';
import { HOTEL_ID } from '@/lib/constants';
import type { StoredPdf } from '@/lib/stored-pdf-link';

/** Catalog ingestion is not proof of an asset association or usable guidance. */
export async function withStoredPdfStatus<T extends { storage_path: string }>(admin: SupabaseClient, files: T[]): Promise<Array<T & Pick<StoredPdf, "catalog_status" | "catalog_warnings">>> {
  const paths = [...new Set(files.map(file => file.storage_path))];
  const rows: Array<{ storage_path: string; title: string; ingestion_status: string; ingestion_error: string | null }> = [];
  for (let offset = 0; offset < paths.length; offset += 100) {
    const result = await admin.from('maintenance_documents')
      .select('storage_path,title,ingestion_status,ingestion_error')
      .eq('hotel_id', HOTEL_ID).in('storage_path', paths.slice(offset, offset + 100));
    if (result.error) throw new Error('Document processing and quarantine status could not be checked. Reload before linking a PDF.');
    rows.push(...(result.data || []));
  }
  return files.map(file => {
    const catalog = rows.filter(row => row.storage_path === file.storage_path);
    const quarantined = catalog.some(row => row.ingestion_status === 'content_mismatch');
    return { ...file, catalog_status: quarantined ? 'content_mismatch'
      : !catalog.length ? 'not_cataloged'
      : catalog.every(row => row.ingestion_status === 'complete') ? 'complete' : 'pending',
      catalog_warnings: catalog.filter(row => row.ingestion_error).map(row => `${row.title}: ${row.ingestion_error}`) };
  });
}
