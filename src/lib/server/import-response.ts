import { randomUUID, createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IMPORT_UPLOAD_BUCKET } from './import-upload';
const INLINE_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024 * 1024;
/** Keep function responses below the host limit without dropping review evidence. */
export async function importResponseBody(admin: SupabaseClient, hotel: string, actor: string, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  if (bytes.length <= INLINE_BYTES) return body;
  const count = Math.ceil(bytes.length / CHUNK_BYTES);
  if (count > 64) throw Error('The parsed review exceeds the supported processing budget. Split the evidence into smaller bundles.');
  const id = randomUUID(), storage = admin.storage.from(IMPORT_UPLOAD_BUCKET), paths: string[] = [], urls: string[] = [], hashes: string[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const path = `${hotel}/${actor}/results/${id}-${index}.json`;
      paths.push(path);
      // Each object is a JSON string containing base64 bytes; even binary chunk
      // boundaries never corrupt UTF-8. Objects remain under the bucket limit.
      const content = JSON.stringify(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'));
      const saved = await storage.upload(path, content, { contentType: 'application/json', upsert: false });
      if (saved.error) throw Error('The private review could not be prepared.');
      const signed = await storage.createSignedUrl(path, 900);
      if (signed.error || !signed.data?.signedUrl) throw Error('The private review could not be opened.');
      urls.push(signed.data.signedUrl);
      hashes.push(createHash('sha256').update(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).digest('hex'));
    }
    return { importResult: { id, count, urls, hashes }, ...(body && typeof body === 'object' && 'previousId' in body ? { previousId: body.previousId } : {}) };
  } catch (error) { await storage.remove(paths); throw error; }
}

/** Internal callers need only the concurrency token, not downloadable preview bytes. */
export async function discardImportResponse(admin: SupabaseClient, hotel: string, actor: string, body: { importResult?: { id: string; count: number } }) {
  if (!body.importResult) return;
  const {id,count}=body.importResult;
  if(!/^[0-9a-f-]{36}$/.test(id)||!Number.isSafeInteger(count)||count<1||count>64)return;
  await admin.storage.from(IMPORT_UPLOAD_BUCKET).remove(Array.from({length:count},(_,index)=>`${hotel}/${actor}/results/${id}-${index}.json`));
}
