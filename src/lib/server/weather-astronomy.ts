/** Foreground-only, fixed-property astronomy; no application data or credentials. */
import {
  Body, Equator, Horizon, Illumination, MoonPhase, NextLocalSolarEclipse,
  NextLunarEclipse, Observer, SearchAltitude, SearchLocalSolarEclipse, SearchLunarEclipse,
} from 'astronomy-engine';

export const ASTRONOMY_SOURCE = 'https://github.com/cosinekitty/astronomy';
export const AURORA_SOURCE = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
export const AURORA_PRODUCT = 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast';
export const ASTRONOMY_LOCATION = Object.freeze({
  name: 'Residence Inn Champaign', address: '502 West Marketview Drive, Champaign, IL',
  latitude: 40.138080, longitude: -88.251416, timeZone: 'America/Chicago',
});
const OBSERVER = new Observer(ASTRONOMY_LOCATION.latitude, ASTRONOMY_LOCATION.longitude, 0);
const MINUTE = 60000, DAY = 86400000;
const MAX_BYTES = 3 * 1024 * 1024;
const AURORA_CACHE_MS = 5 * MINUTE, ECLIPSE_CACHE_MS = 60 * MINUTE;
const PHASE_LABELS = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
export type AstronomyEvent = {
  id: string; type: 'solar-eclipse' | 'lunar-eclipse' | 'aurora'; title: string; summary: string;
  start: string; end: string; peak: string; sourceUrl: string; details: string[]; calculated: boolean;
};
type Window = { start: string; end: string };
type AuroraSample = {
  observationTime: string; forecastTime: string; localValue: number | null;
  nearestLatitude: number | null; nearestLongitude: number | null;
  regionalValue: number | null; regionalLatitude: number | null; regionalLongitude: number | null;
};
export type AuroraGuidance = Omit<AuroraSample, 'observationTime' | 'forecastTime'> & {
  status: 'live' | 'stale' | 'unavailable'; error: string | null;
  observationTime: string | null; forecastTime: string | null; sourceUrl: string;
  sunAltitude: number | null; regionalRadiusKm: number; triggerValue: number;
};
let auroraCache: { sample: AuroraSample; expires: number } | null = null;
let eclipseCache: { key: string; expires: number; events: AstronomyEvent[] } | null = null;

function altitude(body: Body, date: Date): number {
  const equator = Equator(body, date, OBSERVER, true, true);
  // Geometric center and a standard level horizon: no atmospheric refraction,
  // terrain, building obstructions, clouds, or invented observer elevation.
  return Horizon(date, OBSERVER, equator.ra, equator.dec).altitude;
}

/** Intersect an actual eclipse phase with the body's locally visible interval. */
export function localVisibilityWindows(body: Body, start: Date, end: Date): Window[] {
  const first = start.getTime(), last = end.getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first || last - first > DAY) return [];
  const boundaries = [first, last];
  for (const direction of [1, -1]) {
    const crossing = SearchAltitude(body, OBSERVER, direction, start, (last - first) / DAY, 0);
    const time = crossing?.date.getTime();
    if (time !== undefined && time > first && time < last) boundaries.push(time);
  }
  boundaries.sort((a, b) => a - b);
  const windows: Window[] = [];
  for (let index = 1; index < boundaries.length; index++) {
    const left = boundaries[index - 1], right = boundaries[index];
    if (right > left && altitude(body, new Date((left + right) / 2)) > 0) {
      windows.push({ start: new Date(left).toISOString(), end: new Date(right).toISOString() });
    }
  }
  return windows;
}

function visibilityDetail(name: string, windows: Window[]): string {
  return windows.length ? name + ': ' + windows.map(window => window.start
    + ' through ' + window.end).join('; ')
    : name + ': below the local horizon during this phase.';
}

