import { NextResponse, type NextRequest } from 'next/server';
import { HOTEL_ID } from '@/lib/constants';
import { requireUser } from '@/lib/server/auth';
import { allows } from '@/lib/server/access';
import { canEditEquipment } from '@/lib/server/roles';
import { ReviewedManualError, saveReviewedManualPages } from '@/lib/server/reviewed-manual-text';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization' };
const maxBodyBytes = 2 * 1024 * 1024;
async function boundedJson(request: NextRequest): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ReviewedManualError('Send reviewed pages as application/json.', 415);
  const length = Number(request.headers.get('content-length'));
  if (length > maxBodyBytes) throw new ReviewedManualError('The reviewed page batch exceeds 2 MB. Send fewer pages.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ReviewedManualError('A reviewed page batch is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) { await reader.cancel(); throw new ReviewedManualError('The reviewed page batch exceeds 2 MB. Send fewer pages.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ReviewedManualError('The reviewed page batch is not valid JSON.'); }
}
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: 'Sign in is required.' }, { status: 401, headers });
  if (auth.principal.hotelId !== HOTEL_ID || !allows(auth.principal, 'manage_assets') || !canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: 'Equipment editing permission at this property is required.' }, { status: 403, headers });
  try {
    return NextResponse.json(await saveReviewedManualPages(auth.admin, auth.principal.identity.id, await boundedJson(request)), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ReviewedManualError ? error.message : 'Reviewed text could not be saved or checked. The original PDF is unchanged; retry this batch.' }, { status: error instanceof ReviewedManualError ? error.status : 503, headers });
  }
}
