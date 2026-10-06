import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";
import { isUuid } from "@/lib/uuid";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_dashboard") && !allows(auth.principal, "view_work_orders")) return NextResponse.json({ error: "Work-order access is required." }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });

  // Service-role reads are allowed only after proving the parent work order belongs
  // to this exact CMPRI property. Child tables must never be queried cross-property.
  const { data: workOrder, error: workOrderError } = await auth.admin
    .from("work_orders")
    .select("id, status, technician_name")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (workOrderError) return NextResponse.json({ error: "Work-order activity could not be verified." }, { status: 503 });
  if (!workOrder) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  if ((!allows(auth.principal, "view_dashboard") || allows(auth.principal, "add_work_order_notes"))
    && !["Open", "In Progress"].includes(String(workOrder.status || ""))) {
    return NextResponse.json({ error: "This role can only view open work orders." }, { status: 403 });
  }
  if (!canAccessWorkOrderByAssignment(auth.principal.profile.role, auth.principal.profile.full_name, workOrder)) {
    return NextResponse.json({ error: "This work order is not assigned to you." }, { status: 403 });
  }

  if (!allows(auth.principal, "view_dashboard") || allows(auth.principal, "add_work_order_notes")) {
    const { data: history, error } = await auth.admin
      .from("cmpri_work_order_history")
      .select("id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, source, recorded_at")
      .eq("hotel_id", HOTEL_ID)
      .eq("work_order_id", id)
      .order("recorded_at", { ascending: true })
      .limit(500);
    if (error) return NextResponse.json({ error: "Work-order history could not be loaded." }, { status: 503 });
    return NextResponse.json({
      configured: true,
      purchases: [],
      enseo: [],
      warranties: [],
      followups: [],
      history: history || [],
      history_configured: true,
    });
  }

  const [purchases, enseo, warranties, followups, history] = await Promise.all([
    auth.admin.from("cmpri_purchases").select("*, cmpri_purchase_shipments(*)").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_enseo_tickets").select("*").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_warranty_cases").select("*").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_supplier_followups").select("*").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_work_order_history").select("id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, source, recorded_at").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("recorded_at", { ascending: true }).limit(500),
  ]);

  const schemaError = [purchases, enseo, warranties, followups].map((item) => item.error?.message).find(Boolean);
  if (schemaError) {
    return NextResponse.json({ configured: false, purchases: [], enseo: [], warranties: [], followups: [], error: schemaError });
  }
  return NextResponse.json({
    configured: true,
    purchases: purchases.data || [],
    enseo: enseo.data || [],
    warranties: warranties.data || [],
    followups: followups.data || [],
    history: history.error ? [] : (history.data || []),
    history_configured: !history.error,
  });
}
