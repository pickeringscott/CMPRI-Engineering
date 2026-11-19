/** Fixed public USGS tiles for the isolated preview. No CMPRI data or credentials. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const DATASETS = {
  topo: { service: "USGSTopo", attribution: "USGS The National Map · topographic reference data" },
  imagery: { service: "USGSImageryOnly", attribution: "USGS The National Map · USDA/NAIP orthoimagery · acquisition dates vary" },
  relief: { service: "USGSShadedReliefOnly", attribution: "USGS The National Map · 3DEP / GMTED2010 shaded relief" },
} as const;
const MAX_BYTES = 2 * 1024 * 1024;
const ERROR_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };
const TILE_HEADERS = { ...ERROR_HEADERS, "Cache-Control": "public, max-age=3600, s-maxage=86400" };

function fail(status: number, message: string) {
  return Response.json({ unavailable: true, error: { code: status, message } }, { status, headers: ERROR_HEADERS });
}

function integer(value: string | null) {
  return value !== null && /^(0|[1-9]\d*)$/.test(value) && value.length <= 8 ? Number(value) : null;
}

async function limitedBody(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Tile exceeds preview size limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error("Tile exceeds preview size limit"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function GET(request: Request) {
  if (process.env.VERCEL_ENV === "production"
    || (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV !== "development")) {
    return new Response("Not found.", { status: 404, headers: ERROR_HEADERS });
  }
  if (request.method !== "GET") return fail(405, "Only GET is supported");
  const url = new URL(request.url);
  if (request.url.length > 8192 || ["dataset", "z", "x", "y"].some((key) => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.getAll("format").length > 1) return fail(400, "One fixed dataset and valid tile coordinates are required");
  const dataset = url.searchParams.get("dataset");
  if (!dataset || !Object.hasOwn(DATASETS, dataset)) return fail(400, "Unknown USGS dataset");
  const z = integer(url.searchParams.get("z"));
  const x = integer(url.searchParams.get("x"));
  const y = integer(url.searchParams.get("y"));
  const format = url.searchParams.get("format");
  if (z === null || x === null || y === null || z > 16 || x >= 2 ** z || y >= 2 ** z
    || (format !== null && format !== "json" && format !== "image")) return fail(400, "Invalid USGS tile coordinates or format");
  const selected = DATASETS[dataset as keyof typeof DATASETS];
  // Outer preview-sharing parameters are deliberately ignored, never forwarded.
  const source = `https://basemap.nationalmap.gov/arcgis/rest/services/${selected.service}/MapServer/tile/${z}/${y}/${x}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 12000);
  try {
    const upstream = await fetch(source, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      signal: controller.signal, headers: { Accept: "image/png,image/jpeg", "User-Agent": "CMPRI-Weather-Preview/1.0" } });
    if (!upstream.ok) { controller.abort(); return fail(upstream.status >= 400 ? upstream.status : 502, "USGS ground tile is unavailable"); }
    const bytes = await limitedBody(upstream);
    const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const contentType = png && type === "image/png" ? "image/png"
      : jpeg && (type === "image/jpeg" || type === "image/jpg") ? "image/jpeg" : null;
    if (!contentType) return fail(502, "USGS tile returned an unsupported image response");
    if (format === "json") {
      return Response.json({ source, contentType, bytes: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"), attribution: selected.attribution }, { headers: TILE_HEADERS });
    }
    return new Response(bytes, { headers: { ...TILE_HEADERS, "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength), "X-USGS-Dataset": dataset } });
  } catch {
    const canceled = controller.signal.aborted;
    controller.abort();
    return fail(canceled ? 504 : 502, canceled ? "USGS tile request timed out or was canceled" : "USGS ground tile is unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
  }
}
