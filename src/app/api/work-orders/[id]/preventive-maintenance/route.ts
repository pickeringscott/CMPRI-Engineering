import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { corporatePmUpdate, jsonObject } from "@/lib/integrations/spreadsheet-input";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { integrationErrorStatus, isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";
import { setCorporatePmCheckbox } from "@/lib/server/corporate-pm";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "edit_tickets")) {
    return NextResponse.json({ error: "Work-order editing permission is required to commit room checks." }, { status: 403 });
  }

  const payload = corporatePmUpdate(await jsonObject(request));
  if (!payload || payload.action !== "setcheckbox" || typeof payload.expectedChecked !== "boolean") {
    return NextResponse.json({ error: "Supply a valid daily or weekly PM checkbox and typed value." }, { status: 400 });
  }

  const { id } = await params;
  const { data: workOrder, error } = await auth.admin
    .from("work_orders")
    .select("id, room, technician_name")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!workOrder) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  if (!canAccessWorkOrderByAssignment(auth.principal.profile.role, auth.principal.profile.full_name, workOrder)) {
    return NextResponse.json({ error: "This work order is not assigned to you." }, { status: 403 });
  }
  const room = String(workOrder.room || "").match(/\b\d{2,4}\b/)?.[0] || "";
  if (!room) return NextResponse.json({ error: "This work order is not associated with a numbered room." }, { status: 400 });

  try {
    const result = await setCorporatePmCheckbox(
      String(payload.sheet),
      Number(payload.row),
      Number(payload.column),
      Boolean(payload.checked),
      room,
      payload.expectedChecked,
    );
    return NextResponse.json({ ...result, safeMode: isIntegrationsSafeMode(), blocked: result.ok !== true });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: integrationErrorStatus(cause) });
  }
}
