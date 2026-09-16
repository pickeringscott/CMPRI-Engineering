import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_dashboard")) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  const { id } = await params;

  // Service-role reads are allowed only after proving the parent work order belongs
  // to this exact CMPRI property. Child tables must never be queried cross-property.
  const { data: workOrder, error: workOrderError } = await auth.admin
    .from("work_orders")
    .select("id")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (workOrderError) return NextResponse.json({ error: "Work-order activity could not be verified." }, { status: 503 });
  if (!workOrder) return NextResponse.json({ error: "Work order not found." }, { status: 404 });

  const [purchases, enseo, warranties, followups, history] = await Promise.all([
    auth.admin.from("cmpri_purchases").select("*, cmpri_purchase_shipments(*)").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_enseo_tickets").select("*").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_warranty_cases").select("*").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_supplier_followups").select("*").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("updated_at", { ascending: false }),
    auth.admin.from("cmpri_work_order_history").select("id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, recorded_at").eq("hotel_id", HOTEL_ID).eq("work_order_id", id).order("recorded_at", { ascending: true }).limit(500),
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
