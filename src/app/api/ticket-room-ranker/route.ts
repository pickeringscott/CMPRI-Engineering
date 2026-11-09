import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { fetchAllPages } from "@/lib/server/paginated-query";
import { rankTicketRooms, type RankingLocation, type RankingTicket } from "@/lib/ticket-room-ranking";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers });
  // The dashboard already admits users with any of these existing capabilities.
  if (!["view_dashboard", "view_work_orders", "view_pm", "receive_pool_closed_notifications"].some((capability) =>
    allows(auth.principal, capability as Parameters<typeof allows>[1]))) {
    return NextResponse.json({ error: "Dashboard access is required." }, { status: 403, headers });
  }
  if (!allows(auth.principal, "view_work_orders")) return NextResponse.json({ error: "Work-order read access is required." }, { status: 403, headers });
  const hotel = auth.principal.hotelId;
  try {
    const [locations, tickets] = await Promise.all([
      fetchAllPages<RankingLocation>((from, to) => auth.admin.from("locations")
        .select("id,room_number,name,location_type,active").eq("hotel_id", hotel).eq("active", true)
        .eq("location_type", "Guest Room").order("id").range(from, to)),
      fetchAllPages<RankingTicket>((from, to) => auth.admin.from("work_orders")
        .select("id,location_id,room,issue,priority,ranker_base_priority,status").eq("hotel_id", hotel)
        .not("status", "in", '("Completed","Closed","Will Not Do")').order("id").range(from, to)),
    ]);
    if (locations.error || tickets.error) throw new Error("Rooms or active tickets could not be loaded.");
    return NextResponse.json({ rooms: rankTicketRooms(locations.data || [], tickets.data || []), refreshedAt: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: "Room ranking could not be loaded. Please try again." }, { status: 503, headers });
  }
}
