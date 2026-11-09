import { NextRequest, NextResponse } from "next/server";
import { parseOperationalEmail, type ParsedEmail } from "@/lib/integrations/email-parser";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { fetchOperationalMessages, type OperationalMessage } from "@/lib/integrations/email-provider";
import { mergedPurchaseStatus, parentStatusFromShipments, matchEnseoWorkOrder } from "@/lib/integrations/operations";
import { isIntegrationsSafeMode } from "@/lib/server/integrations-safe-mode";

type Admin = NonNullable<ReturnType<typeof createSupabaseAdmin>>;

function externalStatus(text: string, warranty = false) {
  const lower = text.toLowerCase();
  if (warranty && /\brefund(?:ed| issued| processed)\b/.test(lower)) return "Refunded";
  if (warranty && /\bcredit (?:memo|issued|processed)\b/.test(lower)) return "Credit Issued";
  if (warranty && /\breturn (?:authorized|authorization|approved)\b/.test(lower)) return "Return Authorized";
  if (warranty && /\breplacement\b.*\breceived\b|\breceived\b.*\breplacement\b/.test(lower)) return "Replacement Received";
  if (warranty && /\breplacement\b.*\bdelivered\b|\bdelivered\b.*\breplacement\b/.test(lower)) return "Replacement Delivered";
  if (warranty && /\breplacement\b.*\bshipped\b|\bshipped\b.*\breplacement\b/.test(lower)) return "Replacement Shipped";
  if (/\bclosed\b|\bresolved\b|\bcomplete(?:d)?\b/.test(lower)) return "Closed";
  if (/\bawaiting\b|\bpending\b/.test(lower)) return "Pending";
  if (/\bopen\b/.test(lower)) return "Open";
  return "Updated";
}

function carrierFrom(text: string, trackingNumber: string) {
  const lower = text.toLowerCase();
  if (/\bups\b/.test(lower) || /^1Z/i.test(trackingNumber)) return "UPS";
  if (/\bfedex\b|\bfederal express\b/.test(lower)) return "FedEx";
  if (/\busps\b|\bpostal service\b/.test(lower)) return "USPS";
  if (/\bdhl\b/.test(lower)) return "DHL";
  return null;
}


async function findWorkOrder(admin: Admin, parsed: ParsedEmail) {
  if (parsed.workOrderRef) {
    const normalized = parsed.workOrderRef.replace(/\s+/g, "-");
    const { data } = await admin.from("work_orders").select("id, display_id").eq("hotel_id", HOTEL_ID).ilike("display_id", normalized).maybeSingle();
    if (data?.id) return data.id as string;
  }
  if (parsed.category !== "enseo" || !parsed.roomNumber) return null;
  const { data } = await admin.from("work_orders").select("id, room, issue, status, created_at").eq("hotel_id", HOTEL_ID).order("created_at", { ascending: false }).limit(150);
  return matchEnseoWorkOrder(data || [], parsed.roomNumber, parsed.enseoEndpoint);
}

