import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireCapability, requireUser } from "@/lib/server/auth";
import {randomUUID} from 'node:crypto';
import {prepareLocation,type Location} from '@/lib/location-records';
import {loadLocationActivity} from '@/lib/server/location-activity';
import {fetchAllPages} from '@/lib/server/paginated-query';
import { roleKey } from "@/lib/server/roles";
import { loadCurrentRoomStatuses, currentRoomStatus } from "@/lib/server/room-availability";

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
    const roomStatuses = await loadCurrentRoomStatuses(admin);
    const statuses = roomStatuses.statuses;
    if (roomStatuses.error || !statuses) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });
    const locations = (data || []).map((location) => ({
      ...location,
      room_status: currentRoomStatus(statuses, location.room_number || location.name),
      room_status_report_date: roomStatuses.date,
    }));
    return NextResponse.json({ locations }, { headers: { "Cache-Control": "no-store" } });
  }

  const isTechnician = roleKey(principal.profile.role) === "technician";
  if (!allows(principal, "view_engineering_operations") && !(isTechnician && allows(principal, "view_pm"))) {
    return NextResponse.json({ error: "Engineering dashboard access is required." }, { status: 403 });
  }

  const orderResult = isTechnician
    ? await (async () => {
      const technicianName = principal.profile.full_name?.trim();
      const workOrderQuery = () => admin.from("work_orders")
        .select("id, display_id, location_id, room, issue, status, created_at, technician_name")
        .eq("hotel_id", HOTEL_ID)
        .in("status", ["Open", "In Progress"])
        .order("created_at", { ascending: false })
        .limit(1000);
      const unassignedQuery = workOrderQuery().or("technician_name.is.null,technician_name.eq.");
      const assignedQuery = technicianName ? workOrderQuery().eq("technician_name", technicianName) : null;
      const [unassigned, assigned] = await Promise.all([
        unassignedQuery,
        assignedQuery ?? Promise.resolve({ data: [], error: null }),
      ]);
      if (unassigned.error || assigned.error) return { data: null, error: unassigned.error || assigned.error };
      return {
        data: Array.from(new Map(
          [...(assigned.data || []), ...(unassigned.data || [])].map((order) => [order.id, order]),
        ).values()),
        error: null,
      };
    })()
    : admin.from("work_orders")
      .select("id, display_id, location_id, room, issue, status, created_at")
      .eq("hotel_id", HOTEL_ID)
      .order("created_at", { ascending: false })
      .limit(1000);
  const [locationResult, loadedOrders, pmPlanResult, pmCompletionResult] = await Promise.all([
    admin.from("locations")
      .select("id, area, name, room_number, location_type, active")
      .eq("hotel_id", HOTEL_ID)
      .eq("active", true)
      .order("area", { ascending: true })
      .order("room_number", { ascending: true }),
    orderResult,
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

  if (locationResult.error || loadedOrders.error || pmPlanResult.error || pmCompletionResult.error) {
    return NextResponse.json({ error: "Rooms, work orders, or PM records could not be loaded." }, { status: 503 });
  }

  let activity;
  try { activity=await loadLocationActivity(admin,principal,(locationResult.data||[]) as Location[]); } catch { return NextResponse.json({error:'Location PM source records could not be loaded.'},{status:503}); }
  return NextResponse.json({
    ...activity,
    locations: locationResult.data || [],
    work_orders: loadedOrders.data || [],
    pm_plans: pmPlanResult.data || [],
    pm_completions: pmCompletionResult.data || [],
    can_edit: allows(principal, "manage_rooms"),
    can_manage_corporate_pm: roleKey(principal.profile.role) === "system_admin",
  }, { headers: { "Cache-Control": "no-store" } });
}

async function saveLocation(request: NextRequest, method: 'POST'|'PATCH') {
  const auth=await requireCapability(request,'manage_rooms');
  if(!auth)return NextResponse.json({error:'Location editing permission is required.'},{status:403});
  const origin=request.headers.get('origin');
  if(origin && origin!==request.nextUrl.origin)return NextResponse.json({error:'Same-origin request required.'},{status:403});
  const body=await bodyObject(request);
  if(!body)return NextResponse.json({error:'A valid JSON object is required.'},{status:400});
  const all=await fetchAllPages<Location>((from,to)=>auth.admin.from('locations').select('id,area,name,room_number,location_type,active').eq('hotel_id',HOTEL_ID).order('id').range(from,to));
  if(all.error)return NextResponse.json({error:'Location validation is unavailable.'},{status:503});
  try {
    const locations=all.data||[];
    const saved=prepareLocation(method,body,locations,locations.filter(l=>l.active),randomUUID);
    const query=method==='POST'
      ? auth.admin.from('locations').insert({...saved,hotel_id:HOTEL_ID})
      : auth.admin.from('locations').update({name:saved.name,area:saved.area,location_type:saved.location_type}).eq('hotel_id',HOTEL_ID).eq('id',saved.id);
    const {data,error}=await query.select('id,area,name,room_number,location_type,active').single();
    if(error)return NextResponse.json({error:'Location could not be saved.'},{status:error.code==='23505'?409:400});
    return NextResponse.json({location:data},{status:method==='POST'?201:200});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Invalid location.'},{status:400});}
}
export async function POST(request:NextRequest){return saveLocation(request,'POST');}
export async function PATCH(request:NextRequest){return saveLocation(request,'PATCH');}
