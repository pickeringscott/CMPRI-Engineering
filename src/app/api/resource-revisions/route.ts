import type { NextRequest } from 'next/server';
import { requireUserAttempt } from '@/lib/server/auth';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization' };
/** Content-free version check on page entry/reconnect, never a polling endpoint. */
export async function GET(request: NextRequest) {
  const attempt = await requireUserAttempt(request);
  if (!attempt.ok) return Response.json({ error: 'Sign in again to continue.' }, { status: 401, headers });
  const principal = attempt.principal;
  const { data, error } = await attempt.admin.from('cmpri_resource_signals').select('topic,revision')
    .eq('hotel_id', principal.hotelId).eq('recipient_user_id', principal.profile.id);
  if (error) return Response.json({ error: 'Resource versions could not be checked.' }, { status: 503, headers });
  return Response.json({ userId: principal.profile.id, hotelId: principal.hotelId,
    versions: Object.fromEntries((data || []).map((row: { topic: string; revision: number }) => [row.topic, Number(row.revision)])),
  }, { headers });
}