async function saveOperationalRecord(admin: Admin, message: OperationalMessage) {
  const { from, to, subject, text, direction, messageAt } = message;
  let parsed = parseOperationalEmail({ subject, text, from, to, direction, messageAt });
  const threadKey = `thread:${message.threadId || message.id}`;

  // A reply from a supplier can be ordinary prose that no longer repeats the
  // words "missing item". Keep following the Gmail thread once CMPRI opened a
  // supplier follow-up on that thread.
  if (parsed.category === "other" && direction === "inbound" && message.threadId) {
    const { data: openFollowup } = await admin.from("cmpri_supplier_followups").select("id").eq("hotel_id", HOTEL_ID).eq("external_key", threadKey).maybeSingle();
    if (openFollowup?.id) parsed = { ...parsed, category: "supplier_followup", confidence: 0.98, followupStatus: "Vendor Responded" };
  }
  if (parsed.category === "other") return { skipped: true };

  const { data: existingMessage, error: lookupError } = await admin.from("cmpri_email_events").select("id, processed_at").eq("hotel_id", HOTEL_ID).eq("gmail_message_id", message.id).maybeSingle();
  if (lookupError) throw new Error(`Email lookup failed: ${lookupError.message}`);
  if (existingMessage?.processed_at) return { duplicate: true };

  const { data: event, error: eventError } = await admin.from("cmpri_email_events").upsert({
    hotel_id: HOTEL_ID,
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId || null,
    direction,
    category: parsed.category,
    confidence: parsed.confidence,
    subject,
    from_address: from,
    to_address: to,
    message_at: messageAt,
    parsed,
    body_text: text.slice(0, 50000),
  }, { onConflict: "gmail_message_id" }).select("id").single();
  if (eventError) throw new Error(`Email event save failed: ${eventError.message}`);

  const workOrderId = await findWorkOrder(admin, parsed);
  const eventId = event.id as string;
  const fullText = `${subject}\n${text}`;

  if (parsed.category === "purchase" || parsed.category === "shipping") {
    const externalKey = parsed.orderNumber || threadKey;
    const { data: previous } = await admin.from("cmpri_purchases").select("*").eq("hotel_id", HOTEL_ID).eq("external_key", externalKey).maybeSingle();
    // A receipt email proves receipt of the mentioned package, not every PO line.
    const incomingStatus = parsed.purchaseStatus === "Received" ? "Partially Received" : parsed.purchaseStatus || (parsed.category === "shipping" ? "Shipped" : "Ordered");
    const status = mergedPurchaseStatus(previous?.status, incomingStatus);
    const { data: purchase, error } = await admin.from("cmpri_purchases").upsert({
      hotel_id: HOTEL_ID,
      external_key: externalKey,
      order_number: parsed.orderNumber || previous?.order_number || null,
      vendor: parsed.vendor || previous?.vendor || null,
      status,
      ordered_at: previous?.ordered_at || (parsed.category === "purchase" ? messageAt : null),
      eta: parsed.eta || previous?.eta || null,
      work_order_id: workOrderId || previous?.work_order_id || null,
      last_email_event_id: eventId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hotel_id,external_key" }).select("id, status").single();
    if (error) throw new Error(`Purchase save failed: ${error.message}`);

    for (const trackingNumber of parsed.trackingNumbers) {
      const { data: previousShipment } = await admin.from("cmpri_purchase_shipments").select("*").eq("purchase_id", purchase.id).eq("tracking_number", trackingNumber).maybeSingle();
      const shipmentStatus = mergedPurchaseStatus(previousShipment?.status, parsed.purchaseStatus || "Shipped");
      const { error: shipmentError } = await admin.from("cmpri_purchase_shipments").upsert({
        purchase_id: purchase.id,
        tracking_number: trackingNumber,
        carrier: previousShipment?.carrier || carrierFrom(fullText, trackingNumber),
        ship_from: parsed.shipFrom || previousShipment?.ship_from || null,
        status: shipmentStatus,
        shipped_at: previousShipment?.shipped_at || (/[Ss]hipped/.test(shipmentStatus) ? messageAt : null),
        delivered_at: previousShipment?.delivered_at || (shipmentStatus === "Delivered" ? messageAt : null),
        received_at: previousShipment?.received_at || (shipmentStatus === "Received" ? messageAt : null),
        eta: parsed.eta || previousShipment?.eta || null,
        last_email_event_id: eventId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "purchase_id,tracking_number" });
      if (shipmentError) throw new Error(`Shipment save failed: ${shipmentError.message}`);
    }

    const { data: shipments, error: shipmentsError } = await admin.from("cmpri_purchase_shipments").select("status").eq("purchase_id", purchase.id);
    if (shipmentsError) throw new Error(`Shipment aggregate lookup failed: ${shipmentsError.message}`);
    const aggregate = parentStatusFromShipments((shipments || []).map(row => row.status), purchase.status || status);
    if (aggregate !== purchase.status) {
      const { error: aggregateError } = await admin.from("cmpri_purchases").update({ status: aggregate, updated_at: new Date().toISOString() }).eq("id", purchase.id);
      if (aggregateError) throw new Error(`Shipment aggregate update failed: ${aggregateError.message}`);
    }
  }

  if (parsed.category === "enseo") {
    const externalKey = parsed.enseoTicketNumber || threadKey;
    const { data: previous } = await admin.from("cmpri_enseo_tickets").select("*").eq("hotel_id", HOTEL_ID).eq("external_key", externalKey).maybeSingle();
    const { error } = await admin.from("cmpri_enseo_tickets").upsert({
      hotel_id: HOTEL_ID,
      external_key: externalKey,
      ticket_number: parsed.enseoTicketNumber || previous?.ticket_number || null,
      room_number: parsed.roomNumber || previous?.room_number || null,
      enseo_endpoint: parsed.enseoEndpoint || previous?.enseo_endpoint || null,
      status: externalStatus(fullText),
      work_order_id: workOrderId || previous?.work_order_id || null,
      subject,
      last_email_event_id: eventId,
      last_update_at: messageAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hotel_id,external_key" });
    if (error) throw new Error(`Enseo ticket save failed: ${error.message}`);
  }

  if (parsed.category === "warranty") {
    const externalKey = parsed.rmaNumber || parsed.warrantyCaseNumber || threadKey;
    const { data: previous } = await admin.from("cmpri_warranty_cases").select("*").eq("hotel_id", HOTEL_ID).eq("external_key", externalKey).maybeSingle();
    const combinedTracking = Array.from(new Set([...(Array.isArray(previous?.tracking_numbers) ? previous.tracking_numbers : []), ...parsed.trackingNumbers]));
    const { error } = await admin.from("cmpri_warranty_cases").upsert({
      hotel_id: HOTEL_ID,
      external_key: externalKey,
      warranty_case_number: parsed.warrantyCaseNumber || previous?.warranty_case_number || null,
      rma_number: parsed.rmaNumber || previous?.rma_number || null,
      vendor: parsed.vendor || previous?.vendor || null,
      status: externalStatus(fullText, true),
      work_order_id: workOrderId || previous?.work_order_id || null,
      last_email_event_id: eventId,
      tracking_numbers: combinedTracking,
      ship_from: parsed.shipFrom || previous?.ship_from || null,
      eta: parsed.eta || previous?.eta || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hotel_id,external_key" });
    if (error) throw new Error(`Warranty save failed: ${error.message}`);
  }

  if (parsed.category === "supplier_followup") {
    const externalKey = threadKey;
    const { data: previous } = await admin.from("cmpri_supplier_followups").select("*").eq("hotel_id", HOTEL_ID).eq("external_key", externalKey).maybeSingle();
    let purchaseId: string | null = previous?.purchase_id || null;
    if (!purchaseId && parsed.orderNumber) {
      const { data } = await admin.from("cmpri_purchases").select("id").eq("hotel_id", HOTEL_ID).eq("order_number", parsed.orderNumber).maybeSingle();
      purchaseId = data?.id || null;
    }
    const status = direction === "inbound" ? "Vendor Responded" : (parsed.followupStatus || previous?.status || "Vendor Contacted — Awaiting Response");
    const { error } = await admin.from("cmpri_supplier_followups").upsert({
      hotel_id: HOTEL_ID,
      external_key: externalKey,
      purchase_id: purchaseId,
      work_order_id: workOrderId || previous?.work_order_id || null,
      topic: previous?.topic || subject,
      status,
      last_outbound_at: direction === "outbound" ? messageAt : previous?.last_outbound_at || null,
      last_inbound_at: direction === "inbound" ? messageAt : previous?.last_inbound_at || null,
      last_email_event_id: eventId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hotel_id,external_key" });
    if (error) throw new Error(`Supplier follow-up save failed: ${error.message}`);
  }

  // A GSS discussion or an image-only message can classify as GSS without
  // producing scores. Do not replace an existing weekly report with it.
  if (parsed.category === "gss" && Object.keys(parsed.gssScores).length > 0) {
    const date = new Date(messageAt);
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
    const reportWeek = date.toISOString().slice(0, 10);
    const { error } = await admin.from("cmpri_gss_reports").upsert({
      hotel_id: HOTEL_ID,
      report_week: reportWeek,
      subject,
      scores: parsed.gssScores,
      source_email_event_id: eventId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hotel_id,report_week" });
    if (error) throw new Error(`GSS report save failed: ${error.message}`);
  }

  const { error: completedError } = await admin.from("cmpri_email_events").update({ processed_at: new Date().toISOString() }).eq("id", eventId);
  if (completedError) throw new Error(`Email completion failed: ${completedError.message}`);
  return { saved: true, category: parsed.category };
}

async function authorized(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const bearer = request.headers.get("authorization") || "";
  if (cronSecret && bearer === `Bearer ${cronSecret}`) return true;
  return Boolean(await requireCapability(request, "operate_integrations"));
}

async function scan(request: NextRequest) {
  if (!(await authorized(request))) {
    const auth = await requireUser(request);
    if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
    return NextResponse.json({ error: "Email integration access is required." }, { status: 403 });
  }
  if (isIntegrationsSafeMode()) {
    return NextResponse.json({
      configured: false,
      safeMode: true,
      blocked: true,
      error: "Safe mode is on: mailbox scan was NOT sent to an external provider.",
    }, { status: 503 });
  }
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase service configuration is missing." }, { status: 503 });
  try {
    const { provider, messages, truncated, alreadyProcessed = 0 } = await fetchOperationalMessages({
      completedGmailIds: async ids => {
        const { data, error } = await admin.from("cmpri_email_events").select("gmail_message_id")
          .eq("hotel_id", HOTEL_ID).in("gmail_message_id", ids).not("processed_at", "is", null);
        if (error) throw new Error("Completed email events could not be checked.");
        return new Set((data || []).map(row => row.gmail_message_id as string));
      },
    });
    if (!provider) return NextResponse.json({ configured: false, error: "Configure a read-only Microsoft 365 or Gmail mailbox before scanning." }, { status: 503 });
    let saved = 0, duplicates = alreadyProcessed, skipped = 0;
    const categories: Record<string, number> = {};
    const errors: string[] = [];
    for (const message of messages) {
      try {
        const result = await saveOperationalRecord(admin, message);
        if (result.saved) {
          saved++;
          if (result.category) categories[result.category] = (categories[result.category] || 0) + 1;
        } else if (result.duplicate) duplicates++;
        else skipped++;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Email import failed.");
        if (errors.length >= 10) break;
      }
    }
    const complete = !truncated && errors.length === 0;
    return NextResponse.json({ configured: true, provider, complete, truncated, found: messages.length + alreadyProcessed, saved, duplicates, skipped, categories, errors }, { status: errors.length ? 502 : 200 });
  } catch (error) {
    return NextResponse.json({ configured: false, error: error instanceof Error ? error.message : "Mailbox scan failed." }, { status: 503 });
  }
}

// GET is reserved for the scheduler; manual writes require POST.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return scan(request);
}

export async function POST(request: NextRequest) {
  return scan(request);
}
