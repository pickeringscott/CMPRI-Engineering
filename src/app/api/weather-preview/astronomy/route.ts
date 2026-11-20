import { ASTRONOMY_LOCATION, ASTRONOMY_SOURCE, readWeatherAstronomy } from '@/lib/server/weather-astronomy';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: Request) {
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  // Fixed property, fixed source. No browser URL, coordinates, dates or device
  // location can affect the server's request or observer geometry.
  if (new URL(request.url).search) return Response.json({ error: 'Astronomy uses the fixed hotel location and current time.' }, { status: 400, headers: HEADERS });
  if (request.signal.aborted) return Response.json({ error: 'Request canceled.' }, { status: 499, headers: HEADERS });
  try {
    const data = await readWeatherAstronomy(request.signal);
    return Response.json({ location: ASTRONOMY_LOCATION, checkedAt: new Date().toISOString(), resources: {
      astronomy: { status: 'live', source: ASTRONOMY_SOURCE, sourceTimestamp: data.moonPhase.calculatedAt, data, error: null },
    } }, { headers: HEADERS });
  } catch {
    if (request.signal.aborted) return Response.json({ error: 'Request canceled.' }, { status: 499, headers: HEADERS });
    return Response.json({ location: ASTRONOMY_LOCATION, checkedAt: new Date().toISOString(), resources: {
      astronomy: { status: 'unavailable', source: ASTRONOMY_SOURCE, sourceTimestamp: null, data: null,
        error: 'Local astronomy calculations are unavailable.' },
    } }, { headers: HEADERS });
  }
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
