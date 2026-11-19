/** Foreground branch-review reads from official NWS sources; no application data. */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const API = 'https://api.weather.gov';
const POINT = '40.138080,-88.251416';
const LOCATION = {
  name: 'Residence Inn Champaign', address: '502 West Marketview Drive, Champaign, IL',
  latitude: 40.138080, longitude: -88.251416, timeZone: 'America/Chicago',
};
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
    return url.pathname === '/points/' + POINT
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
function nearestStation(data: Json | null): Station | null {
  const features = data && Array.isArray(data.features) ? data.features : [];
  const stations = features.flatMap((value): Station[] => {
    const feature = object(value), properties = object(feature?.properties), geometry = object(feature?.geometry);
    const id = properties?.stationIdentifier;
    if (typeof id !== 'string' || !/^[A-Z0-9]{3,8}$/.test(id)) return [];
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
  stations.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
  return stations[0] || null;
}
async function propertyResources(signal: AbortSignal) {
  const points = await read(API + '/points/' + POINT, signal);
  const properties = object(points.data?.properties);
  const missing = () => unavailable(null, 'NWS point discovery is unavailable; no forecast or station value was substituted.');
  if (!properties) return { points, forecast: missing(), hourly: missing(), grid: missing(), stations: missing(), observation: missing() };
  const [forecast, hourly, grid, stations] = await Promise.all([
    read(properties.forecast, signal).then(value => dated(value, 'forecast')),
    read(properties.forecastHourly, signal).then(value => dated(value, 'forecast')),
    read(properties.forecastGridData, signal).then(value => dated(value, 'forecast')),
    read(properties.observationStations, signal),
  ]);
  const station = nearestStation(stations.data);
  const observation = station
    ? dated(await read(API + '/stations/' + station.id + '/observations/latest', signal), 'observation')
    : unavailable(null, 'No official observation station could be verified from the NWS station list.');
  if (station) observation.station = station;
  return { points, forecast, hourly, grid, stations, observation };
}
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  // This check precedes all discovery, network requests and application imports.
  const previewEnabled = process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development';
  if (process.env.VERCEL_ENV === 'production' || !previewEnabled) return Response.json({ error: 'Not found.' }, { status: 404, headers });
  const [property, alerts] = await Promise.all([
    propertyResources(request.signal),
    read(API + '/alerts/active?point=' + POINT, request.signal),
  ]);
  // Keep the complete point-query collection, including applicable polygonless alerts.
  return Response.json({ location: LOCATION, checkedAt: new Date().toISOString(), resources: { ...property, alerts } }, { headers });
}