function calculateEclipseCandidates(now: Date): AstronomyEvent[] {
  const day = now.toISOString().slice(0, 10), midnight = Date.parse(day + 'T00:00:00Z');
  // Padding keeps an eclipse whose peak predates the rolling window but whose
  // later phase is still visible. Filter cached candidates against each new now.
  const searchStart = new Date(midnight - 2 * DAY), searchEnd = midnight + 8 * DAY;
  const events: AstronomyEvent[] = [];
  let solar = SearchLocalSolarEclipse(searchStart, OBSERVER);
  for (let index = 0; index < 8 && solar.partial_begin.time.date.getTime() <= searchEnd; index++) {
    const windows = localVisibilityWindows(Body.Sun, solar.partial_begin.time.date, solar.partial_end.time.date);
    if (windows.length) {
      const centralWindows = solar.total_begin && solar.total_end
        ? localVisibilityWindows(Body.Sun, solar.total_begin.time.date, solar.total_end.time.date) : [];
      events.push({
        id: 'solar-' + solar.peak.time.date.toISOString(), type: 'solar-eclipse', title: 'Solar eclipse',
        summary: 'A calculated solar eclipse is above the horizon in Champaign during part of this interval.',
        start: windows[0].start, end: windows[windows.length - 1].end,
        peak: solar.peak.time.date.toISOString(), sourceUrl: ASTRONOMY_SOURCE, calculated: true,
        details: [visibilityDetail('Locally visible eclipse', windows),
          'Calculated maximum alignment: ' + solar.peak.time.date.toISOString()
            + (altitude(Body.Sun, solar.peak.time.date) > 0 ? ', above the local horizon.' : ', below the local horizon.'),
          ...(solar.total_begin ? [visibilityDetail('Central phase', centralWindows)] : []),
          'Calculated for the fixed hotel location and a standard level horizon. Clouds, buildings and terrain can obstruct viewing.',
          'Use proper solar eclipse eye protection when viewing the Sun.'],
      });
    }
    solar = NextLocalSolarEclipse(solar.peak.time, OBSERVER);
  }
  let lunar = SearchLunarEclipse(searchStart);
  for (let index = 0; index < 12 && lunar.peak.date.getTime() - lunar.sd_penum * MINUTE <= searchEnd; index++) {
    const phase = (minutes: number) => minutes > 0 ? localVisibilityWindows(Body.Moon,
      new Date(lunar.peak.date.getTime() - minutes * MINUTE),
      new Date(lunar.peak.date.getTime() + minutes * MINUTE)) : [];
    const penumbral = phase(lunar.sd_penum), partial = phase(lunar.sd_partial), total = phase(lunar.sd_total);
    if (penumbral.length) {
      events.push({
        id: 'lunar-' + lunar.peak.date.toISOString(), type: 'lunar-eclipse', title: 'Lunar eclipse',
        summary: 'A calculated lunar eclipse is above the horizon in Champaign during part of this interval.',
        start: penumbral[0].start, end: penumbral[penumbral.length - 1].end,
        peak: lunar.peak.date.toISOString(), sourceUrl: ASTRONOMY_SOURCE, calculated: true,
        details: [visibilityDetail('Locally visible penumbral phase', penumbral),
          ...(lunar.sd_partial > 0 ? [visibilityDetail('Locally visible partial phase', partial)] : []),
          ...(lunar.sd_total > 0 ? [visibilityDetail('Locally visible total phase', total)] : []),
          'Calculated maximum alignment: ' + lunar.peak.date.toISOString()
            + (altitude(Body.Moon, lunar.peak.date) > 0 ? ', above the local horizon.' : ', below the local horizon; later or earlier phases may be visible.'),
          'Penumbral dimming can be difficult to discern. Clouds, buildings and terrain can obstruct viewing.',
          'Calculated for the fixed hotel location and a standard level horizon; this is not a live observation.'],
      });
    }
    lunar = NextLunarEclipse(lunar.peak);
  }
  return events;
}

export function calculateWeatherAstronomy(now: Date, useCache = true) {
  if (!Number.isFinite(now.getTime())) throw new Error('A valid calculation time is required.');
  const key = now.toISOString().slice(0, 10);
  if (!useCache || !eclipseCache || eclipseCache.key !== key || eclipseCache.expires < now.getTime()) {
    const events = calculateEclipseCandidates(now);
    if (useCache) eclipseCache = { key, expires: now.getTime() + ECLIPSE_CACHE_MS, events };
    else return calculatedResult(now, events);
  }
  return calculatedResult(now, eclipseCache.events);
}

