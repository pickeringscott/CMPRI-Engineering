/** Temporary branch-only inspection of public widget configuration, never flight rows. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (process.env.VERCEL_ENV === "production") return new Response(null, { status: 404, headers });
  if (request.method !== "GET") return new Response(null, { status: 405, headers });
  const source = "https://www.avionio.com/en/widgets/cmi/arrivals/en";
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  try {
    const response = await fetch(source, { credentials: "omit", redirect: "error", cache: "no-store", signal });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Provider configuration unavailable");
    if (!response.body) throw new Error("Missing configuration body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Configuration exceeds limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const html = new TextDecoder().decode(Buffer.concat(chunks));
    const selects = [...html.matchAll(/<select\b[\s\S]*?<\/select>/gi)].map(match => match[0].slice(0, 12000));
    return Response.json({ source, checkedAt: new Date().toISOString(), selects }, { headers });
  } catch (error) {
    return Response.json({ source, error: error instanceof Error ? error.message : "Configuration unavailable" }, { status: 502, headers });
  }
}
