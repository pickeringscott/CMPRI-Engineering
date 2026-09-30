import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { roleKey } from "@/lib/server/roles";

async function bodyObject(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { admin, principal } = auth;
  const mode = request.nextUrl.searchParams.get("mode") || "management";

  if (mode === "create") {
    if (!allows(principal, "submit")) {
      return NextResponse.json({ error: "Work-order submission permission is required." }, { status: 403 });
    }
    const { data, error } = await admin.from("locations")
      .select("id, area, name, room_number, location_type")
      .eq("hotel_id", HOTEL_ID)
      .eq("active", true)
      .order("area", { ascending: true })
      .order("room_number", { ascending: true })
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: "Locations could not be loaded." }, { status: 503 });
    return NextResponse.json({ locations: data || [] }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!allows(principal, "view_dashboard") && !allows(principal, "manage_rooms")) {
    return NextResponse.json({ error: "Engineering dashboard access is required." }, { status: 403 });
  }

  const [locationResult, orderResult, pmPlanResult, pmCompletionResult] = await Promise.all([
    admin.from("locations")
      .select("id, area, name, room_number, location_type, active")
      .eq("hotel_id", HOTEL_ID)
      .eq("active", true)
      .order("area", { ascending: true })
      .order("room_number", { ascending: true }),
    admin.from("work_orders")
      .select("id, location_id, room, issue, status, created_at")
      .eq("hotel_id", HOTEL_ID)
      .order("created_at", { ascending: false })
      .limit(1000),
    admin.from("pm_plans")
      .select("id, location_id, asset_id, title, description, checklist, frequency_value, frequency_unit, last_completed_on, next_due_on, active")
      .eq("hotel_id", HOTEL_ID)
      .eq("active", true)
      .order("next_due_on", { ascending: true, nullsFirst: false }),
    admin.from("pm_completions")
      .select("id, pm_plan_id, completed_on, completed_by_name, notes, created_at")
      .eq("hotel_id", HOTEL_ID)
      .order("completed_on", { ascending: false })
      .limit(2000),
  ]);

  if (locationResult.error || orderResult.error || pmPlanResult.error || pmCompletionResult.error) {
    return NextResponse.json({ error: "Rooms, work orders, or PM records could not be loaded." }, { status: 503 });
  }

  return NextResponse.json({
    locations: locationResult.data || [],
    work_orders: orderResult.data || [],
    pm_plans: pmPlanResult.data || [],
    pm_completions: pmCompletionResult.data || [],
    can_edit: allows(principal, "manage_rooms"),
    can_manage_corporate_pm: roleKey(principal.profile.role) === "system_admin",
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireCapability(request, "manage_rooms");
  if (!auth) return NextResponse.json({ error: "Room/location editing permission is required." }, { status: 403 });
  const body = await bodyObject(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Location id is required." }, { status: 400 });

  const fields = ["area", "name", "room_number", "location_type"] as const;
  const update: Record<string, string | null> = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (value !== null && typeof value !== "string") return NextResponse.json({ error: `Invalid ${field}.` }, { status: 400 });
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized.length > 200) return NextResponse.json({ error: `${field} is too long.` }, { status: 400 });
    update[field] = normalized || null;
  }
  if (!Object.keys(update).length) return NextResponse.json({ error: "No room/location changes were supplied." }, { status: 400 });
  if (Object.prototype.hasOwnProperty.call(update, "name") && !update.name) {
    return NextResponse.json({ error: "Location name cannot be blank." }, { status: 400 });
  }
  if (update.room_number && !/^[A-Za-z0-9 -]{1,20}$/.test(update.room_number)) {
    return NextResponse.json({ error: "Room number contains unsupported characters." }, { status: 400 });
  }

  const { data, error } = await auth.admin.from("locations")
    .update(update)
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .select("id, area, name, room_number, location_type, active")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ location: data });
}
