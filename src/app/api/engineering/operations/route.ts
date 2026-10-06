import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";

import { PURCHASE_STATUSES, SHIPMENT_STATUSES, parentStatusFromShipments } from "@/lib/integrations/operations";
import { isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_engineering_operations")) return NextResponse.json({ error: "Engineering operations access is required." }, { status: 403 });
  const { admin } = auth;

  const [purchasesResult, enseoResult, warrantyResult, followupResult, gssResult, emailResult] = await Promise.all([
    admin.from("cmpri_purchases").select("*, cmpri_purchase_shipments(*)").eq("hotel_id", HOTEL_ID).order("updated_at", { ascending: false }).limit(100),
    admin.from("cmpri_enseo_tickets").select("*").eq("hotel_id", HOTEL_ID).order("updated_at", { ascending: false }).limit(100),
    admin.from("cmpri_warranty_cases").select("*").eq("hotel_id", HOTEL_ID).order("updated_at", { ascending: false }).limit(100),
    admin.from("cmpri_supplier_followups").select("*").eq("hotel_id", HOTEL_ID).order("updated_at", { ascending: false }).limit(100),
    admin.from("cmpri_gss_reports").select("*").eq("hotel_id", HOTEL_ID).order("report_week", { ascending: false }).limit(52),
    admin.from("cmpri_email_events").select("id, category, message_at, subject, direction").eq("hotel_id", HOTEL_ID).order("message_at", { ascending: false }).limit(25),
  ]);

  const schemaError = [purchasesResult, enseoResult, warrantyResult, followupResult, gssResult, emailResult].map((item) => item.error?.message).find(Boolean);
  if (schemaError) return NextResponse.json({ configured: false, error: schemaError }, { status: 503 });

  return NextResponse.json({
    configured: true,
    can_edit: allows(auth.principal, "operate_integrations"),
    safe_mode: isIntegrationsSafeMode(),
    purchases: purchasesResult.data || [],
    enseo: enseoResult.data || [],
    warranties: warrantyResult.data || [],
    followups: followupResult.data || [],
    gss: gssResult.data || [],
    recentEmailEvents: emailResult.data || [],
  });
}


export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "operate_integrations")) return NextResponse.json({ error: "Your account has read-only access to purchasing." }, { status: 403 });
  const { admin } = auth;

  let body: { kind?: string; id?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const id = String(body.id || "").trim();
  const status = String(body.status || "").trim();
  if (!id || !status) return NextResponse.json({ error: "id and status are required." }, { status: 400 });

  if (body.kind === "purchase") {
    if (!PURCHASE_STATUSES.includes(status)) return NextResponse.json({ error: "Invalid purchase status." }, { status: 400 });

    const { data: purchase, error: lookupError } = await admin
      .from("cmpri_purchases")
      .select("id, hotel_id")
      .eq("id", id)
      .eq("hotel_id", HOTEL_ID)
      .single();
    if (lookupError || !purchase) return NextResponse.json({ error: "Purchase not found." }, { status: 404 });

    const { error } = await admin
      .from("cmpri_purchases")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("hotel_id", HOTEL_ID);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, kind: "purchase", id, status });
  }

  if (body.kind === "shipment") {
    if (!SHIPMENT_STATUSES.includes(status)) return NextResponse.json({ error: "Invalid shipment status." }, { status: 400 });

    const { data: shipment, error: lookupError } = await admin
      .from("cmpri_purchase_shipments")
      .select("id, purchase_id")
      .eq("id", id)
      .single();
    if (lookupError || !shipment) return NextResponse.json({ error: "Shipment not found." }, { status: 404 });

    const { data: purchase, error: purchaseError } = await admin
      .from("cmpri_purchases")
      .select("id, hotel_id, status")
      .eq("id", shipment.purchase_id)
      .eq("hotel_id", HOTEL_ID)
      .single();
    if (purchaseError || !purchase) return NextResponse.json({ error: "Shipment does not belong to this hotel." }, { status: 404 });

    const now = new Date().toISOString();
    const updates: Record<string, string | null> = { status, updated_at: now };
    if (status === "Delivered") updates.delivered_at = now;
    if (status === "Received") {
      updates.received_at = now;
      updates.delivered_at = now;
    }

    const { error } = await admin.from("cmpri_purchase_shipments").update(updates).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { data: siblings, error: siblingError } = await admin
      .from("cmpri_purchase_shipments")
      .select("status")
      .eq("purchase_id", shipment.purchase_id);
    if (siblingError) return NextResponse.json({ error: siblingError.message }, { status: 500 });

    const parentStatus = parentStatusFromShipments((siblings || []).map((item) => item.status), String(purchase.status || "Ordered"));
    const { error: parentError } = await admin
      .from("cmpri_purchases")
      .update({ status: parentStatus, updated_at: now })
      .eq("id", shipment.purchase_id)
      .eq("hotel_id", HOTEL_ID);

    if (parentError) return NextResponse.json({ error: "Shipment saved, but purchase status could not be updated. Retry to reconcile." }, { status: 500 });
    return NextResponse.json({ ok: true, kind: "shipment", id, status, purchaseStatus: parentStatus });
  }

  return NextResponse.json({ error: "kind must be purchase or shipment." }, { status: 400 });
}
