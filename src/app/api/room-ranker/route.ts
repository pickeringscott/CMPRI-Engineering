import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { jsonObject, rankerUpdate } from "@/lib/integrations/spreadsheet-input";
import { callRoomRanker } from "@/lib/server/room-ranker";
import { integrationErrorStatus, isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";
import { roleKey } from "@/lib/server/roles";

function isSystemAdmin(auth: Awaited<ReturnType<typeof requireUser>>) {
  return auth !== null && roleKey(auth.principal.profile.role) === "system_admin";
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!isSystemAdmin(auth)) return NextResponse.json({ error: "Room Ranker is available only to System Administrators." }, { status: 403 });
  try {
    const result = await callRoomRanker({ action: "read" });
    return NextResponse.json({ ...result, can_edit: true, safeMode: isIntegrationsSafeMode() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: integrationErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!isSystemAdmin(auth)) return NextResponse.json({ error: "Room Ranker is available only to System Administrators." }, { status: 403 });
  const payload = rankerUpdate(await jsonObject(request));
  if (!payload) return NextResponse.json({ error: "Supply a valid row, expected room and editable text fields. Rank must be A, B, C or blank." }, { status: 400 });
  try {
    const result = await callRoomRanker(payload);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: integrationErrorStatus(error) });
  }
}
