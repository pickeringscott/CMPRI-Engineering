import { authorizationHeaders } from './auth/client-session';
export const IMPORT_UPLOAD_BYTES = 100 * 1024 * 1024;
export type ImportUploadKind = 'po-pdf' | 'guest-report' | 'purchasing-history' | 'asset-documentation';
export type ImportUploadDescriptor = { kind: ImportUploadKind; id: string; name: string; size: number; sha256: string };
export async function uploadImportFile(file: File, kind: ImportUploadKind): Promise<ImportUploadDescriptor> {
  if (file.size < 1 || file.size > IMPORT_UPLOAD_BYTES) throw Error('Choose a nonempty file up to 100 MB.');
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
  const descriptor = { kind, id: crypto.randomUUID(), name: file.name, size: file.size, sha256 };
  const response = await fetch('/api/import-uploads', { method: 'POST', headers: { ...await authorizationHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(descriptor), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok || !result.signedUrl) throw Error(result.error || 'The upload could not be prepared.');
  const uploaded = await fetch(result.signedUrl, { method: 'PUT', body: file, headers: { 'Content-Type': result.contentType, 'x-upsert': 'false' }, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
  if (!uploaded.ok) throw Error('The file upload did not complete. Retry the upload.');
  return descriptor;
}
