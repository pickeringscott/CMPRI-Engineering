import type { NextRequest } from 'next/server';
import { requireUserAttempt } from '@/lib/server/auth';
import { HoursStoreError, readHours, saveHours } from '@/lib/server/hours-tracker-store';

function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
async function handle(request: NextRequest, save: boolean) {
  try {
    const auth = await requireUserAttempt(request);
    if (!auth.ok) return response({ error: 'Unauthorized' }, 401);
    if (!save) return response({ saved: await readHours(auth.admin, auth.principal, auth.mcp) });
    const text = await request.text();
    if (text.length > 32000) return response({ error: 'Hours request is too large.' }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return response({ error: 'Invalid JSON.' }, 400); }
    return response({ saved: await saveHours(auth.admin, auth.principal, body, auth.mcp) });
  } catch (error) {
    return response({ error: error instanceof HoursStoreError ? error.message : 'Hours storage is unavailable.' }, error instanceof HoursStoreError ? error.status : 503);
  }
}
export const GET = (request: NextRequest) => handle(request, false);
export const PUT = (request: NextRequest) => handle(request, true);
