import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { roleKey } from "@/lib/server/roles";
import {
  workOrderNotificationsForRecipient,
  type WorkOrderHistoryNotification,
} from "@/lib/dashboard/work-order-notifications";

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });

  const role = roleKey(auth.principal.profile.role);
  if (!allows(auth.principal, "view_dashboard") || !["engineer", "technician"].includes(role)) {
    return NextResponse.json({ error: "Dashboard notification access is required." }, { status: 403 });
  }

  const since = request.nextUrl.searchParams.get("since") || "";
  const sinceTime = Date.parse(since);
  if (!Number.isFinite(sinceTime)) {
    return NextResponse.json({ error: "A valid notification cursor is required." }, { status: 400 });
  }
  const checkedAt = new Date().toISOString();
  const events: WorkOrderHistoryNotification[] = [];
  const pageSize = 500;
  const maximumEvents = 10_000;
  for (let offset = 0; offset < maximumEvents; offset += pageSize) {
    const { data, error } = await auth.admin
      .from("cmpri_work_order_history")
      .select("id, work_order_id, actor_user_id, old_status, new_status, changed_fields, snapshot, recorded_at")
      .eq("hotel_id", HOTEL_ID)
      .gt("recorded_at", new Date(sinceTime).toISOString())
      .lte("recorded_at", checkedAt)
      .order("recorded_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) return NextResponse.json({ error: "Work-order notifications could not be loaded." }, { status: 503 });
    const page = (data || []) as WorkOrderHistoryNotification[];
    events.push(...page);
    if (page.length < pageSize) break;
    if (offset + pageSize >= maximumEvents) {
      return NextResponse.json({ error: "Too many work-order updates are pending. Refresh the dashboard before retrying." }, { status: 503 });
    }
  }

  const actorIds = Array.from(new Set(events
    .filter((event) => Object.prototype.hasOwnProperty.call(event.changed_fields || {}, "technician_name"))
    .map((event) => event.actor_user_id)
    .filter((id): id is string => !!id)));

  let actorProfiles = new Map<string, { full_name: string | null; role: string }>();
  if (role === "engineer" && actorIds.length > 0) {
    const { data: profiles, error: profileError } = await auth.admin
      .from("profiles")
      .select("id, full_name, role")
      .in("id", actorIds);
    if (profileError) return NextResponse.json({ error: "Work-order notification actors could not be verified." }, { status: 503 });
    actorProfiles = new Map((profiles || []).map((profile: { id: string; full_name: string | null; role: string }) => [profile.id, profile]));
  }

  const notifications = workOrderNotificationsForRecipient(events, {
    id: auth.principal.identity.id,
    name: auth.principal.profile.full_name || "",
    role,
  }, actorProfiles);
  return NextResponse.json({ notifications, checked_at: checkedAt }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
