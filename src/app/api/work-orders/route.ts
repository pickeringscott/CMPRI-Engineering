import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { authenticatedUser } from "@/lib/server/request-auth";
import { isFrontDesk, isSubmitOnlyRole, roleAllows, roleKey } from "@/lib/server/roles";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { fetchAllPages } from "@/lib/server/paginated-query";
import { jsonObject } from "@/lib/integrations/spreadsheet-input";
import { validFirstName, workOrderAttribution } from "@/lib/work-order-attribution";
import { likelyDuplicate } from "@/lib/work-order-duplicates";
import { inferWorkOrder, separateIssueFromReporterNotes, type SuggestionAsset } from "@/lib/work-order-suggestions";
import { normalizeWorkOrderCategory } from "@/lib/work-order-categories";
import { processRoomRankerSyncForWorkOrder } from "@/lib/server/room-ranker";
import { currentRoomStatus, loadCurrentRoomStatuses } from "@/lib/server/room-availability";

const USER_FIELDS = ["location_id", "asset_id", "asset_name", "category", "issue", "priority", "notes"] as const;
const ACTIVE_DUPLICATE_LIMIT = 1000;

async function attachCurrentRoomStatuses<T extends { room?: unknown }>(admin: SupabaseClient, orders: T[]) {
  const roomStatuses = await loadCurrentRoomStatuses(admin);
  const statuses = roomStatuses.statuses;
  if (roomStatuses.error || !statuses) return null;
  return orders.map((order) => ({
    ...order,
    room_status: currentRoomStatus(statuses, order.room),
  }));
}

