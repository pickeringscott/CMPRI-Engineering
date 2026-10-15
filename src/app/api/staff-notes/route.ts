import { NextRequest, NextResponse, after } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";
import { staffManagement, staffMentionDirectory, staffRecipients, staffTicketNumbers, type StaffProfile } from "@/lib/staff-notes";
import { profileHasRole } from "@/lib/server/roles";
import { isWithinNotificationSchedule, normalizeNotificationSettings } from "@/lib/notifications/schedule";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";

const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function directory(auth: NonNullable<Awaited<ReturnType<typeof requireUser>>>) {
  const members = await auth.admin.from("hotel_members").select("user_id").eq("hotel_id", auth.principal.hotelId).eq("active", true);
  if (members.error) throw new Error("Staff could not be loaded.");
  const ids = (members.data || []).map(m => m.user_id);
  if (!ids.length) return [];
  const profiles = await auth.admin.from("profiles").select("id,full_name,role,secondary_roles").eq("active", true).in("id", ids);
  if (profiles.error) throw new Error("Staff could not be loaded.");
  return profiles.data as StaffProfile[];
}
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  try {
    const hotel = auth.principal.hotelId, user = auth.principal.identity.id;
    const inboxOnly = request.nextUrl.searchParams.get("inbox") === "1";
    const [inbox, schedule] = await Promise.all([
      auth.admin.from("cmpri_dashboard_notifications").select("notification_key", { count: "exact" })
        .eq("hotel_id", hotel).eq("recipient_user_id", user).like("notification_key", "staff-note:%").is("read_at", null).is("cleared_at", null).order("recorded_at", { ascending: false }).limit(100),
      auth.admin.from("cmpri_user_notification_schedules").select("timezone,schedule").eq("hotel_id", hotel).eq("user_id", user).maybeSingle(),
    ]);
    if (inbox.error || schedule.error) throw new Error("Unread notes could not be loaded.");
    const settings = normalizeNotificationSettings(schedule.data);
    const frontDesk = profileHasRole(auth.principal.profile, "front_desk");
    const summary = { unread: inbox.count || 0, unreadKeys: (inbox.data || []).map(r => r.notification_key), frontDesk,
      alertNow: frontDesk || !!(settings && isWithinNotificationSchedule(settings)), userId: user, hotelId: hotel,
      management: staffManagement(auth.principal.profile) };
    if (inboxOnly) return NextResponse.json(summary, { headers });
    const profiles = await directory(auth);
    const before = request.nextUrl.searchParams.get("before");
    let query = auth.admin.from("cmpri_staff_notes").select("id,author_name,body,parent_id,created_at")
      .eq("hotel_id", hotel).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
    if (before) {
      const [date, id] = before.split("|");
      if (!uuid.test(id || "") || !Number.isFinite(Date.parse(date))) return NextResponse.json({ error: "Invalid cursor." }, { status: 400, headers });
      const timestamp = new Date(date).toISOString();
      query = query.or(`created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`);
    }
    const result = await query;
    if (result.error) throw new Error("Staff Notes could not be loaded.");
    const notes = result.data || [];
    const parentIds = [...new Set(notes.map(n => n.parent_id).filter(Boolean))];
    const parents = parentIds.length ? await auth.admin.from("cmpri_staff_notes").select("id,author_name,body,parent_id,created_at").eq("hotel_id", hotel).in("id", parentIds) : { data: [], error: null };
    if (parents.error) throw new Error("Reply context could not be loaded.");
    const numbers = staffTicketNumbers([...notes, ...(parents.data || [])].map(n => n.body).join("\n"));
    const tickets: Record<string, { href: string; preview: string }> = {};
    if (numbers.length) {
      const orders = await auth.admin.from("work_orders").select("id,display_id,hotel_id,status,created_by,technician_name,room,issue").eq("hotel_id", hotel).in("display_id", numbers);
      if (orders.error) throw new Error("Ticket access could not be verified.");
      const reader = workOrderReader(auth.principal);
      for (const order of orders.data || []) if (canReadWorkOrder(reader, order)) {
        tickets[String(order.display_id)] = { href: `/work-orders/${encodeURIComponent(order.id)}`, preview: `${order.room || ""} · ${order.issue || ""} · ${order.status}` };
      }
    }
    const last = notes.at(-1);
    return NextResponse.json({ ...summary, notes, parents: parents.data, tickets,
      mentions: staffMentionDirectory(profiles).map(m => ({ label: m.label, userIds: [] })),
      next: notes.length === 100 && last ? `${last.created_at}|${last.id}` : null }, { headers });
  } catch { return NextResponse.json({ error: "Staff Notes could not be loaded. Try again." }, { status: 503, headers }); }
}
export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  const input = await request.json().catch(() => null);
  if (!input || typeof input.body !== "string" || !input.body.trim() || input.body.length > 4000 || !uuid.test(input.requestId || "")
    || (input.parentId != null && !uuid.test(input.parentId))) return NextResponse.json({ error: "Enter a comment of 1–4,000 characters." }, { status: 400, headers });
  const frontDesk = profileHasRole(auth.principal.profile, "front_desk");
  const initials = typeof input.initials === "string" ? input.initials.trim().toUpperCase() : "";
  if (frontDesk && !/^[A-Z]{1,4}$/.test(initials)) return NextResponse.json({ error: "Enter your initials." }, { status: 400, headers });
  const author = frontDesk ? initials : (auth.principal.profile.full_name?.trim().split(/\s+/)[0] || "Staff");
  try {
    const profiles = await directory(auth);
    const recipients = staffRecipients(input.body, profiles);
    const result = await auth.admin.rpc("cmpri_post_staff_note", { p_hotel: auth.principal.hotelId, p_author: auth.principal.identity.id,
      p_name: author, p_body: input.body.trim(), p_parent: input.parentId || null, p_request: input.requestId, p_recipients: recipients });
    if (result.error) throw new Error("Post failed");
    // Durable delivery intents are committed by the same transaction as the post.
    // The existing scheduled dispatcher retries any provider failures.
    after(async () => { await Promise.allSettled(recipients.filter(r => r.push).map(recipient => dispatchWebPushNotifications(auth.admin, recipient.user_id,
      profiles.find(p => p.id === recipient.user_id)!, [{ id: `staff-note:${result.data}`, message: `${author} posted in Staff Notes.`, target_path: `/staff-notes#note-${result.data}` }]))); });
    return NextResponse.json({ id: result.data }, { headers });
  } catch { return NextResponse.json({ error: "Not confirmed saved. Retry keeps the same request and will not duplicate your post." }, { status: 503, headers }); }
}
export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  const input = await request.json().catch(() => null);
  if (!Array.isArray(input?.ids) || input.ids.length > 500 || input.ids.some((id: unknown) => typeof id !== "string" || !uuid.test(id))) return NextResponse.json({ error: "Invalid notes." }, { status: 400, headers });
  if (input.ids.length) {
    const result = await auth.admin.from("cmpri_dashboard_notifications").update({ read_at: new Date().toISOString() })
      .eq("hotel_id", auth.principal.hotelId).eq("recipient_user_id", auth.principal.identity.id)
      .in("notification_key", input.ids.map((id: string) => `staff-note:${id}`)).is("read_at", null);
    if (result.error) return NextResponse.json({ error: "Read status could not be saved." }, { status: 503, headers });
  }
  return NextResponse.json({ ok: true }, { headers });
}
