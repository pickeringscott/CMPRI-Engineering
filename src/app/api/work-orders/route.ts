import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { authenticatedUser } from "@/lib/server/request-auth";
import { canSuperviseDraftRole, isFrontDesk, isSubmitOnlyRole, roleAllows } from "@/lib/server/roles";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { jsonObject } from "@/lib/integrations/spreadsheet-input";
import { validFirstName, workOrderAttribution } from "@/lib/work-order-attribution";
import { likelyDuplicate } from "@/lib/work-order-duplicates";
import { inferWorkOrder, separateIssueFromReporterNotes } from "@/lib/work-order-suggestions";
import { normalizeWorkOrderCategory } from "@/lib/work-order-categories";
import { processRoomRankerSyncForWorkOrder } from "@/lib/server/room-ranker";

const USER_FIELDS = ["location_id", "asset_id", "asset_name", "category", "issue", "priority", "notes"] as const;
const ACTIVE_DUPLICATE_LIMIT = 1000;

function callerDatabase(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const authorization = request.headers.get("authorization") || "";
  if (!url || !key || !authorization) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: authorization } },
  });
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

  if (mode === "duplicate-candidates") {
    if (!allows(auth.principal, "view_dashboard")) return NextResponse.json({ error: "Dashboard access is required to inspect existing work orders." }, { status: 403 });
    const { data, error } = await auth.admin
      .from("work_orders")
      .select("id, display_id, room, location_id, asset_id, asset_name, category, issue, priority, status")
      .eq("hotel_id", HOTEL_ID)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return NextResponse.json({ error: "Existing work orders could not be checked for duplicates." }, { status: 503 });
    return NextResponse.json({ work_orders: data || [] }, { headers: { "Cache-Control": "private, no-store" } });
  }

  if (mode !== "dashboard" || !allows(auth.principal, "view_dashboard")) {
    return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  }
  const { data, error } = await auth.admin
    .from("work_orders")
    .select("id, display_id, room, asset_name, category, issue, priority, technician_name, status, due_by, created_at")
    .eq("hotel_id", HOTEL_ID)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return NextResponse.json({ error: "Work orders could not be loaded." }, { status: 503 });
  if ((data || []).length >= 2000) {
    return NextResponse.json({ error: "The dashboard result reached its safety limit. Narrow or archive old records before relying on this view." }, { status: 503 });
  }
  return NextResponse.json({ work_orders: data || [] }, { headers: { "Cache-Control": "no-store" } });
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
  let submitOnly = isSubmitOnlyRole(auth.profile.role);
  const admin = auth.admin ?? createSupabaseAdmin();

  if (sourceDraftId) {
    if (!admin) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });
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
    if (!ownDraft && !canSuperviseDraftRole(auth.profile.role, draftCreator.role)) {
      return NextResponse.json({ error: "You cannot submit this employee's draft." }, { status: 403 });
    }

    const draftFrontDesk = isFrontDesk(draftCreator.role);
    const draftSubmitOnly = isSubmitOnlyRole(draftCreator.role);
    const firstName = typeof draft.staff_first_name === "string" ? draft.staff_first_name.trim() : "";
    if (draftFrontDesk && !validFirstName(firstName)) {
      return NextResponse.json({ error: "This front-desk draft is missing the required first name." }, { status: 400 });
    }
    submitOnly = draftSubmitOnly;
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
        if (submitOnly && ["asset_id", "asset_name", "category", "priority"].includes(field)) continue;
        const item = source[field];
        if (field === "asset_id" && item === null) { row[field] = null; continue; }
        const maximum = field === "notes" ? 20000 : field === "issue" ? 4000 : 500;
        const normalized = stringField(item, field, maximum, field === "location_id" || field === "issue");
        if (normalized !== undefined) row[field] = normalized;
      }
      if (!row.location_id || !row.issue) throw new Error("Room/location and issue are required.");
      const { issue: cleanIssue, reporterNotes } = separateIssueFromReporterNotes(String(row.issue));
      if (cleanIssue) row.issue = cleanIssue;
      if (reporterNotes) {
        const existingNotes = typeof row.notes === "string" && row.notes.trim() ? `${row.notes.trim()}\n` : "";
        row.reporter_notes = `${existingNotes}${reporterNotes}`;
      }
      if (!submitOnly && row.category !== undefined) {
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

  const db = sourceDraft ? admin : callerDatabase(request);
  if (!db) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });
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

  if (submitOnly) {
    const { data: availableAssets, error: assetError } = await db.from("assets")
      .select("id, location_id, name, asset_type, manufacturer, model_number, generation, asset_tag, documentation_key, active")
      .eq("hotel_id", HOTEL_ID)
      .in("location_id", uniqueLocationIds)
      .limit(1000);
    if (assetError || !availableAssets || availableAssets.length >= 1000) {
      return NextResponse.json({ error: "Equipment guesses could not be checked completely. No tickets were created." }, { status: 503 });
    }
    for (const row of rows) {
      const candidates = availableAssets.filter((asset) => asset.location_id === row.location_id && asset.active !== false);
      const guess = inferWorkOrder(`${row.issue} ${row.notes || ""}`.trim(), candidates);
      row.asset_id = guess.assetId;
      row.asset_name = candidates.find((asset) => asset.id === guess.assetId)?.name || "";
      row.category = guess.category || "General";
      row.priority = guess.priority || "Medium";
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

  if (saved?.length && admin) {
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
