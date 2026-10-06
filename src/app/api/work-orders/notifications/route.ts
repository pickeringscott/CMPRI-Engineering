import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { profileHasRole, roleKey } from "@/lib/server/roles";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";
import {
  technicianViewNotificationsForEngineer,
  workOrderNotificationsForRecipient,
  type WorkOrderHistoryNotification,
  type WorkOrderTechnicianView,
} from "@/lib/dashboard/work-order-notifications";

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });

  const role = profileHasRole(auth.principal.profile, "engineer")
    ? "engineer"
    : roleKey(auth.principal.profile.role);
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
      .select("id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, recorded_at")
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

  const notifications = workOrderNotificationsForRecipient(events, {
    id: auth.principal.identity.id,
    name: auth.principal.profile.full_name || "",
    role,
  });

  let resolvedNotificationIds: string[] = [];
  if (role === "engineer") {
    const sinceIso = new Date(sinceTime).toISOString();
    const views: WorkOrderTechnicianView[] = [];
    const resolvedViews: Array<{ id: string }> = [];
    for (let offset = 0; offset < maximumEvents; offset += pageSize) {
      const [viewResult, resolvedViewResult] = await Promise.all([
        auth.admin
        .from("cmpri_work_order_technician_views")
        .select("id, work_order_id, work_order_display_id, technician_name, viewed_at")
        .eq("hotel_id", HOTEL_ID)
        .lte("viewed_at", checkedAt)
        .is("resolved_at", null)
        .order("viewed_at", { ascending: true })
        .range(offset, offset + pageSize - 1),
        auth.admin
        .from("cmpri_work_order_technician_views")
        .select("id")
        .eq("hotel_id", HOTEL_ID)
        .gt("resolved_at", sinceIso)
        .lte("resolved_at", checkedAt)
        .order("resolved_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1),
      ]);
      if (viewResult.error || resolvedViewResult.error) {
        return NextResponse.json({ error: "Technician view notifications could not be loaded." }, { status: 503 });
      }
      const viewPage = (viewResult.data || []) as WorkOrderTechnicianView[];
      const resolvedViewPage = (resolvedViewResult.data || []) as Array<{ id: string }>;
      views.push(...viewPage);
      resolvedViews.push(...resolvedViewPage);
      if (viewPage.length < pageSize && resolvedViewPage.length < pageSize) break;
      if (offset + pageSize >= maximumEvents) {
        return NextResponse.json({ error: "Too many technician view updates are pending. Refresh the dashboard before retrying." }, { status: 503 });
      }
    }
    notifications.push(...technicianViewNotificationsForEngineer(views));
    resolvedNotificationIds = resolvedViews.map((view) => `technician-view:${view.id}`);
  }

  try {
    await dispatchWebPushNotifications(auth.admin, auth.principal.identity.id, auth.principal.profile, notifications);
  } catch (error) {
    console.error("Work-order notifications were loaded, but phone alerts could not be delivered.", error);
  }

  return NextResponse.json({ notifications, resolved_notification_ids: resolvedNotificationIds, checked_at: checkedAt }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
