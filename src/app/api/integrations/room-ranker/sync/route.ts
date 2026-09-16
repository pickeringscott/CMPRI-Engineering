import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/server/auth";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { processDueRoomRankerSync } from "@/lib/server/room-ranker";

async function authorizedAdmin(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`) {
    return createSupabaseAdmin();
  }
  const auth = await requireCapability(request, "operate_integrations");
  return auth?.admin ?? null;
}

async function run(request: NextRequest) {
  const admin = await authorizedAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const results = await processDueRoomRankerSync(admin, 25);
    const processed = results.filter((result) => result.processed).length;
    return NextResponse.json({ ok: true, checked: results.length, processed, pending_or_failed: results.length - processed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Room Ranker synchronization failed." }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
