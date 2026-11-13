import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { canReadWorkOrder } from "@/lib/work-order-read-policy";
import { isUuid } from "@/lib/uuid";
import { isTicketAutomaticallyEscalated } from "@/lib/ticket-room-ranking";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Invalid work order." }, { status: 400 });
  const { data: order, error } = await auth.admin.from("work_orders").select("id,hotel_id,location_id,room,priority,ranker_base_priority,status")
    .eq("hotel_id", auth.principal.hotelId).eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: "Room Ranker alert is unavailable." }, { status: 503 });
  if (!order || !canReadWorkOrder(workOrderReader(auth.principal), order)) return NextResponse.json({ error: "Work order unavailable." }, { status: 404 });
  // The stored alert remembers past escalation. The visible flag must reflect
  // the current priority so it clears as soon as Room Ranker restores it.
  if (!isTicketAutomaticallyEscalated(order) || (!order.location_id && !order.room) || ["Completed", "Closed", "Will Not Do"].includes(order.status)) return NextResponse.json({ active: false, related: [] }, { headers: { "Cache-Control": "private, no-store" } });
  let query = auth.admin.from("work_orders").select("id,display_id,hotel_id,status")
    .eq("hotel_id", auth.principal.hotelId).neq("id", id)
    .in("status", ["Open", "In Progress"]).order("created_at", { ascending: true });
  query = order.location_id ? query.eq("location_id", order.location_id) : query.eq("room", order.room);
  const result = await query;
  if (result.error) return NextResponse.json({ error: "Related work orders could not be loaded." }, { status: 503 });
  return NextResponse.json({ active: true, related: (result.data || []).filter(item => canReadWorkOrder(workOrderReader(auth.principal), item)).map(item => ({ id: item.id, display_id: item.display_id })) }, { headers: { "Cache-Control": "private, no-store" } });
}
