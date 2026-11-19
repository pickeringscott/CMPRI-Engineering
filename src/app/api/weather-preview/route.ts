/** Foreground branch-review reads from official NWS sources; no application data. */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const API = 'https://api.weather.gov';
const POINT = '40.138080,-88.251416';
const OBSERVATION_STATION_ID = 'KCMI';
const OBSERVATION_SOURCE = API + '/stations/' + OBSERVATION_STATION_ID + '/observations/latest';
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
function officialUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== API || url.username || url.password || url.hash) return null;
    if (url.pathname === '/alerts/active') {
      return url.searchParams.get('point') === POINT && Array.from(url.searchParams.keys()).length === 1 ? url : null;
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
    if (url.pathname === '/alerts/active' || url.pathname.endsWith('/stations')) {
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
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  // This check precedes all discovery, network requests and application imports.
  const previewEnabled = process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development';
  if (process.env.VERCEL_ENV === 'production' || !previewEnabled) return Response.json({ error: 'Not found.' }, { status: 404, headers });
  if (request.method !== 'GET') return Response.json({ error: 'Only GET is supported.' }, { status: 405, headers });
  const query = new URL(request.url).searchParams;
  const part = query.get('part');
  // Sharing/connector query metadata is ignored and never forwarded. Only the
  // recognized partial-response selector affects these fixed official reads.
  if (query.getAll('part').length > 1 || (part !== null && !['observation', 'alerts', 'forecast'].includes(part))) {
    return Response.json({ error: 'Choose one supported weather response part.' }, { status: 400, headers });
  }
  if (part === 'observation') {
    const observation = await observationResource(request.signal);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { observation } }, { headers });
  }
  if (part === 'alerts') {
    const alerts = await read(API + '/alerts/active?point=' + POINT, request.signal);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { alerts } }, { headers });
  }
  if (part === 'forecast') {
    const forecast = await propertyResources(request.signal, false);
    return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: forecast }, { headers });
  }
  const [property, observation, alerts] = await Promise.all([
    propertyResources(request.signal, true),
    observationResource(request.signal),
    read(API + '/alerts/active?point=' + POINT, request.signal),
  ]);
  // Preserve the legacy complete envelope and its more precise station-list
  // metadata, while fetching the observation exactly once and independently.
  const station = fixedStationMetadata(property.stations?.data || null);
  if (station) observation.station = station;
  // Keep the complete point-query collection, including applicable polygonless alerts.
  return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { ...property, observation, alerts } }, { headers });
}
