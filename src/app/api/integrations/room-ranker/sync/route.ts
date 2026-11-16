import {NextResponse} from "next/server";
import type { NextRequest } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { dispatchCorporateRoomRanker } from "@/lib/server/corporate-room-ranker";

export const maxDuration = 60;
/** No GET or cron worker: only authenticated committed-change events. */
function retired(){return NextResponse.json({error:"The legacy Room Ranker has been retired. Use the current Room Ranker."},{status:410});}
export const GET=retired;
export const PATCH=retired;

export async function POST(request: NextRequest) {
  const secret = process.env.CMPRI_CORPORATE_RANKER_WEBHOOK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (body?.hotel_id !== HOTEL_ID || body?.event !== "corporate_ranker_changed") return NextResponse.json({ error: "Invalid change event" }, { status: 400 });
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Delivery service unavailable" }, { status: 503 });
  try {
    return NextResponse.json(await dispatchCorporateRoomRanker(admin), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Corporate Room Ranker delivery failed", error);
    return NextResponse.json({ error: "Corporate Room Ranker delivery failed; the change remains pending." }, { status: 503 });
  }
}
