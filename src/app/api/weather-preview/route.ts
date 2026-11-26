import { dashboardWeather } from '../../../lib/weather/dashboard-weather';
import { NWS_WEATHER_API as API, readPropertyWeatherAlerts } from '../../../lib/weather/property-alerts';

/** Foreground Weather reads from fixed official NWS sources; no application data. */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const OBSERVATION_STATION_ID = 'KCMI';
const OBSERVATION_SOURCE = API + '/stations/' + OBSERVATION_STATION_ID + '/observations/latest';
const HISTORY_PATH = '/stations/' + OBSERVATION_STATION_ID + '/observations';
const HISTORY_LIMIT = 500;
const HISTORY_ANCHOR_MINUTES = 90;
const LOCATION = {
  name: 'Residence Inn Champaign', address: '502 West Marketview Drive, Champaign, IL',
  latitude: 40.138080, longitude: -88.251416, timeZone: 'America/Chicago',
};
// NWS canonicalizes point discovery to four decimals. The property and alert
// query retain the verified exact coordinates; discovery avoids its 301 redirect.
const LOOKUP_POINT = LOCATION.latitude.toFixed(4) + ',' + LOCATION.longitude.toFixed(4);
type Json = Record<string, unknown>;
type Station = { id: string; name: string | null; latitude: number | null; longitude: number | null; distanceMeters: number | null };
type Resource = {
  status: 'live' | 'unavailable' | 'stale'; source: string | null; receivedAt: string;
  sourceTimestamp: string | null; data: Json | null; error: string | null; station?: Station;
};
function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
const centralClock = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCATION.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function centralParts(value: Date) {
  return Object.fromEntries(centralClock.formatToParts(value).filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}
function centralMidnight(value: Date): string {
  const local = centralParts(value);
  const wallMidnight = Date.UTC(local.year, local.month - 1, local.day);
  let candidate = wallMidnight;
  // Resolve this wall-clock midnight's own offset. The offset at the current
  // observation can differ on the spring/fall DST transition dates.
  for (let attempt = 0; attempt < 3; attempt++) {
    const part = centralParts(new Date(candidate));
    const represented = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
    const difference = wallMidnight - represented;
    candidate += difference;
    if (difference === 0) return new Date(candidate).toISOString();
  }
  throw new Error('The Central local-day boundary is unavailable.');
}
function officialUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== API || url.username || url.password || url.hash) return null;
    if (url.pathname === HISTORY_PATH) {
      const keys = Array.from(url.searchParams.keys());
      if (keys.length !== 3 || keys.some(key => !['start', 'end', 'limit'].includes(key))
        || keys.some(key => url.searchParams.getAll(key).length !== 1) || url.searchParams.get('limit') !== String(HISTORY_LIMIT)) return null;
      const start = timestamp(url.searchParams.get('start')), end = timestamp(url.searchParams.get('end'));
      if (!start || !end || start !== url.searchParams.get('start') || end !== url.searchParams.get('end')) return null;
      const expectedStart = Date.parse(centralMidnight(new Date(end))) - HISTORY_ANCHOR_MINUTES * 60000;
      const interval = Date.parse(end) - Date.parse(start);
      return Date.parse(start) === expectedStart && interval >= 0 && interval <= (25 * 60 + HISTORY_ANCHOR_MINUTES) * 60000
        && Date.parse(end) <= Date.now() + 5000 ? url : null;
    }
    if (url.search) return null;
    return url.pathname === '/points/' + LOOKUP_POINT
      || /^\/gridpoints\/[A-Z]{3}\/\d{1,4},\d{1,4}(?:\/forecast(?:\/hourly)?|\/stations)?$/.test(url.pathname)
      || /^\/stations\/[A-Z0-9]{3,8}\/observations\/latest$/.test(url.pathname) ? url : null;
  } catch { return null; }
}
function unavailable(source: string | null, error: string): Resource {
  return { status: 'unavailable', source, receivedAt: new Date().toISOString(), sourceTimestamp: null, data: null, error };
}
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function dated(resource: Resource, kind: 'forecast' | 'observation'): Resource {
  if (!resource.data) return resource;
  const properties = object(resource.data.properties) || {};
  const sourceTime = timestamp(kind === 'observation' ? properties.timestamp : properties.updateTime || properties.updated || properties.generatedAt);
  resource.sourceTimestamp = sourceTime;
  if (kind === 'observation' && !sourceTime) {
    resource.status = 'unavailable'; resource.error = 'The station report has no verifiable observation time.';
  } else if (sourceTime && Date.parse(sourceTime) > Date.now() + 5 * 60000) {
    resource.status = 'unavailable'; resource.error = 'The NWS source timestamp is in the future.';
  } else if (sourceTime && Date.now() - Date.parse(sourceTime) > (kind === 'observation' ? 90 * 60000 : 6 * 3600000)) {
    resource.status = 'stale'; resource.error = kind === 'observation' ? 'The station observation is more than 90 minutes old.' : 'The forecast issue/update time is more than six hours old.';
  }
  return resource;
}
async function read(source: unknown, signal: AbortSignal): Promise<Resource> {
  const url = officialUrl(source);
  if (!url) return unavailable(null, 'The official NWS resource URL is missing or outside the fixed-source allowlist.');
  try {
    const response = await fetch(url.href, {
      headers: { Accept: 'application/geo+json', 'User-Agent': 'CMPRIWeatherPreview/1.0 (https://cmpri-engineering.com)' },
      cache: 'no-store', credentials: 'omit', redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    });
    if (!response.ok) throw new Error('NWS returned HTTP ' + response.status + (response.status >= 300 && response.status < 400 ? '; redirects are not followed.' : '.'));
    if (response.url && !officialUrl(response.url)) throw new Error('NWS returned an unverified response URL.');
    const data = object(await response.json());
    if (!data) throw new Error('NWS returned an invalid JSON document.');
    if (url.pathname === HISTORY_PATH) {
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > HISTORY_LIMIT) throw new Error('NWS returned no bounded observation feature collection.');
    } else if (url.pathname.endsWith('/stations')) {
      if (!Array.isArray(data.features)) throw new Error('NWS returned no verifiable feature collection.');
    } else {
      const properties = object(data.properties);
      if (!properties) throw new Error('NWS returned no verifiable product properties.');
      if (/\/forecast(?:\/hourly)?$/.test(url.pathname) && !Array.isArray(properties.periods)) throw new Error('NWS returned no verifiable forecast periods.');
    }
    return { status: 'live', source: url.href, receivedAt: new Date().toISOString(), sourceTimestamp: null, data, error: null };
  } catch (error) {
    return unavailable(url.href, error instanceof Error ? error.message : 'The official NWS request was unavailable.');
  }
}
function fixedStationMetadata(data: Json | null): Station | null {
  const features = data && Array.isArray(data.features) ? data.features : [];
  const stations = features.flatMap((value): Station[] => {
    const feature = object(value), properties = object(feature?.properties), geometry = object(feature?.geometry);
    const id = properties?.stationIdentifier;
    if (id !== OBSERVATION_STATION_ID) return [];
    const coordinates = geometry?.type === 'Point' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    const longitude = typeof coordinates[0] === 'number' && Math.abs(coordinates[0]) <= 180 ? coordinates[0] : null;
    const latitude = typeof coordinates[1] === 'number' && Math.abs(coordinates[1]) <= 90 ? coordinates[1] : null;
    let distanceMeters = null;
    if (latitude !== null && longitude !== null) {
      const rad = Math.PI / 180, lat = (latitude - LOCATION.latitude) * rad, lon = (longitude - LOCATION.longitude) * rad;
      const a = Math.sin(lat / 2) ** 2 + Math.cos(LOCATION.latitude * rad) * Math.cos(latitude * rad) * Math.sin(lon / 2) ** 2;
      distanceMeters = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))));
    }
    return [{ id, name: typeof properties?.name === 'string' ? properties.name : null, latitude, longitude, distanceMeters }];
  });
  return stations[0] || null;
}
async function observationResource(signal: AbortSignal): Promise<Resource> {
  // KCMI is the verified property observation station. Reading it directly
  // avoids waiting for point discovery, forecasts, or a station-list request.
  const observation = dated(await read(OBSERVATION_SOURCE, signal), 'observation');
  observation.station = fixedStationMetadata({ features: [{
    properties: { stationIdentifier: OBSERVATION_STATION_ID, name: 'University of Illinois - Willard' },
    geometry: observation.data?.geometry,
  }] }) || { id: OBSERVATION_STATION_ID, name: 'University of Illinois - Willard',
    latitude: null, longitude: null, distanceMeters: null };
  return observation;
}
async function historyResource(signal: AbortSignal) {
  const asOf = new Date().toISOString(), dayStart = centralMidnight(new Date(asOf));
  const queryStart = new Date(Date.parse(dayStart) - HISTORY_ANCHOR_MINUTES * 60000).toISOString();
  const source = API + HISTORY_PATH + '?' + new URLSearchParams({ start: queryStart, end: asOf, limit: String(HISTORY_LIMIT) });
  const history = await read(source, signal);
  const features = history.data && Array.isArray(history.data.features) ? history.data.features : null;
  const times = (features || []).flatMap(value => {
    const feature = object(value), report = object(feature?.properties), time = timestamp(report?.timestamp);
    return time && Date.parse(time) >= Date.parse(queryStart) && Date.parse(time) <= Date.parse(asOf) ? [time] : [];
  }).sort();
  history.sourceTimestamp = times.at(-1) || null;
  if (history.data && !history.sourceTimestamp) {
    history.status = 'unavailable'; history.error = 'No verifiable timestamped KCMI reports were returned for this history interval.';
  } else if (history.sourceTimestamp && Date.now() - Date.parse(history.sourceTimestamp) > 90 * 60000) {
    history.status = 'stale'; history.error = 'The newest returned KCMI history report is more than 90 minutes old.';
  }
  const pagination = object(history.data?.pagination);
  const truncated = features ? features.length >= HISTORY_LIMIT || Boolean(pagination?.next) : null;
  return { resource: history, metadata: {
    dayStart, queryStart, asOf, timeZone: LOCATION.timeZone, anchorLookbackMinutes: HISTORY_ANCHOR_MINUTES,
    // This is response completeness only. Samples and gaps do not establish
    // continuous coverage or an observation at midnight; raw reports stay raw.
    queryComplete: features !== null && !truncated, truncated, returnedCount: features?.length ?? null,
    oldestSourceTimestamp: times[0] || null, newestSourceTimestamp: history.sourceTimestamp,
  } };
}
async function propertyResources(signal: AbortSignal, includeStations: boolean) {
  const points = await read(API + '/points/' + LOOKUP_POINT, signal);
  const properties = object(points.data?.properties);
  const missing = () => unavailable(null, 'NWS point discovery is unavailable; no forecast or station-list value was substituted.');
  if (!properties) return { points, forecast: missing(), hourly: missing(), grid: missing(), ...(includeStations ? { stations: missing() } : {}) };
  const [forecast, hourly, grid, stations] = await Promise.all([
    read(properties.forecast, signal).then(value => dated(value, 'forecast')),
    read(properties.forecastHourly, signal).then(value => dated(value, 'forecast')),
    read(properties.forecastGridData, signal).then(value => dated(value, 'forecast')),
    includeStations ? read(properties.observationStations, signal) : Promise.resolve(null),
  ]);
  return { points, forecast, hourly, grid, ...(includeStations ? { stations: stations || missing() } : {}) };
}

