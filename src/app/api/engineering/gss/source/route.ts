import { NextRequest, NextResponse } from 'next/server';
import { canOpenGss } from '@/lib/dashboard/menu-access';
import { requireUser } from '@/lib/server/auth';
import { fetchLatestGssSource } from '@/lib/integrations/email-provider';

export async function GET(request: NextRequest) {
  const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  const auth = await requireUser(request);
  if (!auth) return reply({ error: 'Sign in is required.' }, 401);
  if (!canOpenGss(auth.principal.profile)) return reply({ error: 'GSS Reports access is required.' }, 403);
  try {
    return reply(await fetchLatestGssSource());
  } catch {
    // Do not expose mailbox response bodies, URLs or credentials.
    return reply({ error: 'The latest GSS source report is unavailable.' }, 503);
  }
}