function calculatedResult(now: Date, events: AstronomyEvent[]) {
  const angle = MoonPhase(now), illumination = Illumination(Body.Moon, now).phase_fraction;
  const start = now.getTime() - DAY, end = now.getTime() + 7 * DAY;
  return {
    moonPhase: { label: PHASE_LABELS[Math.floor(((angle + 22.5) % 360) / 45)], angle, illumination,
      calculatedAt: now.toISOString(), sourceUrl: ASTRONOMY_SOURCE },
    events: events.filter(event => Date.parse(event.end) >= start && Date.parse(event.start) <= end),
  };
}

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // SWPC's zone-less timestamp strings are UTC, never the server's local zone.
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const normalized = match[1] + 'T' + match[2] + (match[3] || '') + (match[4] || 'Z');
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) return null;
  // Date.parse can silently roll invalid calendar dates into the next month.
  if (!match[4] || match[4] === 'Z') {
    if (new Date(milliseconds).toISOString().slice(0, 19) !== normalized.slice(0, 19)) return null;
  }
  return new Date(milliseconds).toISOString();
}

function distanceKm(latitude: number, longitude: number): number {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitude - ASTRONOMY_LOCATION.latitude) * radians;
  const deltaLongitude = (longitude - ASTRONOMY_LOCATION.longitude) * radians;
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude * radians)
    * Math.cos(ASTRONOMY_LOCATION.latitude * radians) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/** Preserve real zeros; a missing hotel cell can never become a zero forecast. */
export function parseAuroraSample(value: unknown): AuroraSample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SWPC JSON object is unavailable.');
  const data = value as Record<string, unknown>;
  const observationTime = utcTimestamp(data['Observation Time']), forecastTime = utcTimestamp(data['Forecast Time']);
  if (!observationTime || !forecastTime) throw new Error('SWPC source timestamps are missing or invalid.');
  if (typeof data['Data Format'] !== 'string' || data['Data Format'].replace(/\s/g, '') !== '[Longitude,Latitude,Aurora]'
    || !Array.isArray(data.coordinates) || !data.coordinates.length || data.coordinates.length > 100000) {
    throw new Error('SWPC aurora grid format is unavailable.');
  }
  let nearest = Infinity;
  const result: AuroraSample = { observationTime, forecastTime, localValue: null,
    nearestLatitude: null, nearestLongitude: null, regionalValue: null, regionalLatitude: null, regionalLongitude: null };
  for (const row of data.coordinates) {
    if (!Array.isArray(row) || row.length !== 3 || row.some(item => typeof item !== 'number' || !Number.isFinite(item))
      || row[0] < 0 || row[0] > 360 || row[1] < -90 || row[1] > 90 || row[2] < 0 || row[2] > 100) {
      throw new Error('SWPC aurora grid contains an invalid coordinate or model value.');
    }
    const [rawLongitude, latitude, amount] = row;
    const longitude = ((rawLongitude + 180) % 360) - 180, distance = distanceKm(latitude, longitude);
    if (distance < nearest && distance <= 120) {
      nearest = distance; result.localValue = amount;
      result.nearestLatitude = latitude; result.nearestLongitude = longitude;
    }
    // A limited northern regional signal is not the hotel's exact probability.
    if (latitude >= ASTRONOMY_LOCATION.latitude && distance <= 500
      && (result.regionalValue === null || amount > result.regionalValue)) {
      result.regionalValue = amount; result.regionalLatitude = latitude; result.regionalLongitude = longitude;
    }
  }
  if (result.localValue === null) throw new Error('SWPC grid has no verifiable model cell near the hotel.');
  return result;
}

function unavailableAurora(error: string): AuroraGuidance {
  return { status: 'unavailable', error, observationTime: null, forecastTime: null, localValue: null,
    nearestLatitude: null, nearestLongitude: null, regionalValue: null, regionalLatitude: null, regionalLongitude: null,
    sourceUrl: AURORA_SOURCE, sunAltitude: null, regionalRadiusKm: 500, triggerValue: 10 };
}

