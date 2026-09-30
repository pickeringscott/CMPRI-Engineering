import { NextRequest, NextResponse } from "next/server";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { integrationErrorStatus, isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";
import { CORPORATE_PM_MONTHS, readCorporatePmRoom, readCorporatePmSheet } from "@/lib/server/corporate-pm";
import { roleKey } from "@/lib/server/roles";

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_dashboard")) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  try {
    const { searchParams } = new URL(request.url);
    const room = (searchParams.get("room") || "").trim();
    if (room) {
      const result = await readCorporatePmRoom(room);
      return NextResponse.json({
        ...result,
        can_edit: false,
        write_disabled: true,
        safeMode: isIntegrationsSafeMode(),
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (roleKey(auth.principal.profile.role) !== "system_admin") {
      return NextResponse.json({ error: "Preventive Maintenance management is available only to System Administrators." }, { status: 403 });
    }
    const sheet = (searchParams.get("sheet") || "").trim().toUpperCase() || CORPORATE_PM_MONTHS[new Date().getMonth()];
    const result = await readCorporatePmSheet(sheet);
    return NextResponse.json({
      ...result,
      can_edit: false,
      write_disabled: true,
      safeMode: isIntegrationsSafeMode(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: integrationErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (roleKey(auth.principal.profile.role) !== "system_admin") {
    return NextResponse.json({ error: "Preventive Maintenance management is available only to System Administrators." }, { status: 403 });
  }
  return NextResponse.json(
    { error: "Direct Corporate PM edits are disabled. Submit changes in CMPRI and confirm them against the live PM workbook through the reviewer queue." },
    { status: 409 },
  );
}
