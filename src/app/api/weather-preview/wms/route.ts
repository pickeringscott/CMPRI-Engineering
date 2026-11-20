/** Read-only Weather transport for fixed official NCEP WMS services.
 * Layer/style/time choices must come from their actual capabilities documents.
 * No CMPRI session, database, API key, GPS, push, or scheduler is used. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const SOURCES = {
  reflectivity: "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows",
  velocity: "https://opengeo.ncep.noaa.gov/geoserver/kilx/ows",
  precipitation: "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_pcpn_typ/ows",
} as const;
type Product = keyof typeof SOURCES;
type Dimension = { units: string | null; default: string | null; current: boolean; values: string };
type Style = { name: string; title: string; legendUrl: string | null };
type Layer = { name: string; title: string; crs: string[]; time: Dimension | null; styles: Style[] };
type Capabilities = {
  product: Product; source: string; checkedAt: string; version: string;
  layers: Layer[]; mapFormats: string[]; legendSupported: boolean; xml: string;
};
type XmlNode = { name: string; attributes: Record<string, string>; text: string; children: XmlNode[] };
const metadataCache = new Map<Product, { at: number; value: Capabilities }>();
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const METADATA_TTL_MS = 5 * 60000;
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };
const ALLOWED_PARAMETERS = new Set(["product", "op", "layer", "style", "time", "bbox", "width", "height", "format"]);

function unavailable(status: number, message: string) {
  return Response.json({ unavailable: true, error: { code: status, message } }, { status, headers: HEADERS });
}
function decode(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (!code.startsWith("#")) return names[code.toLowerCase()] || whole;
    const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}
function clean(value: string) { return decode(value).replace(/\s+/g, " ").trim(); }
function children(value: XmlNode, name: string) { return value.children.filter((child) => child.name === name); }
function child(value: XmlNode, name: string) { return children(value, name)[0]; }
function content(value: XmlNode | undefined) { return value ? clean(value.text) : ""; }

// A bounded XML tree reader, not an XML entity resolver. Official capabilities
// are data only: DTD/entity declarations are rejected and no URLs are followed.
function parseXml(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("WMS capabilities contain unsupported XML declarations");
  const document: XmlNode = { name: "document", attributes: {}, text: "", children: [] };
  const stack = [document]; let nodes = 0;
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) { stack[stack.length - 1].text += token.slice(9, -3); continue; }
    if (!token.startsWith("<")) { stack[stack.length - 1].text += token; continue; }
    const match = /^<\s*(\/?)\s*([A-Za-z_][\w:.-]*)([\s\S]*?)>$/.exec(token);
    if (!match) throw new Error("Malformed WMS capabilities XML");
    const name = match[2].split(":").pop() || "";
    if (match[1]) {
      if (stack.length < 2 || stack[stack.length - 1].name !== name) throw new Error("Unbalanced WMS capabilities XML");
      stack.pop(); continue;
    }
    if (++nodes > 30000 || stack.length > 64) throw new Error("WMS capabilities XML exceeds structural limits");
    const attributes: Record<string, string> = {};
    for (const attribute of match[3].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attribute[1].toLowerCase()] = clean(attribute[2] ?? attribute[3]);
    }
    const current: XmlNode = { name, attributes, text: "", children: [] };
    stack[stack.length - 1].children.push(current);
    if (!/\/\s*>$/.test(token)) stack.push(current);
  }
  if (stack.length !== 1 || document.children.length !== 1) throw new Error("Incomplete WMS capabilities XML");
  return document.children[0];
}
function parseCapabilities(product: Product, source: string, xml: string): Capabilities {
  const root = parseXml(xml);
  if (root.name !== "WMS_Capabilities" || root.attributes.version !== "1.3.0") throw new Error("Official source did not return WMS 1.3.0 capabilities");
  const capability = child(root, "Capability");
  const request = capability && child(capability, "Request");
  const map = request && child(request, "GetMap");
  const layers: Layer[] = [];
  function walk(layer: XmlNode, parent: { crs: string[]; time: Dimension | null; styles: Style[] }) {
    const crs = Array.from(new Set(parent.crs.concat(children(layer, "CRS").map(content)))).filter(Boolean);
    let time = parent.time;
    const timeDimension = children(layer, "Dimension").find((dimension) => dimension.attributes.name?.toLowerCase() === "time");
    const timeExtent = children(layer, "Extent").find((extent) => extent.attributes.name?.toLowerCase() === "time");
    if (timeDimension || timeExtent) {
      const dimension = timeExtent || timeDimension!;
      time = { units: timeDimension?.attributes.units || time?.units || null,
        default: dimension.attributes.default || timeDimension?.attributes.default || null,
        current: dimension.attributes.current === "1" || timeDimension?.attributes.current === "1",
        values: content(dimension) };
    }
    const styles = new Map(parent.styles.map((style) => [style.name, style]));
    children(layer, "Style").forEach((style) => {
      const name = content(child(style, "Name")); if (!name) return;
      const legend = child(style, "LegendURL"); const online = legend && child(legend, "OnlineResource");
      styles.set(name, { name, title: content(child(style, "Title")),
        legendUrl: online?.attributes["xlink:href"] || online?.attributes.href || null });
    });
    const inherited = { crs, time, styles: Array.from(styles.values()) };
    const name = content(child(layer, "Name"));
    if (name) layers.push({ name, title: content(child(layer, "Title")), ...inherited });
    if (layers.length > 200) throw new Error("WMS service returned too many named layers");
    children(layer, "Layer").forEach((nested) => walk(nested, inherited));
  }
  if (capability) children(capability, "Layer").forEach((layer) => walk(layer, { crs: [], time: null, styles: [] }));
  if (!layers.length || !map) throw new Error("No named WMS map layers were advertised");
  return { product, source, checkedAt: new Date().toISOString(), version: "1.3.0", layers,
    mapFormats: children(map, "Format").map(content),
    legendSupported: Boolean(request && child(request, "GetLegendGraphic")) || layers.some((layer) => layer.styles.some((style) => style.legendUrl)), xml };
}
async function bytes(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("WMS response exceeds 2 MiB limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error("WMS response exceeds 2 MiB limit"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function sourceUrl(product: Product, parameters: Record<string, string>) {
  const url = new URL(SOURCES[product]); url.search = new URLSearchParams(parameters).toString(); return url.href;
}
async function fetchSource(url: string, image: boolean, signal: AbortSignal) {
  const response = await fetch(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal,
    headers: { Accept: image ? "image/png" : "application/xml,text/xml", "User-Agent": "CMPRI-Weather-Preview/1.0" } });
  if (!response.ok) throw new Error("Official WMS returned HTTP " + response.status);
  const data = await bytes(response);
  if (image) {
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/png")
      || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value)) throw new Error("Official WMS did not return a valid PNG image");
  }
  return data;
}
async function capabilities(product: Product, signal: AbortSignal) {
  const cached = metadataCache.get(product);
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.value;
  const source = sourceUrl(product, { service: "WMS", version: "1.3.0", request: "GetCapabilities" });
  const xml = new TextDecoder().decode(await fetchSource(source, false, signal));
  const value = parseCapabilities(product, source, xml);
  metadataCache.set(product, { at: Date.now(), value }); return value;
}
function duration(value: string) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const milliseconds = ((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0)) * 1000;
  return milliseconds > 0 ? milliseconds : null;
}
function validTime(time: string, dimension: Dimension | null) {
  if (!dimension || time.length > 80 || /[\u0000-\u001f]/.test(time)) return false;
  if (time === "current") return dimension.current || dimension.default === "current";
  const target = Date.parse(time); if (!Number.isFinite(target)) return false;
  return dimension.values.split(",").some((entry) => {
    const parts = entry.trim().split("/");
    if (parts.length === 1) return Number.isFinite(Date.parse(parts[0])) && target === Date.parse(parts[0]);
    const start = Date.parse(parts[0]), end = Date.parse(parts[1]);
    if (parts.length > 3 || !Number.isFinite(start) || !Number.isFinite(end) || target < start || target > end) return false;
    if (parts.length === 2) return true;
    const step = duration(parts[2]);
    return step !== null && Math.abs((target - start) / step - Math.round((target - start) / step)) < 1e-8;
  }) || Boolean(dimension.default && time === dimension.default);
}

export async function GET(request: Request) {
  if (request.method !== "GET") return unavailable(405, "Only GET is supported");
  const query = new URL(request.url).searchParams;
  if (request.url.length > 8192) return unavailable(400, "WMS request is too long");
  // Preview connectors may append sharing metadata. Ignore unknown outer keys;
  // upstream URLs are constructed below from meaningful, validated values only.
  for (const key of ALLOWED_PARAMETERS) if (query.getAll(key).length > 1) return unavailable(400, "Duplicate WMS parameter");
  const productValue = query.get("product"), op = query.get("op");
  if (!productValue || !Object.prototype.hasOwnProperty.call(SOURCES, productValue) || !["capabilities", "map", "legend"].includes(op || "")) return unavailable(400, "Choose reflectivity, velocity or precipitation and a supported WMS operation");
  const format = query.get("format");
  if (format !== null && format !== "json" && format !== "image") return unavailable(400, "Choose image or JSON inspection format");
  const product = productValue as Product;
  const bboxParts = (query.get("bbox") || "").split(",");
  const bbox = bboxParts.map(Number);
  const width = Number(query.get("width")), height = Number(query.get("height"));
  if (op === "map" && (bbox.length !== 4 || bboxParts.some((part) => !part.trim()) || bbox.some((value) => !Number.isFinite(value) || Math.abs(value) > 20037509)
    || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > 1500 || height > 1500)) return unavailable(400, "A bounded Web Mercator bbox and 1–1500 pixel dimensions are required");
  if (op !== "capabilities" && (!query.get("layer") || query.get("layer")!.length > 240 || /[\u0000-\u001f]/.test(query.get("layer")!))) return unavailable(400, "An advertised layer name is required");
  if (op === "capabilities" && ["layer", "style", "time", "bbox", "width", "height"].some((key) => query.has(key))) return unavailable(400, "Capabilities requests accept only product and operation");
  if (op === "capabilities" && format !== null) return unavailable(400, "Capabilities are already JSON and accept no inspection format");
  if (op === "legend" && ["bbox", "width", "height", "time"].some((key) => query.has(key))) return unavailable(400, "Legend requests accept only an advertised layer and optional style");
  const controller = new AbortController();
  const abort = () => controller.abort(); request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const metadata = await capabilities(product, controller.signal);
    if (op === "capabilities") return Response.json(metadata, { headers: HEADERS });
    const layer = metadata.layers.find((candidate) => candidate.name === query.get("layer"));
    if (!layer) return unavailable(400, "Layer was not advertised by this official WMS service");
    const style = query.get("style") || "";
    if (style && !layer.styles.some((candidate) => candidate.name === style)) return unavailable(400, "Style was not advertised for this WMS layer");
    const time = query.get("time");
    if (time && !validTime(time, layer.time)) return unavailable(400, "Time was not advertised by the official WMS layer");
    if (!metadata.mapFormats.some((format) => format.toLowerCase() === "image/png")) return unavailable(502, "Official WMS does not advertise PNG maps");
    if (op === "map" && !layer.crs.some((crs) => crs.toUpperCase() === "EPSG:3857")) return unavailable(502, "Official WMS layer does not advertise EPSG:3857");
    if (op === "legend" && !metadata.legendSupported) return unavailable(502, "Official WMS does not advertise a legend");
    const parameters: Record<string, string> = op === "map" ? {
      SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap", LAYERS: layer.name, STYLES: style,
      CRS: "EPSG:3857", BBOX: bbox.join(","), WIDTH: String(width), HEIGHT: String(height), FORMAT: "image/png", TRANSPARENT: "TRUE",
    } : { SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetLegendGraphic", LAYER: layer.name, STYLE: style, FORMAT: "image/png" };
    if (time) parameters.TIME = time;
    const source = sourceUrl(product, parameters);
    const image = await fetchSource(source, true, controller.signal);
    // Inspection changes only the response envelope, never the fixed upstream
    // PNG request. The exact validated bytes can be reviewed without corruption
    // by tools that otherwise decode binary bodies as text.
    if (format === "json") return Response.json({ source, contentType: "image/png", bytes: image.byteLength,
      base64: Buffer.from(image).toString("base64"), time: time || "source-default" }, { headers: HEADERS });
    return new Response(image, { headers: { ...HEADERS, "Content-Type": "image/png", "Content-Length": String(image.byteLength),
      "X-Weather-Source": source, "X-Weather-Layer": layer.name,
      // An omitted TIME uses the source's current default. A cached metadata
      // default is not proof of the actual image's scan time.
      "X-Weather-Time": time || "source-default" } });
  } catch (error) {
    return unavailable(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? "Official WMS request timed out or was canceled" : error instanceof Error ? error.message : "Official WMS unavailable");
  } finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); }
}
