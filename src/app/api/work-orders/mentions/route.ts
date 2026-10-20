import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { loadPublicWorkOrderMentions } from "@/lib/server/work-order-mentions";

const headers = { "Cache-Control": "private, no-store" };
async function authorize(request: NextRequest) {
  const auth = await requireUser(request);
  return auth && allows(auth.principal, "add_work_order_notes") ? auth : null;
}
export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if (!auth) return NextResponse.json({ error: "Work-order note permission is required." }, { status: 403, headers });
  try {
    if (request.nextUrl.searchParams.get("directory") === "1") {
      return NextResponse.json({ mentions: await loadPublicWorkOrderMentions(auth.admin, auth.principal.hotelId) }, { headers });
    }
    const result = await auth.admin.from("cmpri_dashboard_notifications")
      .select("notification_key,work_order_id,message,recorded_at,read_at")
      .eq("hotel_id", auth.principal.hotelId).eq("recipient_user_id", auth.principal.identity.id)
      .like("notification_key", "work-order-mention:%").is("cleared_at", null).is("read_at", null)
      .order("recorded_at", { ascending: false }).limit(100);
    if (result.error) throw new Error("Mention notifications could not be loaded.");
    return NextResponse.json({ userId: auth.principal.identity.id, notifications: result.data || [] }, { headers });
  } catch { return NextResponse.json({ error: "Work-order mentions could not be loaded. Try again." }, { status: 503, headers }); }
}
export async function PATCH(request: NextRequest) {
  const auth = await authorize(request);
  if (!auth) return NextResponse.json({ error: "Work-order note permission is required." }, { status: 403, headers });
  const input = await request.json().catch(() => null);
  if (!Array.isArray(input?.ids) || input.ids.length > 100 || input.ids.some((id: unknown) => typeof id !== "string" || !/^work-order-mention:[0-9a-f-]{36}:\d+$/i.test(id))) {
    return NextResponse.json({ error: "Invalid mention notifications." }, { status: 400, headers });
  }
  if (input.ids.length) {
    const result = await auth.admin.from("cmpri_dashboard_notifications").update({ read_at: new Date().toISOString() })
      .eq("hotel_id", auth.principal.hotelId).eq("recipient_user_id", auth.principal.identity.id)
      .in("notification_key", input.ids).like("notification_key", "work-order-mention:%").is("read_at", null);
    if (result.error) return NextResponse.json({ error: "Mention read status could not be saved." }, { status: 503, headers });
  }
  return NextResponse.json({ ok: true }, { headers });
}
