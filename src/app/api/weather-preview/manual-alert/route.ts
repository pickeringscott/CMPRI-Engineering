import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getCache, type RuntimeCache } from "@vercel/functions";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { profileIsChiefEngineerOrSystemAdmin } from "@/lib/server/roles";
import { parseWeatherManualAlert, type WeatherManualAlert } from "@/lib/weather/manual-alert";
import { isHostedWeatherPreview, isManualWeatherPreview } from "@/lib/weather/manual-alert-preview";
import { propertyWeatherAlertStatus, readPropertyWeatherAlertGap, readPropertyWeatherAlerts } from "@/lib/weather/property-alerts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "iad1";
export const maxDuration = 40;

const CACHE_NAMESPACE = "cmpri-engineering-pr69-weather-v1";
const OFFICIAL_REFRESH_MS = 25_000;
const OFFICIAL_ERROR_RETRY_MS = 10_000;
const OFFICIAL_PUBLISH_MAX_AGE_MS = 5_000;
const OFFICIAL_REQUEST_TIMEOUT_MS = 5_000;
const OFFICIAL_READ_GAP_MS = 65_000;
const WAIT_MS = 20_000;
const POLL_MS = 1_250;
const MAX_PAYLOAD_BYTES = 16_384;

type Published = { revision: string; publishedAt: number; alert: WeatherManualAlert };
type OfficialReading = { checkedAt: number; coveredAt: number; activeUntil: number; known: boolean };
type OfficialStatus = "active" | "clear" | "unavailable";
type Snapshot = { alert: WeatherManualAlert | null; publicationId: string | null; revision: string; nwsActive: boolean; nwsStatus: OfficialStatus };
let officialCheck: Promise<OfficialReading> | null = null;

function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } });
}

async function access(request: NextRequest, write = false) {
  if (!isManualWeatherPreview()) {
    return response({ error: "Weather alert delivery is unavailable on this deployment." }, 404);
  }
  if (/^Bearer\s+cmpri_mcp_/i.test(request.headers.get("authorization") ?? "")) {
    return response({ error: "Sign in to CMPRI to use Weather alerts." }, 401);
  }
  const auth = await requireUser(request);
  if (!auth) return response({ error: "Sign in to CMPRI to use Weather alerts." }, 401);
  if (write && !profileIsChiefEngineerOrSystemAdmin(auth.principal.profile)) {
    return response({ error: "Only the Chief Engineer and System Admin can publish or delete Weather alerts." }, 403);
  }
  return getCache({ namespace: `${CACHE_NAMESPACE}${isHostedWeatherPreview() ? "" : "-local"}-${auth.principal.hotelId}` });
}

function ttl(until: number) {
  return Math.max(1, Math.ceil((until - Date.now()) / 1000));
}

async function coverOfficialGap(cache: RuntimeCache, coveredAt: number, now: number, signal: AbortSignal) {
  if (now - coveredAt <= OFFICIAL_READ_GAP_MS) return now;
  const publication = await cache.get("published") as Published | null;
  if (!publication || !parseWeatherManualAlert(publication.alert) || await cache.get(removalKey(publication.revision))) return now;
  const from = Math.max(publication.publishedAt, coveredAt);
  if (now - from <= OFFICIAL_READ_GAP_MS) return now;
  const occurred = await readPropertyWeatherAlertGap(from, now, signal, OFFICIAL_REQUEST_TIMEOUT_MS);
  if (occurred === null) return from;
  if (occurred) await removePublished(cache, publication);
  return now;
}

async function currentOfficial(cache: RuntimeCache, publishing = false): Promise<OfficialStatus> {
  const previous = await cache.get("nws") as OfficialReading | null;
  const now = Date.now();
  const maxAge = publishing ? OFFICIAL_PUBLISH_MAX_AGE_MS : previous?.known ? OFFICIAL_REFRESH_MS : OFFICIAL_ERROR_RETRY_MS;
  const fresh = previous && now - previous.checkedAt < maxAge && (!previous.activeUntil || previous.activeUntil > now);
  const reading = fresh ? previous : await (officialCheck ??= (async () => {
    // Share the request across readers. A single disconnected browser must not cancel it.
    const signal = new AbortController().signal;
    const result = await readPropertyWeatherAlerts(signal, OFFICIAL_REQUEST_TIMEOUT_MS);
    const observed = propertyWeatherAlertStatus(result.data, now);
    const latest = await cache.get("nws") as OfficialReading | null;
    if (latest && latest.checkedAt > now) return latest;
    const coveredAt = (latest ?? previous)?.coveredAt ?? 0;
    const reading: OfficialReading = {
      checkedAt: now,
      known: observed.known,
      activeUntil: observed.known ? observed.activeUntil : (latest ?? previous)?.activeUntil ?? 0,
      coveredAt: !observed.known ? coveredAt : observed.activeUntil ? now : await coverOfficialGap(cache, coveredAt, now, signal),
    };
    // Retain the last verified active end time during a later source outage.
    await cache.set("nws", reading, { ttl: Math.max(120, ttl(reading.activeUntil)) });
    return reading;
  })().finally(() => { officialCheck = null; }));
  if (reading.activeUntil > Date.now()) return "active";
  return reading.known && !reading.activeUntil ? "clear" : "unavailable";
}

