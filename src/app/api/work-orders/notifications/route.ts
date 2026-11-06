import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { profileHasRole, profileIsChiefEngineerOrSystemAdmin } from "@/lib/server/roles";
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });

  const role = profileIsChiefEngineerOrSystemAdmin(auth.principal.profile)
    ? "engineer"
    : profileHasRole(auth.principal.profile, "technician") ? "technician" : "unknown";
  if (!allows(auth.principal, "view_dashboard") || !["engineer", "technician"].includes(role)) {
    return NextResponse.json({ error: "Dashboard notification access is required." }, { status: 403 });
  }

  const since = request.nextUrl.searchParams.get("since") || "";
  const sinceTime = Date.parse(since);
  if (!Number.isFinite(sinceTime)) {
    return NextResponse.json({ error: "A valid notification cursor is required." }, { status: 400 });
  }
  const checkedAt = new Date().toISOString();
  const result = await auth.admin.from("cmpri_dashboard_notifications")
    .select("notification_key,work_order_id,message,recorded_at,cleared_at")
    .eq("hotel_id", HOTEL_ID).eq("recipient_user_id", auth.principal.identity.id)
    .not("work_order_id", "is", null)
    .gt("recorded_at", new Date(sinceTime).toISOString()).lte("recorded_at", checkedAt)
    .order("recorded_at", { ascending: true }).order("notification_key").limit(501);
  if (result.error) return NextResponse.json({ error: "Notifications could not be loaded." }, { status: 503 });
  const rows = result.data || [];
  if (rows.length > 500) return NextResponse.json({ error: "Open the stored notification inbox to review pending updates." }, { status: 409 });
  // A full inbox remains available independently of this legacy banner cursor.
  const page = rows.slice(0, 500);
  return NextResponse.json({
    notifications: page.filter(row => !row.cleared_at).map(row => ({ id: row.notification_key, work_order_id: row.work_order_id, message: row.message, recorded_at: row.recorded_at })),
    resolved_notification_ids: page.filter(row => row.cleared_at).map(row => row.notification_key),
    checked_at: rows.length > 500 ? page[page.length - 1].recorded_at : checkedAt,
  }, { headers: { "Cache-Control": "private, no-store" } });
}