async function dashboardResource(signal: AbortSignal) {
  const forecast = read(API + '/points/' + LOOKUP_POINT, signal).then(points => {
    const property = object(points.data?.properties);
    return Promise.all([
      read(property?.forecastHourly, signal).then(value => dated(value, 'forecast')),
      read(property?.forecastGridData, signal).then(value => dated(value, 'forecast')),
    ]);
  });
  const [observation, [hourly, grid], astronomy] = await Promise.all([
    observationResource(signal),
    forecast,
    import('astronomy-engine').catch(() => null),
  ]);
  const now = new Date();
  const dayStart = Date.parse(centralMidnight(now));
  const dayEnd = Date.parse(centralMidnight(new Date(dayStart + 26 * 3600000)));
  return dashboardWeather(observation, hourly, grid, now, dayStart, dayEnd, astronomy?.MoonPhase(now) ?? null);
}

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers });
  const query = new URL(request.url).searchParams;
  const part = query.get('part');
  // Sharing/connector query metadata is ignored and never forwarded. Only the
  // recognized partial-response selector affects these fixed official reads.
  if (query.getAll('part').length > 1 || (part !== null && !['observation', 'history', 'alerts', 'forecast', 'dashboard'].includes(part))) {
    return Response.json({ error: 'Choose one supported weather response part.' }, { status: 400, headers });
  }
  if (part === 'dashboard') {
    return Response.json({ dashboard: await dashboardResource(request.signal) }, { headers });
  }
  if (part === 'observation') {
    const observation = await observationResource(request.signal);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { observation } }, { headers });
  }
  if (part === 'history') {
    const history = await historyResource(request.signal);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), history: history.metadata,
      resources: { history: history.resource } }, { headers });
  }
  if (part === 'alerts') {
    const alerts = await readPropertyWeatherAlerts(request.signal);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { alerts } }, { headers });
  }
  if (part === 'forecast') {
    const forecast = await propertyResources(request.signal, false);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: forecast }, { headers });
  }
  const [property, observation, alerts] = await Promise.all([
    propertyResources(request.signal, true),
    observationResource(request.signal),
    readPropertyWeatherAlerts(request.signal),
  ]);
  // Preserve the legacy complete envelope and its more precise station-list
  // metadata, while fetching the observation exactly once and independently.
  const station = fixedStationMetadata(property.stations?.data || null);
  if (station) observation.station = station;
  // Keep the complete point-query collection, including applicable polygonless alerts.
  return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { ...property, observation, alerts } }, { headers });
}
