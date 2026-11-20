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
      truncated, body: new TextDecoder().decode(bytes) }, { headers: HEADERS });
  } catch (error) {
    return Response.json({ source, unavailable: true, error: error instanceof Error ? error.message : "Transport failed" }, { status: 502, headers: HEADERS });
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
