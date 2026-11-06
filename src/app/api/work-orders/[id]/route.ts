import { persistMentionedWorkOrder } from "@/lib/server/work-order-mentions";
import { frontDeskCommonArea } from "@/lib/cmpri-location-groups";
import { canReadWorkOrder, canReadWorkOrderForMutation, workOrderReadFilter } from "@/lib/work-order-read-policy";
import { workOrderReader } from "@/lib/server/work-order-reader";
import { accountRoleDisplayName } from "@/lib/account-display";
import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { normalizeWorkOrderCategory } from "@/lib/work-order-categories";
import { profileIsChiefEngineer, profileIsEstablishedHoursChief, roleKey } from "@/lib/server/roles";
import { isEngineeringWorkOrderActor, recordEngineeringWorkOrderView } from "@/lib/server/work-order-notification-resolution";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";
import { currentRoomOperation, currentRoomStatus, loadCurrentRoomStatuses } from "@/lib/server/room-availability";
import { isUuid } from "@/lib/uuid";
import { canCorrectReport as reportCorrectionAllowed, REPORT_CORRECTION_FIELDS, TECHNICAL_WORK_ORDER_FIELDS, workOrderEditableFields } from "@/lib/work-order-edit-policy";

const ALL_STATUSES = ["Pending Verification", "Open", "In Progress", "Completed", "Will Not Do", "Closed"] as const;

