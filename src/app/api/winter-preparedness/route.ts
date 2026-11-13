import type { NextRequest } from 'next/server';
import { requireUserAttempt } from '@/lib/server/auth';
import { readWinter, saveWinter, WinterStoreError } from '@/lib/server/winter-preparedness-store';
import { manualPreviewReadOnly } from '@/lib/server/manual-preview';

function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
}
async function handle(request: NextRequest, save: boolean) {
  if (save && manualPreviewReadOnly()) return response({error:'This preview is read-only. No checklist progress was changed.'},403);
  try {
    const auth = await requireUserAttempt(request);
    if (!auth.ok) return response({ error: 'Unauthorized' }, 401);
    if (!save) return response({ items: await readWinter(auth.admin, auth.principal, auth.mcp), preview_read_only: manualPreviewReadOnly() });
    const text = await request.text();
    if (text.length > 2048) return response({ error: 'Checklist request is too large.' }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return response({ error: 'Invalid JSON.' }, 400); }
    return response({ item: await saveWinter(auth.admin, auth.principal, body, auth.mcp) });
  } catch (error) {
    return response({ error: error instanceof WinterStoreError ? error.message : 'Checklist storage is unavailable.' }, error instanceof WinterStoreError ? error.status : 503);
  }
}
export const GET = (request: NextRequest) => handle(request, false);
export const PATCH = (request: NextRequest) => handle(request, true);
