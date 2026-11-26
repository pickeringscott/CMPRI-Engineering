export const NWS_WEATHER_API = "https://api.weather.gov";
const PROPERTY_WEATHER_POINT = "40.138080,-88.251416";
const ALERT_SOURCE = `${NWS_WEATHER_API}/alerts/active?point=${PROPERTY_WEATHER_POINT}`;
const NWS_ARCHIVE_MS = 7 * 86_400_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function readAlertCollection(source: string, signal: AbortSignal, timeout: number) {
  try {
    const response = await fetch(source, {
      headers: { Accept: "application/geo+json", "User-Agent": "CMPRIWeatherPreview/1.0 (https://cmpri-engineering.com)" },
      cache: "no-store", credentials: "omit", redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) throw new Error("NWS returned HTTP " + response.status + (response.status >= 300 && response.status < 400 ? "; redirects are not followed." : "."));
    if (response.url) {
      const returned = new URL(response.url), requested = new URL(source);
      if (returned.origin !== requested.origin || returned.pathname !== requested.pathname || returned.username || returned.password
        || returned.hash || returned.searchParams.toString() !== requested.searchParams.toString()) {
        throw new Error("NWS returned an unverified response URL.");
      }
    }
    const data = record(await response.json());
    if (!data || !Array.isArray(data.features)) throw new Error("NWS returned no verifiable feature collection.");
    return { status: "live" as const, source, receivedAt: new Date().toISOString(), sourceTimestamp: null, data, error: null };
  } catch (error) {
    return { status: "unavailable" as const, source, receivedAt: new Date().toISOString(),
      sourceTimestamp: null, data: null, error: error instanceof Error ? error.message : "The official NWS request was unavailable." };
  }
}

export function readPropertyWeatherAlerts(signal: AbortSignal, timeout = 12_000) {
  return readAlertCollection(ALERT_SOURCE, signal, timeout);
}

function alertId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.split("/alerts/").at(-1) ?? "";
  try { return decodeURIComponent(id); } catch { return id; }
}

function alertTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function actual(properties: Record<string, unknown> | null) {
  return Boolean(properties && (properties.status == null || properties.status === "Actual"));
}

function isCancellation(properties: Record<string, unknown> | null) {
  return String(properties?.messageType).toLowerCase() === "cancel";
}

function referencedIds(references: unknown) {
  const items = Array.isArray(references) ? references : typeof references === "string" ? references.split(/\s+/) : [];
  return items.flatMap(item => typeof item === "string" ? item.split(/[,\s]+/) : [record(item)?.identifier, record(item)?.id])
    .map(alertId).filter(Boolean);
}

function identities(feature: Record<string, unknown> | null, properties: Record<string, unknown>) {
  return [feature?.id, properties.id, properties["@id"]].map(alertId).filter(Boolean);
}

function endTimes(properties: Record<string, unknown>) {
  return [alertTime(properties.expires), alertTime(properties.ends)].filter(time => time !== null);
}

/** A positive result lasts until the last verified active bulletin ends. */
export function propertyWeatherAlertStatus(data: unknown, now: number): { known: boolean; activeUntil: number } {
  const features = record(data)?.features;
  if (!Array.isArray(features)) return { known: false, activeUntil: 0 };
  const canceled = new Set<string>();
  for (const feature of features) {
    const properties = record(record(feature)?.properties);
    if (actual(properties) && isCancellation(properties)) referencedIds(properties?.references).forEach(id => canceled.add(id));
  }

  let known = true;
  let activeUntil = 0;
  for (const entry of features) {
    const feature = record(entry);
    const properties = record(feature?.properties);
    if (!properties) { known = false; continue; }
    if (isCancellation(properties) || !actual(properties) || identities(feature, properties).some(id => canceled.has(id))) continue;
    const effective = alertTime(properties.effective);
    if (effective !== null && effective > now) continue;
    const times = endTimes(properties);
    if (!times.length) { known = false; continue; }
    const finish = Math.min(...times);
    if (finish > now) activeUntil = Math.max(finish, activeUntil);
  }
  return { known: known || activeUntil > now, activeUntil };
}

/** Replay the bounded point archive after a gap in live reads. Null means the gap could not be verified. */
export async function readPropertyWeatherAlertGap(from: number, until: number, signal: AbortSignal, timeout: number): Promise<boolean | null> {
  const start = Math.max(from, until - NWS_ARCHIVE_MS + 60_000);
  const parameters = new URLSearchParams({ point: PROPERTY_WEATHER_POINT, start: new Date(start).toISOString(),
    end: new Date(until).toISOString(), status: "actual", limit: "200" });
  const { data } = await readAlertCollection(`${NWS_WEATHER_API}/alerts?${parameters}`, signal, timeout);
  if (!Array.isArray(data?.features)) return null;
  const canceled = new Map<string, number>();
  for (const entry of data.features) {
    const properties = record(record(entry)?.properties);
    if (!actual(properties) || !isCancellation(properties)) continue;
    const time = alertTime(properties?.sent) ?? alertTime(properties?.effective);
    if (time !== null) for (const id of referencedIds(properties?.references)) canceled.set(id, Math.min(canceled.get(id) ?? Infinity, time));
  }
  let complete = !record(data.pagination)?.next && start === from;
  for (const entry of data.features) {
    const feature = record(entry), properties = record(feature?.properties);
    if (!properties) { complete = false; continue; }
    if (!actual(properties) || isCancellation(properties)) continue;
    const begins = alertTime(properties.effective) ?? alertTime(properties.sent);
    const ends = endTimes(properties);
    if (begins === null || !ends.length) { complete = false; continue; }
    const end = Math.min(...ends, ...identities(feature, properties).map(id => canceled.get(id) ?? Infinity));
    if (Math.max(begins, from) < Math.min(end, until)) return true;
  }
  return complete ? false : null;
}
