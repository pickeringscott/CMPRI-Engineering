import { parseWillardBoard } from '@/lib/server/willard-flight-board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const SOURCES = {
  arrivals: 'https://www.avionio.com/widget/en/cmi/arrivals?style=3',
  departures: 'https://www.avionio.com/widget/en/cmi/departures?style=3',
} as const;
type Kind = keyof typeof SOURCES;
type Board = {
  status: 'live' | 'unavailable'; sourceUrl: string; retrievedAt: string | null;
  providerDate: string | null; flights: ReturnType<typeof parseWillardBoard>['flights'] | null;
  explicitEmpty: boolean; error: string | null;
};
const cache = new Map<Kind, { at: number; board: Board }>();
const TTL = 60000, MAX_BYTES = 1024 * 1024;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
function centralDay() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (name: string) => p.find(part => part.type === name)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
async function html(response: Response) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) throw new Error('Provider did not return a flight board.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('Provider flight board is unavailable.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Provider flight board exceeds the read limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
async function board(kind: Kind, requestSignal: AbortSignal): Promise<Board> {
  requestSignal.throwIfAborted();
  const prior = cache.get(kind);
  if (prior && Date.now() - prior.at >= 0 && Date.now() - prior.at < TTL && prior.board.providerDate === centralDay()) return prior.board;
  const sourceUrl = SOURCES[kind];
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(10000)]);
  try {
    const response = await fetch(sourceUrl, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { Accept: 'text/html', 'User-Agent': 'CMPRI-Willard-Flight-Board/1.0' } });
    if (!response.ok) throw new Error('Provider flight board returned HTTP ' + response.status + '.');
    const source = await html(response);
    signal.throwIfAborted();
    const parsed = parseWillardBoard(source, kind, new Date());
    signal.throwIfAborted();
    const value: Board = { status: 'live', sourceUrl, retrievedAt: new Date().toISOString(), ...parsed, error: null };
    cache.set(kind, { at: Date.now(), board: value });
    return value;
  } catch {
    requestSignal.throwIfAborted();
    return { status: 'unavailable', sourceUrl, retrievedAt: null, providerDate: null, flights: null, explicitEmpty: false,
      error: 'Live flight information could not be verified. The provider may be unavailable, outdated, or have changed its board format.' };
  }
}
export async function GET(request: Request) {
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  if (request.signal.aborted) return Response.json({ error: 'Request canceled.' }, { status: 499, headers: HEADERS });
  // Caller query parameters cannot change the airport, provider, dates or URLs.
  try {
    const [arrivals, departures] = await Promise.all([board('arrivals', request.signal), board('departures', request.signal)]);
    request.signal.throwIfAborted();
    return Response.json({ airport: 'KCMI', iata: 'CMI', timeZone: 'America/Chicago', checkedAt: new Date().toISOString(),
      boards: { arrivals, departures } }, { headers: HEADERS });
  } catch {
    const canceled = request.signal.aborted;
    return Response.json({ error: canceled ? 'Request canceled.' : 'Flight information unavailable.' }, { status: canceled ? 499 : 502, headers: HEADERS });
  }
}
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
