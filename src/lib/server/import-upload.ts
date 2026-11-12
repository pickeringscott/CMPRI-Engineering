import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '../uuid';
import type { ImportUploadDescriptor, ImportUploadKind } from '../import-upload';
const LIMIT = 100 * 1024 * 1024;
export const IMPORT_UPLOAD_BUCKET = 'import-upload-staging';
const types = { 'asset-documentation': { extension: '.pdf', type: 'application/pdf' }, 'po-pdf': { extension: '.pdf', type: 'application/pdf' }, 'guest-report': { extension: '.csv', type: 'text/csv' }, 'purchasing-history': { extension: '.json', type: 'application/json' } };
export function importDescriptor(input: unknown, expected?: ImportUploadKind): ImportUploadDescriptor {
  const d = input as ImportUploadDescriptor;
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.hasOwn(types, d.kind) || (expected && expected !== d.kind) || !isUuid(d.id)
    || typeof d.name !== 'string' || d.name.length > 255 || /[\x00-\x1f\\/]/.test(d.name) || !d.name.toLowerCase().endsWith(types[d.kind].extension)
    || !Number.isSafeInteger(d.size) || d.size < 1 || d.size > LIMIT || typeof d.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.sha256)) throw Error('Choose a valid nonempty file up to 100 MB.');
  return { kind: d.kind, id: d.id, name: d.name, size: d.size, sha256: d.sha256 };
}
function path(hotel: string, actor: string, d: ImportUploadDescriptor) { return `${hotel}/${actor}/${d.kind}/${d.id}-${d.sha256}${types[d.kind].extension}`; }
/** Bounded actor-only garbage collection on later uploads; never touches originals. */
async function cleanExpiredUploads(admin: SupabaseClient, hotel: string, actor: string, kind: string) {
  const storage=admin.storage.from(IMPORT_UPLOAD_BUCKET);
  for(const folder of [kind,'results']) {
    const prefix=`${hotel}/${actor}/${folder}`;
    const listed=await storage.list(prefix,{limit:100,sortBy:{column:'created_at',order:'asc'}});
    if(listed.error)continue;
    const old=(listed.data||[]).filter(file=>file.id && file.created_at && Date.parse(file.created_at)<Date.now()-24*60*60*1000 && /^[a-zA-Z0-9.-]+$/.test(file.name)).map(file=>`${prefix}/${file.name}`);
    if(old.length)await storage.remove(old);
  }
}
export async function prepareImportUpload(admin: SupabaseClient, hotel: string, actor: string, input: unknown) {
  const d = importDescriptor(input);
  await cleanExpiredUploads(admin, hotel, actor, d.kind);
  const { data: bucket, error } = await admin.storage.getBucket(IMPORT_UPLOAD_BUCKET);
  if (error || !bucket || bucket.public || Number(bucket.file_size_limit) !== LIMIT) throw Error('Private import storage is not ready.');
  const signed = await admin.storage.from(IMPORT_UPLOAD_BUCKET).createSignedUploadUrl(path(hotel, actor, d), { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw Error('The upload could not be prepared.');
  return { signedUrl: signed.data.signedUrl, contentType: types[d.kind].type };
}
export async function readImportUpload(admin: SupabaseClient, hotel: string, actor: string, input: unknown, kind: ImportUploadKind) {
  const d = importDescriptor(input, kind), storage = admin.storage.from(IMPORT_UPLOAD_BUCKET), key = path(hotel, actor, d);
  const info = await storage.info(key);
  if (info.data?.createdAt && Date.parse(info.data.createdAt)<Date.now()-24*60*60*1000) { await storage.remove([key]); throw Error('This upload expired. Select the original file again.'); }
  if (info.error || info.data?.size !== d.size || info.data?.contentType !== types[d.kind].type) throw Error('The uploaded file size or type could not be verified.');
  const file = await storage.download(key);
  if (file.error || !file.data || file.data.size !== d.size) throw Error('The upload is incomplete.');
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (bytes.length !== d.size || createHash('sha256').update(bytes).digest('hex') !== d.sha256) throw Error('The uploaded file differs from the selected original.');
  return { descriptor: d, bytes };
}
