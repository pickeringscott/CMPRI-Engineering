/** Read-only NOAA map transport for the isolated Weather branch preview.
 * No session, CMPRI API, database, storage, scheduler, or notification access. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const NOAA_ORIGIN = "https://mapservices.weather.noaa.gov";
const RADAR_PATH = "/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer";
const WSSI_PATH = "/vector/rest/services/outlooks/wpc_wssi/MapServer/4";
const MAX_URL_LENGTH = 8192;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const OUTPUT_IMAGE = /^\/(?:eventdriven|vector|arcgis)\/rest\/directories\/arcgisoutput\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.png$/i;
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};
const QUERY_PARAMETERS = new Set([
  "f", "where", "geometry", "geometryType", "inSR", "outSR", "spatialRel",
  "outFields", "returnGeometry", "orderByFields", "resultRecordCount", "resultOffset",
]);
const EXPORT_PARAMETERS = new Set([
  "f", "bbox", "bboxSR", "imageSR", "size", "format", "transparent", "mosaicRule",
]);

function previewEnabled() {
  return process.env.VERCEL_ENV !== "production"
    && (process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "development");
}

function unavailable(status: number, message: string) {
  return Response.json({ error: { code: status, message }, unavailable: true }, {
    status, headers: HEADERS,
  });
}

function validateSource(raw: string | null): { url: URL; image: boolean } | null {
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== NOAA_ORIGIN || url.username || url.password || url.hash
    || url.pathname.includes("%") || /[\u0000-\u001f]/.test(raw)) return null;
  if (OUTPUT_IMAGE.test(url.pathname)) return url.search ? null : { url, image: true };
  const metadata = url.pathname === RADAR_PATH || url.pathname === WSSI_PATH;
  // Only the fixed radar service's published legend is readable. Its symbols
  // must come from NOAA; a generic reflectivity palette is not interchangeable.
  const legend = url.pathname === RADAR_PATH + "/legend";
  const query = url.pathname === RADAR_PATH + "/query" || url.pathname === WSSI_PATH + "/query";
  const rasterExport = url.pathname === RADAR_PATH + "/exportImage";
  if (!metadata && !legend && !query && !rasterExport) return null;
  const outputFormat = url.searchParams.get("f");
  if (rasterExport ? outputFormat !== "json" && outputFormat !== "image" : outputFormat !== "json") return null;
  const allowed = metadata || legend ? new Set(["f"]) : query ? QUERY_PARAMETERS : EXPORT_PARAMETERS;
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  if (query) {
    const count = Number(url.searchParams.get("resultRecordCount") || "1000");
    if (!Number.isInteger(count) || count < 1 || count > 1000) return null;
  }
  if (rasterExport) {
    if (url.searchParams.get("format") !== "png32" || url.searchParams.get("bboxSR") !== "3857"
      || url.searchParams.get("imageSR") !== "3857") return null;
    const size = (url.searchParams.get("size") || "").split(",").map(Number);
    if (size.length !== 2 || size.some((value) => !Number.isInteger(value) || value < 1 || value > 1500)) return null;
    const bbox = (url.searchParams.get("bbox") || "").split(",").map(Number);
    if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value) || Math.abs(value) > 30000000)
      || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
    try {
      const mosaic = JSON.parse(url.searchParams.get("mosaicRule") || "null");
      if (!mosaic || mosaic.mosaicMethod !== "esriMosaicLockRaster" || mosaic.mosaicOperation !== "MT_FIRST"
        || !Array.isArray(mosaic.lockRasterIds) || mosaic.lockRasterIds.length < 1 || mosaic.lockRasterIds.length > 20
        || mosaic.lockRasterIds.some((id: unknown) => typeof id !== "number" || !Number.isInteger(id) || id < 0)
        || Object.keys(mosaic).some((key) => !["mosaicMethod", "mosaicOperation", "lockRasterIds"].includes(key))) return null;
    } catch { return null; }
  }
  return { url, image: rasterExport && outputFormat === "image" };
}

async function readLimited(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("Weather source response exceeds preview size limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Weather source response exceeds preview size limit");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function GET(request: Request) {
  if (!previewEnabled()) return new Response("Not found.", { status: 404, headers: HEADERS });
  if (request.method !== "GET") return unavailable(405, "Only GET is supported");
  const requestUrl = new URL(request.url);
  if (request.url.length > MAX_URL_LENGTH * 2
    || requestUrl.searchParams.getAll("url").length !== 1) {
    return unavailable(400, "A single allowlisted NOAA map URL is required");
  }
  const source = validateSource(requestUrl.searchParams.get("url"));
  if (!source) return unavailable(400, "This NOAA map resource is not allowed in the preview");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, TIMEOUT_MS);
  try {
    const upstream = await fetch(source.url.href, {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      signal: controller.signal,
      headers: { Accept: source.image ? "image/png" : "application/json", "User-Agent": "CMPRI-Weather-Preview/1.0" },
    });
    const bytes = await readLimited(upstream);
    if (source.image) {
      if (!upstream.ok) return unavailable(upstream.status >= 400 ? upstream.status : 502, "NOAA radar image is unavailable");
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!upstream.headers.get("content-type")?.toLowerCase().startsWith("image/png")
        || !pngSignature.every((value, index) => bytes[index] === value)) {
        return unavailable(502, "NOAA radar image returned an unsupported response");
      }
      return new Response(bytes, { status: upstream.status, headers: {
        ...HEADERS, "Content-Type": "image/png", "Content-Length": String(bytes.byteLength),
      } });
    }
    const text = new TextDecoder().decode(bytes);
    try {
      const data: unknown = JSON.parse(text);
      if (data === null || typeof data !== "object") throw new Error("Invalid map response");
    } catch {
      return unavailable(upstream.status >= 400 ? upstream.status : 502, "NOAA map source did not return JSON");
    }
    return new Response(text, { status: upstream.status, headers: {
      ...HEADERS, "Content-Type": "application/json; charset=utf-8",
    } });
  } catch {
    return unavailable(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? "NOAA map request timed out or was canceled" : "NOAA map source is unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
  }
}
