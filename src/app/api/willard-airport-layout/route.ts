export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const ROOT = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/';
const DEFINITIONS = [
  { kind: 'runway', service: 'AM_Runway', fields: 'OBJECTID,FAA_ID,ICAO_ID,DESIGNATOR,SURFACE,RWY_OPER,RWY_ID', operational: 'RWY_OPER' },
  { kind: 'taxiway', service: 'AM_Taxiway', fields: 'OBJECTID,FAA_ID,ICAO_ID,DESIGNATOR,SURFACE,TWY_OPER', operational: 'TWY_OPER' },
  { kind: 'apron', service: 'AM_Apron', fields: 'OBJECTID,FAA_ID,ICAO_ID,DESIGNATOR,SURFACE,APRON_OPER', operational: 'APRON_OPER' },
] as const;
type Definition = typeof DEFINITIONS[number];
type Json = Record<string, unknown>;
type Layer = {
  kind: Definition['kind']; status: 'available' | 'stale' | 'unavailable'; features: Json[] | null;
  featureCount: number | null; invalidFeatureCount: number | null; sourceUrl: string; metadataUrl: string;
  retrievedAt: string | null; effectivePeriod: string; sourceDataEditedAt: string; error: string | null;
  sourceMetadataReviewedAt: string;
};
type Batch = { layers: Layer[]; expiresAt: number };
type Pending = { controller: AbortController; promise: Promise<void>; waiters: number; settled: boolean };
const TTL = 6 * 60 * 60 * 1000, FAILURE_TTL = 5 * 60 * 1000, MAX_BYTES = 2 * 1024 * 1024;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
let cached: Batch | null = null, pending: Pending | null = null;

