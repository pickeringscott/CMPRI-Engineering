/** Temporary branch-only transport proof for fixed public tracker sources. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const SOURCES = {
  compact: "https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9&compact=1",
  standard: "https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9",
  widget: "https://avioadsb.org/flight-tracker-widget",
  replacement: "https://adsb.lol/?hideSideBar=&lat=40.0398&lon=-88.2762&zoom=11",
  aircraft: "https://api.adsb.lol/v2/point/40.03/-88.28/50",
  "live": "https://avioadsb.org/live/?lat=40.03&lon=-88.28&zoom=9&hideSideBar=",
  "replacementwww": "https://www.adsb.lol/?hideSideBar=&lat=40.0398&lon=-88.2762&zoom=11",
  "widenormal96": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=image&bbox=-10624102.690905357%2C4286028.0236836495%2C-9024102.690905357%2C5486028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=96&layers=show%3A8%2C9%2C29%2C30",
  "widenormal96meta": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=json&bbox=-10624102.690905357%2C4286028.0236836495%2C-9024102.690905357%2C5486028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=96&layers=show%3A8%2C9%2C29%2C30",
  "widefixed42": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=image&bbox=-10624102.690905357%2C4286028.0236836495%2C-9024102.690905357%2C5486028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=42&layers=show%3A1000%2C1001&dynamicLayers=%5B%7B%22id%22%3A1000%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A8%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A0.85%2C%22color%22%3A%5B238%2C234%2C213%2C245%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%2C%7B%22id%22%3A1001%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A8%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A2%2C%22color%22%3A%5B18%2C23%2C27%2C230%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%5D",
  "widefixed42meta": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=json&bbox=-10624102.690905357%2C4286028.0236836495%2C-9024102.690905357%2C5486028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=42&layers=show%3A1000%2C1001&dynamicLayers=%5B%7B%22id%22%3A1000%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A8%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A0.85%2C%22color%22%3A%5B238%2C234%2C213%2C245%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%2C%7B%22id%22%3A1001%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A8%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A2%2C%22color%22%3A%5B18%2C23%2C27%2C230%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%5D",
  "regionalnormal96": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=image&bbox=-9886102.690905357%2C4839528.0236836495%2C-9762102.690905357%2C4932528.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=96&layers=show%3A8%2C9%2C29%2C30",
  "regionalnormal96meta": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=json&bbox=-9886102.690905357%2C4839528.0236836495%2C-9762102.690905357%2C4932528.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=96&layers=show%3A8%2C9%2C29%2C30",
  "regionalfixed42": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=image&bbox=-9886102.690905357%2C4839528.0236836495%2C-9762102.690905357%2C4932528.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=42&layers=show%3A1000%2C1001&dynamicLayers=%5B%7B%22id%22%3A1000%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A9%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A1.1%2C%22color%22%3A%5B238%2C234%2C213%2C245%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%2C%7B%22id%22%3A1001%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A9%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A2.4%2C%22color%22%3A%5B18%2C23%2C27%2C230%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%5D",
  "regionalfixed42meta": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=json&bbox=-9886102.690905357%2C4839528.0236836495%2C-9762102.690905357%2C4932528.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=42&layers=show%3A1000%2C1001&dynamicLayers=%5B%7B%22id%22%3A1000%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A9%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A1.1%2C%22color%22%3A%5B238%2C234%2C213%2C245%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%2C%7B%22id%22%3A1001%2C%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A9%7D%2C%22minScale%22%3A0%2C%22maxScale%22%3A0%2C%22drawingInfo%22%3A%7B%22renderer%22%3A%7B%22type%22%3A%22simple%22%2C%22symbol%22%3A%7B%22type%22%3A%22esriSLS%22%2C%22style%22%3A%22esriSLSSolid%22%2C%22width%22%3A2.4%2C%22color%22%3A%5B18%2C23%2C27%2C230%5D%7D%7D%2C%22scaleSymbols%22%3Afalse%2C%22showLabels%22%3Afalse%7D%7D%5D",
  "localnormal96": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=image&bbox=-9840102.690905357%2C4874028.0236836495%2C-9808102.690905357%2C4898028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=96&layers=show%3A8%2C9%2C29%2C30",
  "localnormal96meta": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=json&bbox=-9840102.690905357%2C4874028.0236836495%2C-9808102.690905357%2C4898028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=96&layers=show%3A8%2C9%2C29%2C30",
  "localfixed42": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=image&bbox=-9840102.690905357%2C4874028.0236836495%2C-9808102.690905357%2C4898028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=42&layers=show%3A29%2C30",
  "localfixed42meta": "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export?f=json&bbox=-9840102.690905357%2C4874028.0236836495%2C-9808102.690905357%2C4898028.0236836495&bboxSR=3857&imageSR=3857&size=800%2C600&format=png32&transparent=true&dpi=42&layers=show%3A29%2C30",
} as const;
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  if (process.env.VERCEL_ENV === "production") return new Response("Not found.", { status: 404, headers: HEADERS });
  const parts = new URL(request.url).searchParams.getAll("part");
  if (parts.length !== 1 || !Object.hasOwn(SOURCES, parts[0])) return new Response("Unknown fixed source.", { status: 400, headers: HEADERS });
  const source = SOURCES[parts[0] as keyof typeof SOURCES];
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 12000);
  try {
    const response = await fetch(source, { credentials: "omit", redirect: "manual", cache: "no-store", signal: controller.signal });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0, truncated = false;
    if (reader) try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const remaining = 512 * 1024 - length;
        chunks.push(part.value.slice(0, remaining));
        length += Math.min(remaining, part.value.length);
        if (length >= 512 * 1024) { truncated = true; await reader.cancel(); break; }
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return Response.json({ source, checkedAt: new Date().toISOString(), status: response.status,
      headers: Object.fromEntries(["content-type", "location", "content-security-policy", "x-frame-options", "access-control-allow-origin", "retry-after"].map(key => [key, response.headers.get(key)])),
      truncated, ...(response.headers.get("content-type")?.startsWith("image/") ? { base64: Buffer.from(bytes).toString("base64") } : { body: new TextDecoder().decode(bytes) }) }, { headers: HEADERS });
  } catch (error) {
    return Response.json({ source, unavailable: true, error: error instanceof Error ? error.message : "Transport failed", cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : null }, { status: 502, headers: HEADERS });
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
