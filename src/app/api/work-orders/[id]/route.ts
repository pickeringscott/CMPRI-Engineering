import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase/config";
import { allows } from "@/lib/server/access";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { normalizeWorkOrderCategory } from "@/lib/work-order-categories";
import { processRoomRankerSyncForWorkOrder } from "@/lib/server/room-ranker";
import { roleKey } from "@/lib/server/roles";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";

const ALL_STATUSES = ["Pending Verification", "Open", "In Progress", "Completed", "Will Not Do", "Closed"] as const;
const TECHNICAL_FIELDS = [
  "issue", "asset_id", "asset_name", "category", "priority", "technician_name", "status", "notes",
  "action_root_cause", "parts", "cost", "hours", "due_by",
] as const;
const REVIEW_FIELDS = ["status", "notes"] as const;

function callerDatabase(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY;
  const authorization = request.headers.get("authorization") || "";
  if (!url || !key || !authorization) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: authorization } },
  });
}

async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function validateDueDate(value: unknown) {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const pattern = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  if (!pattern.test(value) || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10); }
  catch { return false; }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth || (!allows(auth.principal, "view_dashboard") && !allows(auth.principal, "edit_tickets"))) {
    return NextResponse.json({ error: "Work-order access is required." }, { status: 403 });
  }

  const { id } = await params;
  const includeMentions = request.nextUrl.searchParams.get("include") === "mentions";
  const { data: workOrder, error: workOrderError } = await auth.admin
    .from("work_orders")
    .select("*")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (workOrderError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!workOrder) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  if (!canAccessWorkOrderByAssignment(auth.principal.profile.role, auth.principal.profile.full_name, workOrder)) {
    return NextResponse.json({ error: "This work order is not assigned to you." }, { status: 403 });
  }

  let creatorRole: string | null = null;
  if (workOrder.created_by) {
    if (String(workOrder.created_by) === String(auth.principal.identity.id)) {
      creatorRole = auth.principal.profile.role || null;
    } else {
      const { data: creator } = await auth.admin
        .from("profiles")
        .select("role")
        .eq("id", workOrder.created_by)
        .maybeSingle();
      creatorRole = creator?.role || null;
    }
  }

  let mentionTickets: Array<Record<string, unknown>> = [];
  if (includeMentions) {
    let mentionQuery = auth.admin
      .from("work_orders")
      .select("id, display_id, room, issue, status, created_at")
      .eq("hotel_id", HOTEL_ID)
      .neq("id", id)
      .order("created_at", { ascending: false })
      .limit(300);
    if (roleKey(auth.principal.profile.role) === "technician") {
      mentionQuery = mentionQuery.eq("technician_name", auth.principal.profile.full_name?.trim() || "");
    }
    const { data: mentionRows, error: mentionError } = await mentionQuery;
    if (mentionError) return NextResponse.json({ error: "Could not read related work-order references." }, { status: 503 });
    mentionTickets = (mentionRows ?? []) as Array<Record<string, unknown>>;
  }

  return NextResponse.json({ workOrder: { ...workOrder, creator_role: creatorRole }, mentionTickets }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Work-order editing or review permission is required." }, { status: 403 });
  const canEdit = allows(auth.principal, "edit_tickets");
  const canReview = allows(auth.principal, "review_tickets");
  if (!canEdit && !canReview) return NextResponse.json({ error: "Work-order editing or review permission is required." }, { status: 403 });

  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const { id } = await params;
  const db = callerDatabase(request);
  if (!db) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });

  const { data: existing, error: lookupError } = await db.from("work_orders")
    .select("id, status, location_id, asset_id, asset_name, technician_name, last_assigned_technician_name, revision")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  const technicianEdit = roleKey(auth.principal.profile.role) === "technician";
  if (!canAccessWorkOrderByAssignment(auth.principal.profile.role, auth.principal.profile.full_name, existing)) {
    return NextResponse.json({ error: "This work order is not assigned to you." }, { status: 403 });
  }

  if (typeof body.expected_revision !== "number" || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1) {
    return NextResponse.json({ error: "Reload this ticket before saving so its current version can be checked." }, { status: 428 });
  }
  if (body.expected_revision !== existing.revision) {
    return NextResponse.json({ error: "Someone changed this ticket since you opened it. Your edits were not saved. Reload before combining the changes." }, { status: 409 });
  }

  const allowedFields: readonly string[] = technicianEdit
    ? ["asset_id", "category", "status", "notes"]
    : canEdit ? TECHNICAL_FIELDS : REVIEW_FIELDS;
  const allowedFieldSet = new Set(allowedFields);
  const update: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
  }
  const attemptedProtected = TECHNICAL_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field) && !allowedFieldSet.has(field));
  if (attemptedProtected) return NextResponse.json({ error: "Your role cannot change technical work-order fields." }, { status: 403 });
  if (!Object.keys(update).length) return NextResponse.json({ error: "No editable changes were supplied." }, { status: 400 });

  if (update.status !== undefined && (typeof update.status !== "string" || !ALL_STATUSES.includes(update.status as typeof ALL_STATUSES[number]))) {
    return NextResponse.json({ error: "Invalid work-order status." }, { status: 400 });
  }
  if (technicianEdit && update.status !== undefined && !["Open", "In Progress", "Completed"].includes(String(update.status))) {
    return NextResponse.json({ error: "Technicians may set work only to Open, In Progress, or Completed." }, { status: 403 });
  }

  if (!canEdit) {
    if (existing.status !== "Pending Verification") {
      return NextResponse.json({ error: "Management review is limited to pending requests." }, { status: 403 });
    }
    if (update.status !== undefined && !["Open", "Will Not Do"].includes(String(update.status))) {
      return NextResponse.json({ error: "Management can approve a pending request to Open or mark it Will Not Do." }, { status: 403 });
    }
  }

  if (existing.status === "Closed" && update.status !== undefined && update.status !== "Closed") {
    if (!allows(auth.principal, "reopen")) {
      return NextResponse.json({ error: "Only an Engineer or system administrator can reopen a closed work order." }, { status: 403 });
    }
    if (!["In Progress", "Completed"].includes(String(update.status))) {
      return NextResponse.json({ error: "A closed work order can be reopened to In Progress or Completed." }, { status: 400 });
    }
  }

  if (update.status === "Closed" && !allows(auth.principal, "close_tickets")) {
    return NextResponse.json({ error: "Closing permission is required." }, { status: 403 });
  }

  const textLimits: Record<string, number> = {
    issue: 4000,
    asset_name: 500,
    category: 500,
    technician_name: 500,
    notes: 200000,
    action_root_cause: 20000,
    parts: 20000,
  };
  for (const [field, maximum] of Object.entries(textLimits)) {
    if (!(field in update)) continue;
    const value = update[field];
    if (typeof value !== "string" || value.length > maximum || (["issue", "category"].includes(field) && !value.trim())) {
      return NextResponse.json({ error: `Invalid ${field}.` }, { status: 400 });
    }
  }
  if ("category" in update) {
    const normalizedCategory = normalizeWorkOrderCategory(update.category);
    if (!normalizedCategory) return NextResponse.json({ error: "Invalid category." }, { status: 400 });
    update.category = normalizedCategory;
  }
  if ("priority" in update && (typeof update.priority !== "string" || !["Urgent", "High", "Medium", "Low"].includes(update.priority))) {
    return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
  }
  for (const field of ["cost", "hours"] as const) {
    if (!(field in update)) continue;
    const value = update[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return NextResponse.json({ error: `${field} must be a finite, nonnegative number.` }, { status: 400 });
    }
  }
  if ("asset_id" in update && update.asset_id !== null && (typeof update.asset_id !== "string" || !update.asset_id.trim() || update.asset_id.length > 100)) {
    return NextResponse.json({ error: "Invalid equipment identifier." }, { status: 400 });
  }
  if ("due_by" in update && !validateDueDate(update.due_by)) {
    return NextResponse.json({ error: "Supply a valid due date or clear it." }, { status: 400 });
  }

  if ("asset_name" in update && !("asset_id" in update)) {
    return NextResponse.json({ error: "Select equipment when changing its name on a ticket." }, { status: 400 });
  }
  if ("asset_id" in update) {
    if (update.asset_id === null) {
      update.asset_name = "";
    } else if (update.asset_id === existing.asset_id) {
      update.asset_name = existing.asset_name || "";
    } else {
      const { data: asset, error: assetError } = await db.from("assets")
        .select("id, location_id, name, active")
        .eq("hotel_id", HOTEL_ID)
        .eq("id", update.asset_id)
        .maybeSingle();
      if (assetError) return NextResponse.json({ error: "Unable to verify the selected equipment." }, { status: 503 });
      if (!asset || !existing.location_id || asset.location_id !== existing.location_id || asset.active === false) {
        return NextResponse.json({ error: "Select active equipment assigned to this ticket's location." }, { status: 400 });
      }
      update.asset_name = asset.name;
    }
  }

  const resultingStatus = String(update.status ?? existing.status ?? "Open");
  if (
    existing.status === "Closed" &&
    resultingStatus === "In Progress" &&
    !("technician_name" in update) &&
    !String(existing.technician_name || "").trim() &&
    String(existing.last_assigned_technician_name || "").trim()
  ) {
    update.technician_name = String(existing.last_assigned_technician_name).trim();
  }
  const resultingTechnician = String(update.technician_name ?? existing.technician_name ?? "").trim();
  if (resultingStatus === "In Progress" && !resultingTechnician) {
    return NextResponse.json({ error: "A technician must be assigned while a work order is In Progress." }, { status: 400 });
  }

  const mutation = db.from("work_orders")
    .update(update)
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .eq("revision", body.expected_revision);
  const { data, error } = await mutation.select("*").single();
  if (error) {
    if ((error as { code?: string }).code === "PGRST116") {
      return NextResponse.json({ error: "This ticket changed while you were saving. Your edits were not saved. Reload before combining the changes." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) return NextResponse.json({ error: "This ticket changed while you were saving. Your edits were not saved. Reload before combining the changes." }, { status: 409 });
  await processRoomRankerSyncForWorkOrder(auth.admin, id).catch(() => undefined);
  return NextResponse.json({ workOrder: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Work-order deletion requires sign-in." }, { status: 401 });
  const canDelete = allows(auth.principal, "edit_tickets") || allows(auth.principal, "close_tickets") || allows(auth.principal, "manage_users");
  if (!canDelete) return NextResponse.json({ error: "Engineering access is required to delete work orders." }, { status: 403 });

  const { id } = await params;
  const db = callerDatabase(request);
  if (!db) return NextResponse.json({ error: "CMPRI database configuration is unavailable." }, { status: 503 });

  const { data: existing, error: lookupError } = await db.from("work_orders")
    .select("id, room, display_id, status")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Work order not found." }, { status: 404 });

  if (existing.status === "Closed" && !allows(auth.principal, "close_tickets")) {
    return NextResponse.json({ error: "Closing permission is required to delete closed work orders." }, { status: 403 });
  }

  const { error: deleteError } = await db.from("work_orders")
    .delete()
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id);

  if (deleteError) return NextResponse.json({ error: "Work order could not be deleted." }, { status: 500 });

  return NextResponse.json({ deleted: id, display_id: existing.display_id || null, room: existing.room || null, ok: true });
}
