import type { NextRequest } from 'next/server';
import { requireUserAttempt } from '@/lib/server/auth';
import { hoursClockEnabled } from '@/lib/server/hours-clock-policy';
import { clockHours } from '@/lib/server/hours-clock';
import { HoursStoreError } from '@/lib/server/hours-tracker-store';
const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUserAttempt(request);
    if (!auth.ok) return respond({ error: 'Unauthorized' }, 401);
    if (!hoursClockEnabled(auth.principal)) return respond({ error: 'Personal clock actions are not activated for this account.' }, 403);
    const text = await request.text();
    if (text.length > 1000) return respond({ error: 'Invalid clock request.' }, 400);
    let body;
    try { body = JSON.parse(text); } catch { return respond({ error: 'Invalid clock request.' }, 400); }
    return respond(await clockHours(auth.admin, auth.principal, body));
  } catch (error) { return respond({ error: error instanceof HoursStoreError ? error.message : 'Clock save was not confirmed. Retry the identical request_id.' }, error instanceof HoursStoreError ? error.status : 503); }
}
