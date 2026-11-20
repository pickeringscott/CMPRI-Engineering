/** Fixed public USGS tiles for the isolated preview. No CMPRI data or credentials. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const DATASETS = {
  topo: { service: "USGSTopo", attribution: "USGS The National Map · topographic reference data" },
  imagery: { service: "USGSImageryOnly", attribution: "USGS The National Map · USDA/NAIP orthoimagery · acquisition dates vary" },
  relief: { service: "USGSShadedReliefOnly", attribution: "USGS The National Map · 3DEP / GMTED2010 shaded relief" },
} as const;
const REFERENCES = {
  // Published feature layers 8/9 and 29/30 keep major-road linework. Keep only
  // Interstate labels (16), omitting small-scale, US Route and State Route labels.
  roads: { source: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer", layers: "8,9,16,29,30", attribution: "USGS The National Map · National Transportation Dataset" },
  places: { source: "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer", layers: "1,2", attribution: "USGS The National Map · Geographic Names Information System" },
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
  if (request.url.length > 8192 || url.searchParams.getAll("dataset").length !== 1
    || ["op", "format", "z", "x", "y", "bbox", "width", "height"].some((key) => url.searchParams.getAll(key).length > 1)) return fail(400, "One fixed dataset and valid parameters are required");
  const dataset = url.searchParams.get("dataset");
  const operation = url.searchParams.get("op") || "tile";
  const format = url.searchParams.get("format");
  if (!dataset || !["tile", "metadata", "reference", "place-labels"].includes(operation)
    || (format !== null && format !== "json" && format !== "image")) return fail(400, "Unknown USGS dataset, operation or format");
  let source: string, attribution: string;
  if (operation === "metadata") {
    if (["z", "x", "y", "bbox", "width", "height"].some((key) => url.searchParams.has(key))
      || (format !== null && format !== "json")) return fail(400, "Metadata accepts only a fixed dataset");
    if (dataset === "imagery") {
      source = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=json";
      attribution = DATASETS.imagery.attribution;
    } else if (Object.hasOwn(REFERENCES, dataset)) {
      const selected = REFERENCES[dataset as keyof typeof REFERENCES];
      source = selected.source + "?f=json"; attribution = selected.attribution;
    } else return fail(400, "Unknown USGS metadata dataset");
  } else if (operation === "place-labels") {
    if (dataset !== "places" || ["z", "x", "y", "width", "height"].some((key) => url.searchParams.has(key))
      || format === "image") return fail(400, "Place labels accept only the fixed GNIS incorporated-place dataset and map extent");
    const parts = (url.searchParams.get("bbox") || "").split(","), bbox = parts.map(Number);
    if (bbox.length !== 4 || parts.some((part) => !part.trim()) || bbox.some((value) => !Number.isFinite(value) || Math.abs(value) > 20037509)
      || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return fail(400, "A bounded Web Mercator extent is required");
    source = REFERENCES.places.source + "/1/query?" + new URLSearchParams({ f: "geojson", where: "1=1", outFields: "*", returnGeometry: "true",
      geometry: JSON.stringify({ xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3], spatialReference: { wkid: 3857 } }),
      geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "3857", outSR: "4326", resultRecordCount: "1000" }).toString();
    attribution = REFERENCES.places.attribution;
  } else if (operation === "reference") {
    if (!Object.hasOwn(REFERENCES, dataset) || ["z", "x", "y"].some((key) => url.searchParams.has(key))) return fail(400, "Choose a fixed roads or places reference overlay");
    const parts = (url.searchParams.get("bbox") || "").split(",");
    const bbox = parts.map(Number), width = integer(url.searchParams.get("width")), height = integer(url.searchParams.get("height"));
    if (bbox.length !== 4 || parts.some((part) => !part.trim()) || bbox.some((value) => !Number.isFinite(value) || Math.abs(value) > 20037509)
      || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || width === null || height === null || width < 1 || height < 1 || width > 1500 || height > 1500) return fail(400, "A bounded Web Mercator extent and 1–1500 pixel dimensions are required");
    const selected = REFERENCES[dataset as keyof typeof REFERENCES];
    source = selected.source + "/export?" + new URLSearchParams({ f: "image", bbox: bbox.join(","), bboxSR: "3857", imageSR: "3857",
      size: width + "," + height, format: "png32", transparent: "true", layers: "show:" + selected.layers }).toString();
    attribution = selected.attribution;
  } else {
    if (!Object.hasOwn(DATASETS, dataset) || ["bbox", "width", "height"].some((key) => url.searchParams.has(key))) return fail(400, "Unknown USGS tile dataset or parameters");
    const z = integer(url.searchParams.get("z")), x = integer(url.searchParams.get("x")), y = integer(url.searchParams.get("y"));
    if (z === null || x === null || y === null || z > 16 || x >= 2 ** z || y >= 2 ** z) return fail(400, "Invalid USGS tile coordinates");
    const selected = DATASETS[dataset as keyof typeof DATASETS];
    source = `https://basemap.nationalmap.gov/arcgis/rest/services/${selected.service}/MapServer/tile/${z}/${y}/${x}`;
    attribution = selected.attribution;
  }
  // Outer preview-sharing parameters are deliberately ignored, never forwarded.
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 12000);
  try {
    const upstream = await fetch(source, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      signal: controller.signal, headers: { Accept: operation === "metadata" || operation === "place-labels" ? "application/json" : operation === "reference" ? "image/png" : "image/png,image/jpeg", "User-Agent": "CMPRI-Weather-Preview/1.0" } });
    if (!upstream.ok) { controller.abort(); return fail(upstream.status >= 400 ? upstream.status : 502, "USGS ground tile is unavailable"); }
    const bytes = await limitedBody(upstream);
    if (operation === "metadata" || operation === "place-labels") {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (!data || typeof data !== "object" || Array.isArray(data) || data.error) return fail(502, "USGS service metadata is unavailable");
      if (operation === "place-labels" && (data.type !== "FeatureCollection" || !Array.isArray(data.features) || data.exceededTransferLimit)) return fail(502, "USGS incorporated-place results are unavailable or incomplete");
      return Response.json({ source, receivedAt: new Date().toISOString(), data, error: null }, { headers: ERROR_HEADERS });
    }
    const type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const contentType = png && type === "image/png" ? "image/png"
      : operation !== "reference" && jpeg && (type === "image/jpeg" || type === "image/jpg") ? "image/jpeg" : null;
    if (!contentType) return fail(502, "USGS tile returned an unsupported image response");
    if (format === "json") {
      return Response.json({ source, contentType, bytes: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"), attribution }, { headers: TILE_HEADERS });
    }
    return new Response(bytes, { headers: { ...TILE_HEADERS, "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength), "X-USGS-Dataset": dataset, "X-USGS-Source": source } });
  } catch {
    const canceled = controller.signal.aborted;
    controller.abort();
    return fail(canceled ? 504 : 502, canceled ? "USGS tile request timed out or was canceled" : "USGS ground tile is unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
  }
}
