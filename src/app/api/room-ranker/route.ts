import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { jsonObject, rankerUpdate } from "@/lib/integrations/spreadsheet-input";
import { callRoomRanker } from "@/lib/server/room-ranker";
import { integrationErrorMessage, integrationErrorStatus, isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";
import { canEditRoomRanker, canViewRoomRanker } from "@/lib/room-ranker-access";

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!canViewRoomRanker(auth.principal)) return NextResponse.json({ error: "Room Ranker is not available for this account." }, { status: 403 });
  try {
    const result = await callRoomRanker({ action: "read" });
    return NextResponse.json({ ...result, can_edit: canEditRoomRanker(auth.principal), safeMode: isIntegrationsSafeMode() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: integrationErrorMessage(error, "Room Ranker") }, { status: integrationErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!canEditRoomRanker(auth.principal)) return NextResponse.json({ error: "Only Scott's authorized account can edit or synchronize Room Ranker data." }, { status: 403 });
  const payload = rankerUpdate(await jsonObject(request));
  if (!payload) return NextResponse.json({ error: "Supply a valid row, expected room and editable text fields. Rank must be A, B, C or blank." }, { status: 400 });
  try {
    const result = await callRoomRanker(payload);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: integrationErrorMessage(error, "Room Ranker") }, { status: integrationErrorStatus(error) });
  }
}
