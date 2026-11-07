import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { exportPmWorkbook } from "@/lib/server/pm-excel-export";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_pm")) return NextResponse.json({ error: "Preventive Maintenance access is required." }, { status: 403 });
  if (Number(request.headers.get("content-length")) > 2_000_000) return NextResponse.json({ error: "The export is too large." }, { status: 413 });
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || typeof body.week !== "string" || !Array.isArray(body.entries)) return NextResponse.json({ error: "Select an export week and PM records." }, { status: 400 });
    const started = performance.now();
    const result = await exportPmWorkbook(body.week, body.entries);
    const elapsed = performance.now() - started;
    return new NextResponse(new Uint8Array(result.buffer), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="cmpri-pm-${body.week}.xlsx"`,
      "Cache-Control": "no-store", "Server-Timing": `workbook;dur=${elapsed.toFixed(1)}`,
      "X-PM-Export-Duration-Ms": elapsed.toFixed(1),
    } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && !/ENOENT|ZIP|archive/i.test(error.message) ? error.message : "The PM workbook could not be exported." }, { status: 400 });
  }
}
