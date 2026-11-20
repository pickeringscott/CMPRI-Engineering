/** Temporary branch-only inspection of fixed public provider documents. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;
const SOURCES = {
  arrivals: "https://www.avionio.com/widget/en/cmi/arrivals?style=3",
  departures: "https://www.avionio.com/widget/en/cmi/departures?style=3",
  tracker: "https://avioadsb.org/flight-tracker-widget",
  builder: "https://avioadsb.org/js/widget-builder.js?v=b7f82c07f3",
} as const;
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (process.env.VERCEL_ENV === "production") return new Response(null, { status: 404, headers });
  const part = new URL(request.url).searchParams.get("part");
  if (request.method !== "GET" || !part || !Object.hasOwn(SOURCES, part)) return new Response(null, { status: 400, headers });
  const source = SOURCES[part as keyof typeof SOURCES];
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12000)]);
  try {
    const response = await fetch(source, { credentials: "omit", redirect: "error", cache: "no-store", signal });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !(part === "builder" ? /(?:text|application)\/javascript/i.test(contentType) : contentType.includes("text/html"))) throw new Error("Provider document unavailable: " + response.status);
    if (!response.body) throw new Error("Missing document body");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Document exceeds limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Response.json({ source, checkedAt: new Date().toISOString(), html: new TextDecoder().decode(Buffer.concat(chunks)) }, { headers });
  } catch (error) {
    return Response.json({ source, error: error instanceof Error ? error.message : "Provider unavailable" }, { status: 502, headers });
  }
}
