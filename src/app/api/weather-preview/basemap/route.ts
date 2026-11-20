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
  // Route shields are positioned locally from official route geometry. Export
  // linework only, so provider-rendered shields cannot repeat underneath them.
  roads: { source: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer", layers: "8,9,29,30", attribution: "USGS The National Map · National Transportation Dataset" },
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

async function limitedBody(response: Response, account?: (bytes: number) => void) {
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
      account?.(part.value.byteLength);
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
  if (!dataset || !["tile", "metadata", "reference", "place-labels", "route-features"].includes(operation)
    || (format !== null && format !== "json" && format !== "image")) return fail(400, "Unknown USGS dataset, operation or format");
  let source: string, attribution: string;
  let routeSources: string[] | null = null;
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
  } else if (operation === "route-features") {
    const z = integer(url.searchParams.get("z"));
    if (dataset !== "roads" || z === null || z > 16
      || ["x", "y", "width", "height"].some((key) => url.searchParams.has(key))
      || format === "image") return fail(400, "Route features accept only the fixed roads dataset, zoom and map extent");
    const parts = (url.searchParams.get("bbox") || "").split(","), bbox = parts.map(Number);
    if (bbox.length !== 4 || parts.some((part) => !part.trim()) || bbox.some((value) => !Number.isFinite(value) || Math.abs(value) > 20037509)
      || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || bbox[2] - bbox[0] > 4000000 || bbox[3] - bbox[1] > 4000000) return fail(400, "A bounded Web Mercator route extent no wider than 4000 km is required");
    // The official 1M-scale route layer supplies generalized wide-view geometry.
    // Detailed Interstate, US and State layers are separate sources; querying
    // all three avoids assuming an Interstate label layer contains local routes.
    const layers = z <= 9 ? [9] : [16, 17, 18];
    const fields = z <= 9 ? "OBJECTID,INTERSTATE,US_ROUTE,ST_ROUTE,NAME"
      : "OBJECTID,permanent_identifier,interstate,us_route,state_route,interstate_a,interstate_b,interstate_c,us_route_a,us_route_b,us_route_c,state_route_a,state_route_b,state_route_c,name";
    routeSources = layers.map((layer) => {
      const routeFields = layer === 9 ? z <= 7 ? ["INTERSTATE"] : z <= 8 ? ["INTERSTATE", "US_ROUTE"] : ["INTERSTATE", "US_ROUTE", "ST_ROUTE"]
        : layer === 16 ? ["interstate", "interstate_a", "interstate_b", "interstate_c"]
          : layer === 17 ? ["us_route", "us_route_a", "us_route_b", "us_route_c"]
            : ["state_route", "state_route_a", "state_route_b", "state_route_c"];
      return REFERENCES.roads.source + "/" + layer + "/query?" + new URLSearchParams({
        // Generalized data uses a single space for an absent route number.
        // Broad extents prioritize major routes instead of truncating state roads.
        f: "geojson", where: routeFields.map((field) => "(" + field + " IS NOT NULL AND " + field + " NOT IN ('', ' '))").join(" OR "),
        outFields: fields, returnGeometry: "true", returnM: "false", geometryPrecision: "6",
        maxAllowableOffset: String(Math.max(0.000001, Math.min(0.01, 156543.033928 / 2 ** z / 111319.490793 / 2))),
        geometry: JSON.stringify({ xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3], spatialReference: { wkid: 3857 } }),
        geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "3857", outSR: "4326", resultRecordCount: "2000"
      }).toString();
    });
    source = routeSources[0]; attribution = REFERENCES.roads.attribution;
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
    if (routeSources) {
      let bytesRead = 0;
      const results = await Promise.all(routeSources.map(async (routeSource) => {
        const upstream = await fetch(routeSource, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
          signal: controller.signal, headers: { Accept: "application/geo+json,application/json", "User-Agent": "CMPRI-Weather-Preview/1.0" } });
        if (!upstream.ok) throw new Error("USGS route features are unavailable");
        const bytes = await limitedBody(upstream, (count) => {
          bytesRead += count;
          if (bytesRead > MAX_BYTES) throw new Error("Combined route features exceed preview size limit");
        });
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (!data || data.error || data.type !== "FeatureCollection" || !Array.isArray(data.features)
          || data.features.length > 2000 || data.exceededTransferLimit
          || data.features.some((feature: { type?: string; geometry?: { type?: string }; properties?: unknown }) => feature?.type !== "Feature"
            || !["LineString", "MultiLineString"].includes(feature.geometry?.type || "") || !feature.properties || typeof feature.properties !== "object")) throw new Error("USGS route features are invalid or incomplete");
        return data.features;
      }));
      return Response.json({ source, sources: routeSources, attribution, receivedAt: new Date().toISOString(),
        data: { type: "FeatureCollection", features: results.flat() }, error: null }, { headers: ERROR_HEADERS });
    }
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