function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
function source(definition: Definition) {
  const metadataUrl = ROOT + definition.service + '/FeatureServer/0';
  const query = new URLSearchParams({ where: "ICAO_ID='KCMI'", outFields: definition.fields,
    returnGeometry: 'true', outSR: '4326', f: 'geojson' });
  return { metadataUrl, sourceUrl: metadataUrl + '/query?' + query.toString() };
}
function wgs84(value: Json): boolean {
  const sr = object(value.spatialReference);
  if (sr && (![sr.wkid, sr.latestWkid].some(value => value === 4326)
    || [sr.wkid, sr.latestWkid].some(value => value !== undefined && value !== 4326))) return false;
  if (value.crs === undefined || value.crs === null) return true;
  const crs = object(value.crs), properties = object(crs?.properties);
  return crs?.type === 'name' && typeof properties?.name === 'string'
    && ['EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'OGC:CRS84', 'CRS84'].includes(properties.name);
}
function position(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2 && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
function ring(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4 || !value.every(position)) return false;
  const first = value[0], last = value[value.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}
function polygon(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(ring);
}
function feature(value: unknown, definition: Definition): Json | null {
  const raw = object(value), properties = object(raw?.properties), geometry = object(raw?.geometry);
  if (raw?.type !== 'Feature' || !properties || !geometry || !wgs84(geometry)
    || typeof properties.ICAO_ID !== 'string' || properties.ICAO_ID.trim().toUpperCase() !== 'KCMI') return null;
  if (!(geometry.type === 'Polygon' && polygon(geometry.coordinates))
    && !(geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.every(polygon))) return null;
  const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? value : null;
  return { type: 'Feature', ...(typeof raw.id === 'string' || typeof raw.id === 'number' ? { id: raw.id } : {}),
    geometry: { type: geometry.type, coordinates: geometry.coordinates },
    properties: { kind: definition.kind, designator: typeof properties.DESIGNATOR === 'string' ? properties.DESIGNATOR : null,
      airportId: properties.ICAO_ID, faaId: typeof properties.FAA_ID === 'string' ? properties.FAA_ID : null,
      sourceId: scalar(properties.OBJECTID), status: scalar(properties[definition.operational]), surface: scalar(properties.SURFACE) } };
}
async function boundedJson(response: Response, signal: AbortSignal, budget: { bytes: number }): Promise<unknown> {
  const type = response.headers.get('content-type')?.toLowerCase() || '';
  if (!(type.startsWith('application/json') || type.startsWith('application/geo+json')) || !response.body) throw Error('Airport layout response format is unavailable.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('Airport layout response exceeds the read limit.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > MAX_BYTES) { await reader.cancel(); throw Error('Airport layout responses exceed the combined read limit.'); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}
async function layer(definition: Definition, signal: AbortSignal, budget: { bytes: number }, prior: Layer | undefined): Promise<Layer> {
  const urls = source(definition);
  // These are the source's published description/edit metadata, not a claim
  // about today's operating status or the validity of a 2025 effective cycle.
  const metadata = { kind: definition.kind, ...urls, sourceMetadataReviewedAt: '2026-11-20',
    effectivePeriod: '0901Z 7 August 2025–2 October 2025', sourceDataEditedAt: '2026-10-29' };
  try {
    const response = await fetch(urls.sourceUrl, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { Accept: 'application/geo+json, application/json', 'User-Agent': 'CMPRI-Willard-Airport-Reference/1.0' } });
    if (!response.ok) throw Error('Official airport layout source is unavailable.');
    const raw = object(await boundedJson(response, signal, budget));
    signal.throwIfAborted();
    if (!raw || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features) || !wgs84(raw)
      || raw.error || raw.exceededTransferLimit === true || object(raw.properties)?.exceededTransferLimit === true) throw Error('Complete WGS84 airport layout geometry could not be verified.');
    const features = raw.features.map(value => feature(value, definition)).filter((value): value is Json => value !== null);
    if (!features.length) throw Error('No verified KCMI geometry is available in this airport layout layer.');
    return { ...metadata, status: 'available', features, featureCount: features.length,
      invalidFeatureCount: raw.features.length - features.length, retrievedAt: new Date().toISOString(), error: null };
  } catch {
    if (prior?.features?.length) return { ...prior, status: 'stale', error: 'The official layer could not be refreshed; retained geometry is old reference data.' };
    return { ...metadata, status: 'unavailable', features: null, featureCount: null, invalidFeatureCount: null,
      retrievedAt: null, error: 'Verified KCMI geometry is unavailable from this official layer.' };
  }
}
function begin(): Pending {
  const controller = new AbortController();
  const entry: Pending = { controller, promise: Promise.resolve(), waiters: 0, settled: false };
  pending = entry;
  entry.promise = (async () => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), budget = { bytes: 0 };
    try {
      const previous = cached?.layers;
      const layers = await Promise.all(DEFINITIONS.map(definition => layer(definition, signal, budget, previous?.find(value => value.kind === definition.kind))));
      controller.signal.throwIfAborted();
      cached = { layers, expiresAt: Date.now() + (layers.some(value => value.status === 'available') ? TTL : FAILURE_TTL) };
    } catch { /* Canceled requests cannot warm or replace the memory cache. */ }
    finally { entry.settled = true; if (pending === entry) pending = null; }
  })();
  return entry;
}
async function wait(entry: Pending, signal: AbortSignal) {
  signal.throwIfAborted(); entry.waiters += 1;
  let abort: (() => void) | null = null;
  try {
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error('Request canceled.'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    await Promise.race([entry.promise, canceled]); signal.throwIfAborted();
  } finally {
    if (abort) signal.removeEventListener('abort', abort); entry.waiters -= 1;
    if (!entry.waiters && !entry.settled) { entry.controller.abort(); if (pending === entry) pending = null; }
  }
}
function response() {
  const layers = cached?.layers || [], features = layers.flatMap(value => value.features || []);
  const available = layers.filter(value => value.status === 'available');
  const complete = layers.length === DEFINITIONS.length && available.length === DEFINITIONS.length && layers.every(value => value.invalidFeatureCount === 0);
  const status = complete ? 'available' : available.length ? 'partial' : features.length ? 'stale' : 'unavailable';
  const times = layers.map(value => value.retrievedAt).filter((value): value is string => Boolean(value)).sort();
  return Response.json({ airport: 'KCMI', status, collection: features.length ? { type: 'FeatureCollection', features } : null,
    retrievedAt: times.at(-1) || null, layers: layers.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'features'))),
    attribution: 'FAA Air Traffic Organization · Aeronautical Information Services',
    sourceUrl: 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/',
    license: { name: 'U.S. Government public data', url: 'https://www.faa.gov/air_traffic/flight_info/aeronav/FAA_DATA_DISCLAIMER/' },
    referenceOnly: true, operationalStatusNote: 'Airport layout reference geometry. Source-coded operational values are not current runway, taxiway or apron closure information.',
    error: complete ? null : features.length ? 'Some airport layout geometry is unavailable or old.' : 'Verified airport layout geometry is unavailable.',
    cacheSeconds: available.length ? TTL / 1000 : FAILURE_TTL / 1000,
  }, { status: features.length ? 200 : 502, headers: HEADERS });
}
export async function GET(request: Request) {
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
  if (request.signal.aborted) return Response.json({ error: 'Request canceled.' }, { status: 499, headers: HEADERS });
  // The property, airport, fields and source URLs are fixed. Caller/sharing
  // query metadata cannot select another source or change the official query.
  try {
    if (!cached || Date.now() >= cached.expiresAt) await wait(pending || begin(), request.signal);
    request.signal.throwIfAborted(); return response();
  } catch { return Response.json({ error: 'Request canceled.' }, { status: request.signal.aborted ? 499 : 502, headers: HEADERS }); }
}
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
