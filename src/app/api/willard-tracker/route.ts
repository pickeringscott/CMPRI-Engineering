export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const SOURCE = 'https://api.adsb.lol/v2/point/40.03/-88.28/50';
const TTL = 180000, MAX_BYTES = 2 * 1024 * 1024, MAX_BACKOFF = 86400000;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
type Json = Record<string, unknown>;
type Aircraft = {
  hex: string; callsign: string | null; registration: string | null; type: string | null;
  lat: number; lon: number; altitudeFeet: number | 'ground' | null; speedKnots: number | null;
  track: number | null; seenSeconds: number | null; positionAgeSeconds: number | null;
};
type Sample = { observedAt: string; retrievedAt: string; aircraft: Aircraft[]; invalidAircraftCount: number };
type Pending = { controller: AbortController; promise: Promise<void>; waiters: number; settled: boolean };
let cached: { at: number; sample: Sample } | null = null;
let pending: Pending | null = null;
let retryUntil = 0, lastError: string | null = null;

function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
function number(value: unknown, minimum = -Infinity, maximum = Infinity): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}
function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
}
function normalize(value: unknown): Aircraft | null {
  const row = object(value);
  if (!row || typeof row.hex !== 'string' || !/^~?[a-f0-9]{6}$/i.test(row.hex)) return null;
  const lat = number(row.lat, -90, 90), lon = number(row.lon, -180, 180);
  if (lat === null || lon === null) return null;
  return {
    hex: row.hex.toLowerCase(), callsign: text(row.flight, 32), registration: text(row.r, 32), type: text(row.t, 16),
    lat, lon, altitudeFeet: row.alt_baro === 'ground' ? 'ground' : number(row.alt_baro),
    speedKnots: number(row.gs, 0), track: number(row.track, 0, 360), seenSeconds: number(row.seen, 0),
    // seen is message age; only seen_pos measures the age of a reported position.
    positionAgeSeconds: number(row.seen_pos, 0),
  };
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('Invalid aircraft response format.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw Error('Aircraft response exceeds the read limit.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw Error('Aircraft response exceeds the read limit.'); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}
function retryDelay(value: string | null): number {
  const trimmed = value?.trim() || '';
  const milliseconds = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(MAX_BACKOFF, Math.max(TTL, milliseconds)) : TTL;
}
function parseSample(value: unknown): Sample {
  const body = object(value);
  if (!body || !Array.isArray(body.ac) || body.error || (typeof body.msg === 'string' && body.msg !== 'No error')) throw Error('Aircraft collection could not be verified.');
  // ADSB.lol jv2 `now` is Unix milliseconds, as documented by readsb. Do not
  // guess seconds or use ctime/receipt time as the observation timestamp.
  const milliseconds = number(body.now, Date.UTC(2000, 0, 1), Date.UTC(2100, 0, 1));
  if (milliseconds === null || milliseconds > Date.now() + 60000) throw Error('Aircraft observation time could not be verified.');
  const aircraft = body.ac.map(normalize).filter((row): row is Aircraft => row !== null);
  if ((body.ac.length > 0 && aircraft.length === 0) || (body.ac.length === 0 && typeof body.total === 'number' && body.total > 0)) throw Error('Aircraft positions could not be verified.');
  return { observedAt: new Date(milliseconds).toISOString(), retrievedAt: new Date().toISOString(), aircraft,
    invalidAircraftCount: body.ac.length - aircraft.length };
}
function begin(): Pending {
  const controller = new AbortController();
  const entry: Pending = { controller, promise: Promise.resolve(), waiters: 0, settled: false };
  pending = entry;
  entry.promise = (async () => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      const response = await fetch(SOURCE, { method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit', signal,
        headers: { Accept: 'application/json', 'User-Agent': 'CMPRI-Willard-Tracker/1.0' } });
      if (response.status === 429) {
        retryUntil = Date.now() + retryDelay(response.headers.get('retry-after'));
        throw Error('Aircraft provider request limit reached.');
      }
      if (!response.ok) throw Error('Aircraft provider is unavailable.');
      const sample = parseSample(await boundedJson(response, signal));
      signal.throwIfAborted();
      cached = { at: Date.now(), sample }; lastError = null; retryUntil = 0;
    } catch (error) {
      if (controller.signal.aborted) return;
      retryUntil = Math.max(retryUntil, Date.now() + TTL);
      lastError = error instanceof Error && error.message === 'Aircraft provider request limit reached.'
        ? error.message : 'Aircraft data could not be verified. The provider may be unavailable or its response may have changed.';
    } finally {
      entry.settled = true;
      if (pending === entry) pending = null;
    }
  })();
  return entry;
}
async function wait(entry: Pending, signal: AbortSignal) {
  signal.throwIfAborted(); entry.waiters += 1;
  let abort: (() => void) | null = null;
  try {
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error('Request canceled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    await Promise.race([entry.promise, canceled]);
    signal.throwIfAborted();
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled) {
      entry.controller.abort();
      if (pending === entry) pending = null;
    }
  }
}
function response() {
  const now = Date.now(), sample = cached?.sample;
  const stale = sample && (lastError !== null || now - Date.parse(sample.observedAt) > TTL || now - (cached?.at || 0) >= TTL);
  const status = sample ? stale ? 'stale' : 'live' : 'unavailable';
  const retryAt = retryUntil > now ? new Date(retryUntil).toISOString() : null;
  const headers: Record<string, string> = { ...HEADERS };
  if (retryAt) headers['Retry-After'] = String(Math.ceil((retryUntil - now) / 1000));
  return Response.json({ airport: 'KCMI', center: { lat: 40.03, lon: -88.28 }, radiusNm: 50,
    status, observedAt: sample?.observedAt || null, retrievedAt: sample?.retrievedAt || null,
    aircraft: sample?.aircraft || null, invalidAircraftCount: sample?.invalidAircraftCount ?? null,
    error: lastError, retryAt, cacheSeconds: TTL / 1000, staleAfterSeconds: TTL / 1000,
    sourceUrl: SOURCE, source: { name: 'ADSB.lol', url: SOURCE, documentationUrl: 'https://www.adsb.lol/docs/open-data/api' },
    license: { name: 'ODbL 1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    attribution: 'Aircraft data © ADSB.lol contributors · ODbL 1.0',
    changes: 'CMI 50 NM position subset normalized from the ADSB.lol readsb snapshot; unknown values retained as null. The returned data is licensed under ODbL 1.0.',
  }, { status: sample ? 200 : 502, headers });
}
export async function GET(request: Request) {
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  if (request.signal.aborted) return Response.json({ error: 'Request canceled.' }, { status: 499, headers: HEADERS });
  // All caller query/sharing metadata is ignored. No user-selectable URL, point,
  // radius, credentials, cookie, application account or database is consulted.
  try {
    const age = cached ? Date.now() - cached.at : Infinity;
    if (!(cached && age >= 0 && age < TTL) && Date.now() >= retryUntil) await wait(pending || begin(), request.signal);
    request.signal.throwIfAborted();
    return response();
  } catch {
    return Response.json({ error: 'Request canceled.' }, { status: request.signal.aborted ? 499 : 502, headers: HEADERS });
  }
}
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