export function evaluateAuroraSample(sample: AuroraSample, now: Date): { aurora: AuroraGuidance; event: AstronomyEvent | null } {
  const observed = Date.parse(sample.observationTime), forecast = Date.parse(sample.forecastTime), clock = now.getTime();
  const fresh = Number.isFinite(observed) && Number.isFinite(forecast) && observed <= clock + 5 * MINUTE
    && observed >= clock - 120 * MINUTE && forecast >= observed && forecast <= observed + 120 * MINUTE
    && forecast >= clock - 15 * MINUTE && forecast <= clock + 90 * MINUTE;
  const aurora: AuroraGuidance = { ...sample, status: fresh ? 'live' : 'stale',
    error: fresh ? null : 'SWPC model timestamps are outside the current short-term forecast window.',
    sourceUrl: AURORA_SOURCE, sunAltitude: fresh ? altitude(Body.Sun, new Date(forecast)) : null,
    regionalRadiusKm: 500, triggerValue: 10 };
  const signal = (sample.localValue !== null && sample.localValue >= 10)
    || (sample.regionalValue !== null && sample.regionalValue >= 10);
  if (!fresh || aurora.sunAltitude === null || aurora.sunAltitude > -6 || !signal) return { aurora, event: null };
  return { aurora, event: {
    id: 'aurora-' + sample.forecastTime, type: 'aurora', title: 'Potential northern lights',
    summary: 'Fresh NOAA short-term model guidance indicates potential aurora in the local or nearby northern region after civil twilight.',
    start: sample.observationTime, end: new Date(forecast + 15 * MINUTE).toISOString(), peak: sample.forecastTime,
    sourceUrl: AURORA_PRODUCT, calculated: false,
    details: ['NOAA OVATION is model guidance, not an observation or an official weather alert.',
      'A clear, dark northern horizon is needed. Clouds, light pollution and obstructions can prevent viewing.',
      'The hotel cell and the bounded northern region are separate model samples; a regional value is not an exact probability for the property.',
      'CMPRI uses a model-signal threshold and a northern region within 500 km as a conservative display rule; it is not a NOAA warning category.',
      'Valid time: ' + new Date(forecast).toISOString() + '. Guidance expires 15 minutes after this time.'],
  } };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('SWPC response exceeds the 3 MiB limit.');
  }
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('Content-Type') || '')) {
    void response.body?.cancel().catch(() => {});
    throw new Error('SWPC response is not JSON.');
  }
  if (!response.body) throw new Error('SWPC response body is unavailable.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const canceled = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', canceled, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { canceled(); throw new Error('SWPC response exceeds the 3 MiB limit.'); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', canceled);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

type ReadOptions = { now?: Date; fetcher?: typeof fetch; useCache?: boolean };
export async function readWeatherAstronomy(signal: AbortSignal, options: ReadOptions = {}) {
  signal.throwIfAborted();
  const initial = options.now || new Date(), useCache = options.useCache !== false;
  let sample: AuroraSample | null = null, failure: string | null = null;
  try {
    signal.throwIfAborted();
    if (useCache && auroraCache && auroraCache.expires > initial.getTime()) sample = auroraCache.sample;
    else {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      deadline.throwIfAborted();
      const response = await (options.fetcher || fetch)(AURORA_SOURCE, {
        method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: deadline,
        headers: { Accept: 'application/json', 'User-Agent': 'CMPRI-Weather-Astronomy/1.0 (foreground read-only)' },
      });
      if (deadline.aborted) {
        void response.body?.cancel().catch(() => {});
        deadline.throwIfAborted();
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new Error('SWPC redirects are not followed.');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error('SWPC returned HTTP ' + response.status + '.');
      }
      sample = parseAuroraSample(await readBoundedJson(response, deadline));
      if (useCache) auroraCache = { sample, expires: initial.getTime() + AURORA_CACHE_MS };
    }
    signal.throwIfAborted();
  } catch (error) {
    // Closing Weather cancels all work, including deterministic calculations.
    // An upstream deadline can still leave useful astronomy while the view is open.
    signal.throwIfAborted();
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) failure = 'The SWPC request timed out.';
    else failure = error instanceof Error ? error.message : 'SWPC aurora guidance is unavailable.';
    sample = null;
  }
  signal.throwIfAborted();
  const now = options.now || new Date(), calculated = calculateWeatherAstronomy(now, useCache);
  const guidance = sample ? evaluateAuroraSample(sample, now) : { aurora: unavailableAurora(failure || 'SWPC aurora guidance is unavailable.'), event: null };
  return { ...calculated, events: [...calculated.events, ...(guidance.event ? [guidance.event] : [])]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), aurora: guidance.aurora };
}
