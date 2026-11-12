import { SUPABASE_URL } from './supabase/config';
import { authorizationHeaders } from './auth/client-session';
/** Read private result chunks without sending application credentials to storage. */
export async function readImportResponse(response: Response) {
  const body = await response.json();
  if (!response.ok || !body.importResult) return body;
  const result = body.importResult;
  if (typeof result.id !== 'string' || !Array.isArray(result.urls) || result.urls.length < 1 || result.urls.length > 64 || result.count !== result.urls.length || !Array.isArray(result.hashes) || result.hashes.length !== result.count) throw Error('Invalid private review response.');
  try {
    const parts: Uint8Array[] = [];
    for (let index = 0; index < result.urls.length; index++) {
      const url = result.urls[index];
      const parsed = new URL(url);
      if (parsed.origin !== new URL(SUPABASE_URL).origin || !parsed.pathname.includes('/storage/v1/object/sign/import-upload-staging/')) throw Error('Invalid private review location.');
      const download = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
      if (!download.ok) throw Error('The private review expired. Review the file again.');
      const encoded = await download.json();
      if (typeof encoded !== 'string' || encoded.length > 24 * 1024 * 1024) throw Error('Invalid private review chunk.');
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== result.hashes[index]) throw Error('The private review is incomplete or changed.');
      parts.push(bytes);
    }
    return JSON.parse(await new Blob(parts.map(part => part.buffer as ArrayBuffer)).text());
  } finally {
    try { await fetch('/api/import-uploads', { method: 'DELETE', headers: { ...await authorizationHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: result.id, count: result.count }), cache: 'no-store' }); } catch { /* Best-effort cleanup; next upload also prunes expired results. */ }
  }
}
