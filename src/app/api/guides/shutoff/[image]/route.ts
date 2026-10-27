import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { requireUserAttempt } from "@/lib/server/auth";
import { canAccessTroubleshootingGuides } from "@/lib/room-ranker-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization", "X-Content-Type-Options": "nosniff" };

export async function GET(request: NextRequest, context: { params: Promise<{ image: string }> }) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!canAccessTroubleshootingGuides(auth.principal.profile)) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const { image } = await context.params;
  if (!["water", "gas", "risers"].includes(image)) {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }
  try {
    const bytes = await readFile(path.join(process.cwd(), "src/server-assets/shutoff", `${image}.png`));
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "image/png" } });
  } catch {
    return Response.json({ error: "Reference image is unavailable." }, { status: 503, headers });
  }
}
