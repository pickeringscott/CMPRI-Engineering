import { footballBettingLine } from '@/lib/server/football-betting-line';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: Request) {
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  try {
    // The caller cannot change the teams, date, provider, event or upstream URL.
    return Response.json(await footballBettingLine(request.signal), { headers: HEADERS });
  } catch {
    return Response.json({ error: 'Request canceled.' }, { status: 499, headers: HEADERS });
  }
}
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