function removalKey(revision: string) { return `removed:${revision}`; }

async function removePublished(cache: RuntimeCache, publication: Published) {
  // Only invalidate the revision we observed. A later publication can race this operation.
  await cache.set(removalKey(publication.revision), true, { ttl: ttl(publication.alert.expires) });
}

async function snapshot(cache: RuntimeCache, nwsStatus: OfficialStatus): Promise<Snapshot> {
  const publication = await cache.get("published") as Published | null;
  let alert = publication ? parseWeatherManualAlert(publication.alert) : null;
  if (publication && alert) {
    if (await cache.get(removalKey(publication.revision))) alert = null;
    else if (nwsStatus === "active") {
      await removePublished(cache, publication);
      alert = null;
    }
  }
  const publicationId = alert && publication ? publication.revision : null;
  const revision = `${publicationId ?? "none"}:${nwsStatus}`;
  return { alert, publicationId, revision, nwsStatus, nwsActive: nwsStatus === "active" };
}

function unavailable() {
  return response({ error: "Preview Weather alert delivery is temporarily unavailable." }, 503);
}

export async function GET(request: NextRequest) {
  const cache = await access(request);
  if (cache instanceof Response) return cache;
  const since = new URL(request.url).searchParams.get("revision");
  if (since !== null && !/^[A-Za-z0-9:-]{1,100}$/.test(since)) return response({ error: "Invalid Weather alert revision." }, 400);
  const deadline = Date.now() + WAIT_MS;
  try {
    for (;;) {
      const state = await snapshot(cache, await currentOfficial(cache));
      if (since !== state.revision || Date.now() >= deadline) return response(state);
      await delay(Math.min(POLL_MS, deadline - Date.now()), undefined, { signal: request.signal });
    }
  } catch { return request.signal.aborted ? new Response(null, { status: 499, headers: { "Cache-Control": "no-store" } }) : unavailable(); }
}

async function readAlert(request: NextRequest) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return parseWeatherManualAlert(JSON.parse(body + decoder.decode()));
      bytes += value.byteLength;
      if (bytes > MAX_PAYLOAD_BYTES) { await reader.cancel(); return null; }
      body += decoder.decode(value, { stream: true });
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export async function POST(request: NextRequest) {
  const cache = await access(request, true);
  if (cache instanceof Response) return cache;
  const alert = await readAlert(request);
  if (!alert || (!alert.custom && !alert.override)) {
    return response({ error: "Provide a valid banner or radar wallpaper and a future expiration." }, 400);
  }
  try {
    const nwsStatus = await currentOfficial(cache, true);
    if (nwsStatus === "active") {
      const state = await snapshot(cache, nwsStatus);
      return response({ ...state, error: "An active NWS alert takes precedence over Property Advisory." }, 409);
    }
    if (nwsStatus === "unavailable") return response({ error: "NWS alert status could not be verified. Try publishing again when it is available." }, 503);
    if (alert.expires <= Date.now()) return response({ error: "Choose a future expiration." }, 400);
    const publication: Published = { revision: randomUUID(), publishedAt: Date.now(), alert };
    await cache.set("published", publication, { ttl: ttl(alert.expires) });
    const state = await snapshot(cache, await currentOfficial(cache));
    return state.nwsActive ? response({ ...state, error: "An active NWS alert takes precedence over Property Advisory." }, 409) : response(state);
  } catch { return unavailable(); }
}

export async function DELETE(request: NextRequest) {
  const cache = await access(request, true);
  if (cache instanceof Response) return cache;
  try {
    const publication = await cache.get("published") as Published | null;
    if (publication && parseWeatherManualAlert(publication.alert)) await removePublished(cache, publication);
    return response(await snapshot(cache, await currentOfficial(cache)));
  } catch { return unavailable(); }
}
