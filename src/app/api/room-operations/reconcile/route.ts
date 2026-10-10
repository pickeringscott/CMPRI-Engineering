import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });
  const { data, error } = await admin.rpc("cmpri_reconcile_room_operations");
  if (error) {
    return NextResponse.json({ error: `Scheduled room checkout reconciliation failed: ${error.message}` }, { status: 503 });
  }
  return NextResponse.json({ ok: true, transitioned: typeof data === "number" ? data : 0 });
}