function isMcpRequest(request: NextRequest) {
  return /^Bearer\s+cmpri_mcp_[^\s]+$/i.test(request.headers.get("authorization") || "");
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
  if (!auth || (!allows(auth.principal, "view_dashboard") && !allows(auth.principal, "view_work_orders") && !allows(auth.principal, "edit_tickets") && !allows(auth.principal, "add_work_order_notes"))) {
    return NextResponse.json({ error: "Work-order access is required." }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const includeMentions = request.nextUrl.searchParams.get("include") === "mentions";
  const { data: workOrder, error: workOrderError } = await auth.admin
    .from("work_orders")
    .select("*")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (workOrderError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!workOrder) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  if (!canReadWorkOrder(workOrderReader(auth.principal), workOrder)) {
    return NextResponse.json({ error: "This work order is not available to your account." }, { status: 403 });
  }
  const roomStatuses = await loadCurrentRoomStatuses(auth.admin);
  if (roomStatuses.error || !roomStatuses.statuses) return NextResponse.json({ error: "Current room availability could not be loaded." }, { status: 503 });

  if (isEngineeringWorkOrderActor(auth.principal.profile)) {
    try {
      await recordEngineeringWorkOrderView(auth.admin, workOrder, {
        id: auth.principal.identity.id,
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Engineering notification review could not be recorded." }, { status: 503 });
    }
  }

  const isTechnician = roleKey(auth.principal.profile.role) === "technician";
  if (isTechnician) {
    const { error: viewError } = await auth.admin
      .from("cmpri_work_order_technician_views")
      .upsert({
        hotel_id: HOTEL_ID,
        work_order_id: id,
        work_order_display_id: String(workOrder.display_id || ""),
        technician_user_id: auth.principal.identity.id,
        technician_name: auth.principal.profile.full_name?.trim() || "Technician",
        status_at_view: String(workOrder.status || "Open"),
      }, {
        onConflict: "hotel_id,work_order_id,technician_user_id",
        ignoreDuplicates: true,
      });
    if (viewError) return NextResponse.json({ error: "The technician view could not be recorded." }, { status: 503 });
  }

  const { data: technicianViewEntries, error: viewEntriesError } = await auth.admin
    .from("cmpri_work_order_technician_views")
    .select("id, technician_name, viewed_at, resolved_at")
    .eq("hotel_id", HOTEL_ID)
    .eq("work_order_id", id)
    .order("viewed_at", { ascending: true });
  if (viewEntriesError) return NextResponse.json({ error: "Technician view notes could not be loaded." }, { status: 503 });

  let creatorRole: string | null = null;
  let creatorDisplayRole: string | null = null;
  if (workOrder.created_by) {
    if (String(workOrder.created_by) === String(auth.principal.identity.id)) {
      creatorRole = auth.principal.profile.role || null;
      creatorDisplayRole = accountRoleDisplayName({ ...auth.principal.profile, email: auth.principal.identity.email || auth.principal.profile.email });
    } else {
      const { data: creator } = await auth.admin
        .from("profiles")
        .select("role, email, secondary_roles")
        .eq("id", workOrder.created_by)
        .maybeSingle();
      creatorRole = creator?.role || null;
      creatorDisplayRole = creator ? accountRoleDisplayName(creator) : null;
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
    const readFilter = workOrderReadFilter(workOrderReader(auth.principal));
    if (readFilter) mentionQuery = mentionQuery.or(readFilter);
    const { data: mentionRows, error: mentionError } = await mentionQuery;
    if (mentionError) return NextResponse.json({ error: "Could not read related work-order references." }, { status: 503 });
    mentionTickets = (mentionRows ?? []) as Array<Record<string, unknown>>;
  }

  return NextResponse.json({
    workOrder: {
      ...workOrder,
      can_correct_report: reportCorrectionAllowed(auth.principal.profile, workOrder.status, canReadWorkOrderForMutation(workOrderReader(auth.principal), workOrder)),
      room_status: currentRoomStatus(roomStatuses.statuses, workOrder.room),
      ...currentRoomOperation(roomStatuses.operations!, workOrder.room),
      creator_role: creatorRole,
      creator_display_role: creatorDisplayRole,
      technician_view_entries: technicianViewEntries || [],
    },
    mentionTickets,
    next_guest_transition_at: roomStatuses.nextTransitionAt,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Work-order editing or review permission is required." }, { status: 403 });
  const chief = profileIsChiefEngineer(auth.principal.profile) || profileIsEstablishedHoursChief(auth.principal.profile);
  const canEdit = allows(auth.principal, "edit_tickets");
  const canReview = allows(auth.principal, "review_tickets");
  const canAddNotes = allows(auth.principal, "add_work_order_notes");
  const canSubmit = allows(auth.principal, "submit");
  if (!canEdit && !canReview && !canAddNotes && !canSubmit) return NextResponse.json({ error: "Work-order editing, notes, or review permission is required." }, { status: 403 });

  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  if (!canEdit && !canReview && Object.prototype.hasOwnProperty.call(body, "notes")) {
    return NextResponse.json({ error: "Use the append-only notes action to add notes without replacing history." }, { status: 403 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const db = auth.admin;

  const { data: existing, error: lookupError } = await db.from("work_orders")
    .select("id, display_id, hotel_id, created_by, submitted_by_name, issue, room, status, location_id, asset_id, asset_name, technician_name, last_assigned_technician_name, notes, revision")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  const canCorrectReport = reportCorrectionAllowed(auth.principal.profile, existing.status, canReadWorkOrderForMutation(workOrderReader(auth.principal), existing));
  const correctionOnly = Object.keys(body).every(key => key === "expected_revision" || REPORT_CORRECTION_FIELDS.includes(key as typeof REPORT_CORRECTION_FIELDS[number]));
  if (canAddNotes && !canEdit && !canReview && !correctionOnly && !["Open", "In Progress"].includes(String(existing.status || ""))) {
    return NextResponse.json({ error: "Notes may only be added to open work orders." }, { status: 403 });
  }
  const technicianEdit = !chief && roleKey(auth.principal.profile.role) === "technician";
  const assignmentAccess = canAccessWorkOrderByAssignment(chief ? "Chief Engineer" : auth.principal.profile.role, auth.principal.profile.full_name, existing);
  if (!assignmentAccess && !(canCorrectReport && correctionOnly)) {
    return NextResponse.json({ error: "This work order is not assigned to you." }, { status: 403 });
  }
  const technicianProfileName = auth.principal.profile.full_name?.trim() || "";
  const unassignedWorkOrder = !String(existing.technician_name || "").trim();
  const canClaimUnassigned = technicianEdit &&
    unassignedWorkOrder &&
    !!technicianProfileName &&
    ["Open", "In Progress"].includes(String(existing.status));

  if (typeof body.expected_revision !== "number" || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1) {
    return NextResponse.json({ error: "Reload this ticket before saving so its current version can be checked." }, { status: 428 });
  }
  if (body.expected_revision !== existing.revision) {
    return NextResponse.json({ error: "Someone changed this ticket since you opened it. Your edits were not saved. Reload before combining the changes." }, { status: 409 });
  }

  const allowedFields = [...workOrderEditableFields({
    role: chief ? "Chief Engineer" : auth.principal.profile.role,
    canEdit: canEdit && assignmentAccess,
    canReview,
    canAddNotes,
    unassigned: unassignedWorkOrder,
    canClaimUnassigned,
  }), ...(canCorrectReport ? REPORT_CORRECTION_FIELDS : [])];
  const allowedFieldSet = new Set(allowedFields);
  const update: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
  }
  const attemptedProtected = [...TECHNICAL_WORK_ORDER_FIELDS, ...REPORT_CORRECTION_FIELDS, "room", "created_by", "submitted_by_name", "history_actor_user_id", "history_source"].some((field) => Object.prototype.hasOwnProperty.call(body, field) && !allowedFieldSet.has(field as typeof allowedFields[number]));
  if (attemptedProtected) return NextResponse.json({ error: "Your role cannot change technical work-order fields." }, { status: 403 });
  if (
    technicianEdit &&
    Object.prototype.hasOwnProperty.call(body, "technician_name") &&
    (!canClaimUnassigned || body.technician_name !== technicianProfileName)
  ) {
    return NextResponse.json({ error: "You can only assign an unassigned work order to yourself." }, { status: 403 });
  }
  if (!Object.keys(update).length) return NextResponse.json({ error: "No editable changes were supplied." }, { status: 400 });

  if (update.status !== undefined && (typeof update.status !== "string" || !ALL_STATUSES.includes(update.status as typeof ALL_STATUSES[number]))) {
    return NextResponse.json({ error: "Invalid work-order status." }, { status: 400 });
  }
  if (technicianEdit && update.status !== undefined && !["Open", "In Progress", "Completed"].includes(String(update.status))) {
    return NextResponse.json({ error: "Technicians may set work only to Open, In Progress, or Completed." }, { status: 403 });
  }

  if (!canEdit && canReview && !correctionOnly) {
    if (existing.status !== "Pending Verification") {
      return NextResponse.json({ error: "Management review is limited to pending requests." }, { status: 403 });
    }
    if (update.status !== undefined && !["Open", "Will Not Do"].includes(String(update.status))) {
      return NextResponse.json({ error: "Management can approve a pending request to Open or mark it Will Not Do." }, { status: 403 });
    }
  }

  if (!chief && existing.status === "Closed" && update.status !== undefined && update.status !== "Closed") {
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

  if ("location_id" in update) {
    if (typeof update.location_id !== "string" || !isUuid(update.location_id)) return NextResponse.json({ error: "Select a valid Room/Location." }, { status: 400 });
    const { data: location, error: locationError } = await db.from("locations")
      .select("id, name, active").eq("hotel_id", HOTEL_ID).eq("id", update.location_id).maybeSingle();
    if (locationError) return NextResponse.json({ error: "Room/Location could not be verified." }, { status: 503 });
    if (!location || location.active !== true) return NextResponse.json({ error: "Select an active Room/Location." }, { status: 400 });
    update.room = location.name;
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
      let allowedCommonArea = false;
      const ticketLocationId = update.location_id ?? existing.location_id;
      if (asset?.location_id && ticketLocationId && asset.location_id !== ticketLocationId) {
        const result = await db.from("locations").select("id,name,area,room_number,location_type,active")
          .eq("hotel_id", HOTEL_ID).in("id", [ticketLocationId, asset.location_id]);
        if (result.error) return NextResponse.json({ error: "Equipment locations could not be verified." }, { status: 503 });
        allowedCommonArea = frontDeskCommonArea(result.data?.find(location => location.id === ticketLocationId), result.data?.find(location => location.id === asset.location_id));
      }
      if (!asset || !(update.location_id ?? existing.location_id) || (asset.location_id !== null && asset.location_id !== (update.location_id ?? existing.location_id) && !allowedCommonArea) || asset.active === false) {
        return NextResponse.json({ error: "Select active equipment assigned to this ticket's location or an unassigned template." }, { status: 400 });
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
  if (!chief && !correctionOnly && resultingStatus === "In Progress" && !resultingTechnician) {
    return NextResponse.json({ error: "A technician must be assigned while a work order is In Progress." }, { status: 400 });
  }

  const roomStatuses = "location_id" in update ? await loadCurrentRoomStatuses(auth.admin) : null;
  if (roomStatuses && (roomStatuses.error || !roomStatuses.statuses)) return NextResponse.json({ error: "Current room availability could not be loaded. No correction was saved." }, { status: 503 });
  const validatedUpdate = { ...update, history_actor_user_id: auth.principal.identity.id, history_source: isMcpRequest(request) ? "ChatGPT" : "CMPRI app" };
  let mentionSave;
  try {
    mentionSave = await persistMentionedWorkOrder(db, {
      hotelId: HOTEL_ID, id, actorId: auth.principal.identity.id, revision: body.expected_revision,
      beforeNotes: String(existing.notes || ""), update: validatedUpdate,
    });
  } catch {
    return NextResponse.json({ error: "Mention recipients could not be verified. Your changes were not saved." }, { status: 503 });
  }
  const { data, error } = mentionSave || await db.from("work_orders")
    .update(validatedUpdate).eq("hotel_id", HOTEL_ID).eq("id", id).eq("revision", body.expected_revision).select("*").single();
  if (error) {
    if ((error as { code?: string }).code === "PGRST116") {
      return NextResponse.json({ error: "This ticket changed while you were saving. Your edits were not saved. Reload before combining the changes." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) return NextResponse.json({ error: "This ticket changed while you were saving. Your edits were not saved. Reload before combining the changes." }, { status: 409 });
  if (isEngineeringWorkOrderActor(auth.principal.profile)) {
    try {
      await recordEngineeringWorkOrderView(auth.admin, { id, display_id: existing.display_id }, {
        id: auth.principal.identity.id,
      });
    } catch (resolutionError) {
      return NextResponse.json({ error: resolutionError instanceof Error ? resolutionError.message : "Technician notifications could not be resolved." }, { status: 503 });
    }
  }
  return NextResponse.json({ workOrder: { ...data, can_correct_report: reportCorrectionAllowed(auth.principal.profile, data.status, canReadWorkOrder(workOrderReader(auth.principal), data)), ...(roomStatuses?.statuses ? { room_status: currentRoomStatus(roomStatuses.statuses, data.room) } : {}) } });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Work-order deletion requires sign-in." }, { status: 401 });
  if (!allows(auth.principal, "review_tickets")) {
    return NextResponse.json({ error: "Work-order review permission is required to delete work orders." }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const db = auth.admin;

  const { data: existing, error: lookupError } = await db.from("work_orders")
    .select("id, room, display_id, status")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Work order not found." }, { status: 404 });

  if (existing.status === "Closed" && !allows(auth.principal, "close_tickets")) {
    return NextResponse.json({ error: "Closing permission is required to cancel closed work orders." }, { status: 403 });
  }

  const { data: cancelled, error: deleteError } = await db.from("work_orders")
    .update({ status: "Will Not Do", action_updated_at: new Date().toISOString() })
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .eq("status", existing.status)
    .select("id, status")
    .maybeSingle();

  if (deleteError) return NextResponse.json({ error: "Work order could not be safely cancelled." }, { status: 500 });
  if (!cancelled) return NextResponse.json({ error: "Work order changed while cancelling. Reload and try again." }, { status: 409 });

  return NextResponse.json({
    cancelled: id,
    display_id: existing.display_id || null,
    room: existing.room || null,
    status: "Will Not Do",
    history_retained: true,
    ok: true,
  });
}