async function fetchTechnicianWorkOrders(admin: SupabaseClient, technicianName: string | undefined) {
  const query = () => admin
    .from("work_orders")
    .select("id, display_id, room, location_id, asset_id, asset_name, category, issue, priority, technician_name, status, due_by, created_at")
    .eq("hotel_id", HOTEL_ID)
    .in("status", ["Open", "In Progress"])
    .order("due_by", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  const unassignedQuery = query().or("technician_name.is.null,technician_name.eq.");
  const assignedQuery = technicianName ? query().eq("technician_name", technicianName) : null;
  const [unassigned, assigned] = await Promise.all([
    unassignedQuery,
    assignedQuery ?? Promise.resolve({ data: [], error: null }),
  ]);
  if (unassigned.error || assigned.error) return { data: null, error: unassigned.error || assigned.error };

  const data = Array.from(new Map(
    [...(assigned.data || []), ...(unassigned.data || [])].map((order) => [order.id, order]),
  ).values()).sort((a, b) => {
    const dueA = a.due_by ? Date.parse(a.due_by) : Number.POSITIVE_INFINITY;
    const dueB = b.due_by ? Date.parse(b.due_by) : Number.POSITIVE_INFINITY;
    return dueA - dueB || Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
  });
  return { data, error: null };
}

async function fetchAllAssetsForLocations(
  db: SupabaseClient,
  locationIds: string[],
): Promise<SuggestionAsset[]> {
  if (!locationIds.length) return [];

  const rows: SuggestionAsset[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await db
      .from("assets")
      .select("id, location_id, name, asset_type, manufacturer, model_number, generation, asset_tag, documentation_key, active")
      .eq("hotel_id", HOTEL_ID)
      .in("location_id", locationIds)
      .range(offset, offset + 999);

    if (error) {
      throw new Error(error.message || "Equipment could not be read.");
    }

    if (!data || !data.length) break;
    rows.push(...(data as SuggestionAsset[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  return rows;
}

function stringField(value: unknown, field: string, maximum: number, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}.`);
  const normalized = value.trim();
  if ((required && !normalized) || value.length > maximum) throw new Error(`Invalid ${field}.`);
  return normalized;
}


export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const mode = request.nextUrl.searchParams.get("mode")?.trim() || "dashboard";

  if (mode === "technician") {
    if (!roleAllows(auth.principal.profile.role, "edit_tickets")) {
      return NextResponse.json({ error: "Technician dashboard access is required." }, { status: 403 });
    }
    const technicianName = auth.principal.profile.full_name?.trim();
    const { data: workOrders, error } = await fetchTechnicianWorkOrders(
      auth.admin,
      technicianName,
    );
    if (error || !workOrders) {
      return NextResponse.json({ error: "Technician work could not be loaded." }, { status: 503 });
    }
    const enrichedOrders = await attachCurrentRoomStatuses(auth.admin, workOrders);
    if (!enrichedOrders) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });
    return NextResponse.json({ work_orders: enrichedOrders }, { headers: { "Cache-Control": "no-store" } });
  }

  if (mode === "duplicate-candidates") {
    const canViewDashboard = allows(auth.principal, "view_dashboard");
    const canViewWorkOrders = allows(auth.principal, "view_work_orders");
    const canAddNotes = allows(auth.principal, "add_work_order_notes");
    if (!canViewDashboard && !canViewWorkOrders && !canAddNotes) return NextResponse.json({ error: "Work-order access is required to inspect existing work orders." }, { status: 403 });
    if (roleKey(auth.principal.profile.role) === "technician") {
      const { data, error } = await fetchTechnicianWorkOrders(
        auth.admin,
        auth.principal.profile.full_name?.trim(),
      );
      if (error || !data) return NextResponse.json({ error: "Existing work orders could not be checked for duplicates." }, { status: 503 });
      const enrichedOrders = await attachCurrentRoomStatuses(auth.admin, data);
      if (!enrichedOrders) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });
      return NextResponse.json({ work_orders: enrichedOrders }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const canViewAllStatuses = canViewDashboard
      && (allows(auth.principal, "edit_tickets") || allows(auth.principal, "review_tickets"));
    let query = auth.admin
      .from("work_orders")
      .select("id, display_id, room, location_id, asset_id, asset_name, category, issue, priority, status")
      .eq("hotel_id", HOTEL_ID)
      .order("created_at", { ascending: false })
      .limit(500);
    if (!canViewAllStatuses) query = query.in("status", ["Open", "In Progress"]);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "Existing work orders could not be checked for duplicates." }, { status: 503 });
    const enrichedOrders = await attachCurrentRoomStatuses(auth.admin, data || []);
    if (!enrichedOrders) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });
    return NextResponse.json({ work_orders: enrichedOrders }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const canViewDashboard = allows(auth.principal, "view_dashboard");
  const canAddNotes = allows(auth.principal, "add_work_order_notes");
  if (mode !== "dashboard" || (!canViewDashboard && !allows(auth.principal, "view_work_orders") && !canAddNotes)) {
    return NextResponse.json({ error: "Work-order access is required." }, { status: 403 });
  }
  if (roleKey(auth.principal.profile.role) === "technician") {
    const { data, error } = await fetchTechnicianWorkOrders(
      auth.admin,
      auth.principal.profile.full_name?.trim(),
    );
    if (error || !data) return NextResponse.json({ error: "Work orders could not be loaded." }, { status: 503 });
    const enrichedOrders = await attachCurrentRoomStatuses(auth.admin, data);
    if (!enrichedOrders) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });
    return NextResponse.json({ work_orders: enrichedOrders }, { headers: { "Cache-Control": "no-store" } });
  }
  const canViewAllStatuses = canViewDashboard
    && (allows(auth.principal, "edit_tickets") || allows(auth.principal, "review_tickets"));
  const { data, error } = await fetchAllPages((from, to) => {
    let query = auth.admin
    .from("work_orders")
    .select("id, display_id, room, asset_name, category, issue, priority, technician_name, status, due_by, created_at")
    .eq("hotel_id", HOTEL_ID)
    .order("created_at", { ascending: false })
    .range(from, to);
    if (!canViewAllStatuses) query = query.in("status", ["Open", "In Progress"]);
    return query;
  });
  if (error) return NextResponse.json({ error: "Work orders could not be loaded." }, { status: 503 });
  const enrichedOrders = await attachCurrentRoomStatuses(auth.admin, data || []);
  if (!enrichedOrders) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });
  return NextResponse.json({ work_orders: enrichedOrders }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await authenticatedUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!roleAllows(auth.profile.role, "submit")) return NextResponse.json({ error: "Your account cannot create work orders." }, { status: 403 });
  const body = await jsonObject(request);
  if (!body || !Array.isArray(body.orders) || body.orders.length < 1 || body.orders.length > 20) {
    return NextResponse.json({ error: "Submit between 1 and 20 work orders." }, { status: 400 });
  }

  const sourceDraftId = typeof body.source_draft_id === "string" ? body.source_draft_id.trim() : "";
  const sourceDraftRevision = typeof body.source_draft_revision === "number" ? body.source_draft_revision : null;
  let sourceDraft: Record<string, unknown> | null = null;
  let attribution: ReturnType<typeof workOrderAttribution> & Record<string, unknown>;
  const canSetEngineeringFields = roleAllows(auth.profile.role, "edit_tickets")
    || roleAllows(auth.profile.role, "review_tickets");
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });

  if (sourceDraftId) {
    const { data: draft, error: draftError } = await admin
      .from("cmpri_work_order_drafts")
      .select("*")
      .eq("hotel_id", HOTEL_ID)
      .eq("id", sourceDraftId)
      .maybeSingle();
    if (draftError) return NextResponse.json({ error: "The source draft could not be verified." }, { status: 503 });
    if (!draft) return NextResponse.json({ error: "The source draft no longer exists." }, { status: 409 });
    if (sourceDraftRevision === null || sourceDraftRevision !== Number(draft.revision)) {
      return NextResponse.json({ error: "This draft changed. Reload it before submitting." }, { status: 409 });
    }

    const { data: draftCreator, error: creatorError } = await admin
      .from("profiles")
      .select("id, full_name, role, active")
      .eq("id", draft.created_by)
      .maybeSingle();
    if (creatorError) return NextResponse.json({ error: "The draft creator could not be verified." }, { status: 503 });
    if (!draftCreator) return NextResponse.json({ error: "The draft creator no longer has a profile." }, { status: 409 });

    const ownDraft = String(draft.created_by) === auth.user.id;
    if (!ownDraft && !roleAllows(auth.profile.role, "review_tickets")) {
      return NextResponse.json({ error: "Only the submitter or an engineer/System Administrator can submit this draft." }, { status: 403 });
    }

    const draftFrontDesk = isFrontDesk(draftCreator.role);
    const draftSubmitOnly = isSubmitOnlyRole(draftCreator.role);
    const firstName = typeof draft.staff_first_name === "string" ? draft.staff_first_name.trim() : "";
    if (draftFrontDesk && !validFirstName(firstName)) {
      return NextResponse.json({ error: "This front-desk draft is missing the required first name." }, { status: 400 });
    }
    attribution = {
      created_by: draftCreator.id,
      creator_account_user_id: draftCreator.id,
      creator_name: draftFrontDesk ? firstName : draftCreator.full_name?.trim() || "Unknown User",
      submitted_by_name: draftFrontDesk ? firstName : null,
      creator_source: ownDraft
        ? draftSubmitOnly
          ? "department_pending_verification"
          : "signed_in_user"
        : "draft_submitted_by_supervisor",
      status: draftSubmitOnly ? "Pending Verification" : "Open",
      source_draft_id: draft.id,
      source_draft_created_by: draftCreator.id,
      source_draft_creator_name: draftFrontDesk ? firstName : draftCreator.full_name?.trim() || "Unknown User",
      submitted_by_user_id: auth.user.id,
    };
    sourceDraft = draft as Record<string, unknown>;
  } else {
    try {
      attribution = {
        ...workOrderAttribution(
          { id: auth.user.id, email: auth.user.email || undefined },
          auth.profile,
          body.staff_first_name,
        ),
        submitted_by_user_id: auth.user.id,
      };
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid submitter." }, { status: 400 });
    }
  }
  const rows: Record<string, unknown>[] = [];
  try {
    for (const value of body.orders) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid work-order details.");
      const source = value as Record<string, unknown>;
      const row: Record<string, unknown> = {};
      for (const field of USER_FIELDS) {
        if (!canSetEngineeringFields && ["asset_id", "asset_name", "category", "priority"].includes(field)) continue;
        const item = source[field];
        if (field === "asset_id" && item === null) { row[field] = null; continue; }
        const maximum = field === "notes" ? 20000 : field === "issue" ? 4000 : 500;
        const normalized = stringField(item, field, maximum, field === "location_id" || field === "issue");
        if (normalized !== undefined) row[field] = normalized;
      }
      if (!row.location_id || !row.issue) throw new Error("Room/location and issue are required.");
      const { issue: cleanIssue, reporterNotes } = separateIssueFromReporterNotes(String(row.issue));
      if (!cleanIssue) throw new Error("A maintenance issue is required. Add comments to an existing work order's notes.");
      row.issue = cleanIssue;
      if (reporterNotes) {
        const existingNotes = typeof row.notes === "string" ? row.notes.trim() : "";
        row.notes = [existingNotes, reporterNotes].filter(Boolean).join("\n");
      }
      if (canSetEngineeringFields && row.category !== undefined) {
        const normalizedCategory = normalizeWorkOrderCategory(row.category);
        if (!normalizedCategory) throw new Error("Select a valid work-order category.");
        row.category = normalizedCategory;
      }
      if (sourceDraft && String(row.location_id) !== String(sourceDraft.location_id)) {
        throw new Error("All work orders created from a draft must remain in the draft's room/location.");
      }
      rows.push({
        ...row,
        hotel_id: HOTEL_ID,
        ...attribution,
        technician_name: "",
        action_root_cause: "",
        parts: "",
        cost: 0,
        hours: 0,
      });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid work-order details." }, { status: 400 });
  }

  const db = admin;
  const uniqueLocationIds = Array.from(new Set(rows.map((row) => String(row.location_id))));
  const { data: locations, error: locationError } = await db.from("locations")
    .select("id, name, active")
    .eq("hotel_id", HOTEL_ID)
    .in("id", uniqueLocationIds);
  if (locationError) return NextResponse.json({ error: "Unable to verify the selected locations." }, { status: 503 });
  for (const row of rows) {
    const location = locations?.find((item) => item.id === row.location_id && item.active !== false);
    if (!location) return NextResponse.json({ error: "A selected location is unavailable." }, { status: 400 });
    row.room = location.name;
  }

  if (!canSetEngineeringFields) {
    try {
      const availableAssets = await fetchAllAssetsForLocations(db, uniqueLocationIds);
      for (const row of rows) {
        const candidates = availableAssets.filter((asset) => asset.location_id === row.location_id && asset.active !== false);
        const guess = inferWorkOrder(String(row.issue || ""), candidates);
        row.asset_id = guess.assetId;
        row.asset_name = candidates.find((asset) => asset.id === guess.assetId)?.name || "";
        row.category = guess.category || "General";
        row.priority = guess.priority || "Medium";
      }
    } catch {
      return NextResponse.json({ error: "Equipment guesses could not be checked completely. No tickets were created." }, { status: 503 });
    }
  }

  for (const row of rows) {
    if (!row.asset_id && (!row.category || String(row.category).trim() === "General")) {
      const suggestion = inferWorkOrder(String(row.issue || ""), []);
      if (suggestion.category) row.category = suggestion.category;
      if (suggestion.priority) row.priority = suggestion.priority;
    }
  }

  const assetIds = Array.from(new Set(rows.map((row) => row.asset_id).filter((id): id is string => typeof id === "string" && Boolean(id))));
  if (assetIds.length) {
    const { data: assets, error: assetError } = await db.from("assets")
      .select("id, location_id, name, active")
      .eq("hotel_id", HOTEL_ID)
      .in("id", assetIds);
    if (assetError) return NextResponse.json({ error: "Unable to verify the selected equipment." }, { status: 503 });
    for (const row of rows) {
      if (!row.asset_id) continue;
      const asset = assets?.find((item) => item.id === row.asset_id && item.location_id === row.location_id && item.active !== false);
      if (!asset) return NextResponse.json({ error: "Equipment does not match the selected location." }, { status: 400 });
      row.asset_name = asset.name;
    }
  }

  for (let index = 0; index < rows.length; index += 1) {
    if (rows.slice(0, index).some((previous) => likelyDuplicate(rows[index], previous))) {
      return NextResponse.json({ error: "This report contains overlapping work orders for the same location. Combine them before submitting." }, { status: 409 });
    }
  }

  const { data: existing, error: duplicateError } = await db.from("work_orders")
    .select("id, display_id, location_id, asset_id, issue, status")
    .eq("hotel_id", HOTEL_ID)
    .in("location_id", uniqueLocationIds)
    .limit(ACTIVE_DUPLICATE_LIMIT);
  if (duplicateError || !existing || existing.length >= ACTIVE_DUPLICATE_LIMIT) {
    return NextResponse.json({ error: "Existing work orders could not be checked completely. No tickets were created." }, { status: 503 });
  }
  for (const row of rows) {
    const duplicate = existing.find((previous) => likelyDuplicate(row, previous));
    if (duplicate) {
      return NextResponse.json({
        error: `Possible duplicate: ${duplicate.display_id || "existing work order"}. Review the existing ticket before submitting.`,
        existing_work_order_id: duplicate.id,
      }, { status: 409 });
    }
  }

  const insertOp = db.from("work_orders").insert(rows) as unknown as { select?: (cols: string) => Promise<{ data: unknown; error: unknown }> } & Promise<{ data: unknown; error: unknown }>;
  const insertResult = typeof insertOp?.select === "function"
    ? await insertOp.select("id, display_id, status")
    : await insertOp;
  const saved = (insertResult && (insertResult as { data?: Array<{ id: string; display_id?: string; status?: string }> }).data) || null;
  const insertError = insertResult && (insertResult as { error?: unknown }).error;
  if (insertError) {
    return NextResponse.json({ error: "Work orders could not be saved. Refresh the list before retrying." }, { status: 409 });
  }


  if (saved?.length) {
    await Promise.allSettled(saved.map((item) => processRoomRankerSyncForWorkOrder(admin, String(item.id))));
  }

  if (sourceDraft && admin) {
    const { error: draftDeleteError } = await admin
      .from("cmpri_work_order_drafts")
      .delete()
      .eq("hotel_id", HOTEL_ID)
      .eq("id", sourceDraftId)
      .eq("revision", sourceDraftRevision);
    if (draftDeleteError) {
      return NextResponse.json({
        ok: true,
        count: saved?.length || rows.length,
        work_orders: saved || [],
        warning: "The work order was created, but the source draft could not be removed automatically.",
      });
    }
  }

  return NextResponse.json({ ok: true, count: saved?.length || rows.length, work_orders: saved || [] });
}
