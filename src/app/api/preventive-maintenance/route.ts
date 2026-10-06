import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { findPmTemplate, PM_ROOM_NUMBERS, pmWeekDates, validPmPeriod } from "@/lib/pm/catalog";
import { profileHasRole } from "@/lib/server/roles";

const PM_MONTH_SHEETS = ["JAN", "FEB", "MAR", "APRIL", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"];
type PmProposedCell = {
  sheet: string;
  row: number;
  column: number;
  label: string;
  kind: "checkbox" | "completion-date";
  expectedValue: string;
  proposedValue: string;
};

function emptyPmWorkbook(week: string) {
  const weekDates = pmWeekDates(week);
  const monthSheets = [...new Set(weekDates.map((date) => PM_MONTH_SHEETS[Number(date.slice(5, 7)) - 1]))];
  return {
    week,
    year: Number(week.slice(0, 4)),
    weekDates,
    monthSheets,
    daily: Object.fromEntries(weekDates.map((date) => [date, []])),
    weekly: Object.fromEntries(monthSheets.map((month) => [month, []])),
    monthly: Object.fromEntries(monthSheets.map((month) => [month, []])),
    rooms: PM_ROOM_NUMBERS.map((room) => ({ room, quarters: { Q1: null, Q2: null, Q3: null, Q4: null } })),
    fetchedAt: new Date().toISOString(),
  };
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validWeek(value: string) {
  return validDate(value) && new Date(`${value}T12:00:00Z`).getUTCDay() === 1;
}

function recordObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(value).length > 250_000) throw new Error(`${label} is too large.`);
  return value as Record<string, unknown>;
}

function safeText(value: unknown, label: string, maxLength: number, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function safeScopeKey(templateId: string, scope: unknown, formData: Record<string, unknown>) {
  const template = findPmTemplate(templateId);
  if (!template) throw new Error("The PM form is not supported.");
  const value = safeText(scope, "Inspection location", 120, "property");
  if (template.scope === "room") {
    const room = value.match(/^room:(\d{2,4})$/)?.[1];
    if (!room || !PM_ROOM_NUMBERS.includes(room)) throw new Error("Select a valid room for this quarterly PM.");
    return `room:${room}`;
  }
  if (template.scope === "equipment") {
    const identifier = safeText(
      formData.unitIdentifier ?? formData.location,
      "Equipment identifier",
      80,
      "",
    );
    if (!identifier) throw new Error("Enter an equipment or location identifier.");
    return `equipment:${identifier.toLowerCase()}`;
  }
  return value || "property";
}

async function responseError(error: { message?: string; code?: string } | null, fallback: string) {
  return NextResponse.json(
    { error: error?.message || fallback },
    { status: error?.code === "23505" ? 409 : 503 },
  );
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "view_pm")) {
    return NextResponse.json({ error: "Preventive Maintenance access is required." }, { status: 403 });
  }
  const week = request.nextUrl.searchParams.get("week") || "";
  if (!validWeek(week)) return NextResponse.json({ error: "Select a week beginning on Monday." }, { status: 400 });

  const from = new Date(`${week}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 100);
  const proposals = await auth.admin.from("cmpri_pm_proposals")
    .select("id, template_id, period_start, scope_key, payload, proposed_cells, status, submitted_by, submitted_by_name, reviewed_by, reviewed_at, review_note, revision, updated_at")
    .eq("hotel_id", HOTEL_ID)
    .gte("period_start", from.toISOString().slice(0, 10))
    .lte("period_start", pmWeekDates(week)[6])
    .order("period_start", { ascending: true })
    .limit(5000);
  if (proposals.error) return responseError(proposals.error, "PM review records could not be loaded.");
  const latestByKey = new Map<string, Record<string, unknown>>();
  const proposalPriorityByKey = new Map<string, number>();
  for (const proposal of proposals.data || []) {
    if (proposal.status === "rejected") continue;
    const key = `${proposal.template_id}|${proposal.period_start}|${proposal.scope_key}`;
    const payload = proposal.payload && typeof proposal.payload === "object" ? proposal.payload as Record<string, unknown> : {};
    const pending = proposal.status === "pending" || proposal.status === "processing";
    const ownedPending = proposal.status === "pending" && proposal.submitted_by === auth.principal.identity.id;
    const priority = ownedPending ? 3 : pending ? 2 : 1;
    const current = latestByKey.get(key);
    const currentPriority = proposalPriorityByKey.get(key) || 0;
    if (!current || priority > currentPriority
      || (priority === currentPriority && String(proposal.updated_at || "") >= String(current.updated_at || ""))) {
      proposalPriorityByKey.set(key, priority);
      latestByKey.set(key, {
        ...payload,
        id: proposal.id,
        template_id: proposal.template_id,
        period_start: proposal.period_start,
        scope_key: proposal.scope_key,
        status: proposal.status,
        submitted_by_name: proposal.submitted_by_name,
        reviewed_by: proposal.reviewed_by,
        reviewed_at: proposal.reviewed_at,
        review_note: proposal.review_note,
        revision: proposal.status === "pending" ? proposal.revision : 0,
        can_edit_entry: ownedPending,
        updated_at: proposal.updated_at,
      });
    }
  }
  const isSystemAdmin = profileHasRole(auth.principal.profile, "system_admin");
  const isEngineer = profileHasRole(auth.principal.profile, "engineer");
  const canReview = isSystemAdmin || isEngineer;
  const reviewQueue = canReview
    ? await auth.admin.from("cmpri_pm_proposals")
      .select("id, template_id, period_start, scope_key, payload, proposed_cells, status, submitted_by_name, revision, created_at")
      .eq("hotel_id", HOTEL_ID)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: true })
      .limit(1000)
    : null;
  if (reviewQueue?.error) return responseError(reviewQueue.error, "Pending PM reviews could not be loaded.");
  const locations = await auth.admin.from("locations")
    .select("id, name, room_number, area, location_type")
    .eq("hotel_id", HOTEL_ID)
    .eq("active", true)
    .order("area", { ascending: true })
    .order("room_number", { ascending: true })
    .limit(2000);
  if (locations.error) return responseError(locations.error, "PM work-order locations could not be loaded.");
  return NextResponse.json({
    week,
    workbook: emptyPmWorkbook(week),
    entries: [...latestByKey.values()],
    review_queue: reviewQueue?.data || [],
    locations: locations.data || [],
    can_edit: isSystemAdmin || allows(auth.principal, "edit_tickets"),
    can_review: canReview,
    access_roles: [auth.principal.profile.role, ...(auth.principal.profile.secondary_roles || [])],
    spreadsheet_sync_enabled: false,
    can_write_live_pm: false,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!profileHasRole(auth.principal.profile, "system_admin") && !allows(auth.principal, "edit_tickets")) {
    return NextResponse.json({ error: "PM completion requires engineering or technician editing permission." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    body = recordObject(value, "PM entry");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "A valid PM entry is required." }, { status: 400 });
  }

  let templateId: string;
  try {
    templateId = safeText(body.templateId, "PM form", 160);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The PM form is invalid." }, { status: 400 });
  }
  const template = findPmTemplate(templateId);
  if (!template) return NextResponse.json({ error: "The PM form is not supported." }, { status: 400 });
  const periodStart = body.periodStart;
  if (!validDate(periodStart) || !validPmPeriod(template, periodStart)) {
    return NextResponse.json({ error: `The selected period is not valid for ${template.title}.` }, { status: 400 });
  }
  let responses: Record<string, unknown>;
  let formData: Record<string, unknown>;
  let scopeKey: string;
  try {
    responses = recordObject(body.responses, "Checklist responses");
    formData = recordObject(body.formData, "Form fields");
    scopeKey = safeScopeKey(templateId, body.scopeKey, formData);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PM form data is invalid." }, { status: 400 });
  }
  if (Object.keys(responses).length > 1200 || Object.keys(formData).length > 100) {
    return NextResponse.json({ error: "PM form data contains too many fields." }, { status: 400 });
  }
  if (template.kind === "routine" && Object.keys(responses).length !== 1) {
    return NextResponse.json({ error: "Save exactly one routine checklist item per action." }, { status: 400 });
  }
  const checklistIds = new Set(template.checklist.map((item) => item.id));
  const validResponse = (value: unknown) => template.kind === "routine"
    ? typeof value === "boolean"
    : value === "complete" || value === "follow-up" || value === "na";
  if (Object.entries(responses).some(([id, value]) => !checklistIds.has(id) || !validResponse(value))) {
    return NextResponse.json({ error: "Checklist responses do not match this PM form." }, { status: 400 });
  }
  const completedOn = body.completedOn === null || body.completedOn === "" ? null : body.completedOn;
  if (completedOn !== null && !validDate(completedOn)) {
    return NextResponse.json({ error: "Completion date must use YYYY-MM-DD." }, { status: 400 });
  }
  if (typeof body.isComplete !== "boolean") {
    return NextResponse.json({ error: "Choose whether this PM form is a draft or complete." }, { status: 400 });
  }
  const workOrderId = body.workOrderId === null || body.workOrderId === "" ? null : body.workOrderId;
  if (workOrderId !== null && (typeof workOrderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workOrderId))) {
    return NextResponse.json({ error: "The linked work order is invalid." }, { status: 400 });
  }
  if (typeof workOrderId === "string") {
    const workOrder = await auth.admin.from("work_orders")
      .select("id")
      .eq("hotel_id", HOTEL_ID)
      .eq("id", workOrderId)
      .maybeSingle();
    if (workOrder.error) return responseError(workOrder.error, "The linked work order could not be verified.");
    if (!workOrder.data) return NextResponse.json({ error: "The linked work order is not available for this property." }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    return NextResponse.json({ error: "Refresh this PM form before saving changes." }, { status: 400 });
  }
  let notes: string;
  let deficiencyNotes: string;
  try {
    notes = safeText(body.notes, "Inspection notes", 10_000);
    deficiencyNotes = safeText(body.deficiencyNotes, "Deficiency notes", 10_000);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PM notes are invalid." }, { status: 400 });
  }
  const key = { hotel_id: HOTEL_ID, template_id: template.id, period_start: periodStart, scope_key: scopeKey };
  const actor = auth.principal.identity.id;
  const existing = await auth.admin.from("cmpri_pm_proposals")
    .select("id, revision, payload")
    .match(key)
    .eq("status", "pending")
    .eq("submitted_by", actor)
    .maybeSingle();
  if (existing.error) return responseError(existing.error, "The pending PM proposal could not be checked.");
  const expectedRevision = Number(body.expectedRevision);
  if ((!existing.data && expectedRevision !== 0)
    || (existing.data && Number(existing.data.revision) !== expectedRevision)) {
    return NextResponse.json({ error: "This PM proposal changed in another session. Refresh it before saving again.", conflict: true }, { status: 409 });
  }
  const priorPayload = existing.data?.payload;
  const priorResponses = priorPayload && typeof priorPayload === "object" && !Array.isArray(priorPayload)
    ? (priorPayload as Record<string, unknown>).responses
    : null;
  const savedRoutineResponses = priorResponses && typeof priorResponses === "object" && !Array.isArray(priorResponses)
    ? priorResponses as Record<string, unknown>
    : {};
  const persistedResponses = template.kind === "routine"
    ? { ...savedRoutineResponses, ...responses }
    : responses;
  if (body.isComplete) {
    if (template.checklist.some((item) => !validResponse(persistedResponses[item.id]))) {
      return NextResponse.json({ error: "Review every checklist item before completing this PM form." }, { status: 400 });
    }
    if (template.kind === "routine" && template.checklist.some((item) => persistedResponses[item.id] !== true)) {
      return NextResponse.json({ error: "All routine checklist items must be checked before completing this PM period." }, { status: 400 });
    }
    const missingField = template.fields.find((field) => field.required && !String(formData[field.id] || "").trim());
    if (missingField) return NextResponse.json({ error: `${missingField.label} is required.` }, { status: 400 });
    if (template.kind === "room" && !completedOn) {
      return NextResponse.json({ error: "Enter the quarterly room PM completion date." }, { status: 400 });
    }
    if (Object.values(persistedResponses).includes("follow-up") && !deficiencyNotes.trim()) {
      return NextResponse.json({ error: "Describe the deficiencies and follow-up plan before completing this PM form." }, { status: 400 });
    }
    if (template.repeatableFields?.length) {
      const logEntries = formData.logEntries;
      if (!Array.isArray(logEntries) || !logEntries.length || logEntries.some((row) =>
        !row || typeof row !== "object" || Array.isArray(row)
        || template.repeatableFields!.some((field) => field.required && !String((row as Record<string, unknown>)[field.id] || "").trim()),
      )) {
        return NextResponse.json({ error: `Add complete ${template.repeatableLabel?.toLowerCase() || "inspection"} records before finishing.` }, { status: 400 });
      }
    }
  }
  const proposedCells: PmProposedCell[] = [];
  const payload = {
    responses: persistedResponses,
    form_data: formData,
    notes,
    deficiency_notes: deficiencyNotes,
    completed_on: completedOn,
    is_complete: body.isComplete,
    completed_by_name: body.isComplete
      ? auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI User"
      : null,
    work_order_id: workOrderId,
  };
  const submittedByName = auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI User";

  if (!existing.data) {
    const inserted = await auth.admin.from("cmpri_pm_proposals")
      .insert({
        ...key,
        payload,
        proposed_cells: proposedCells,
        status: "pending",
        submitted_by: actor,
        submitted_by_name: submittedByName,
      })
      .select("id, template_id, period_start, scope_key, payload, proposed_cells, status, submitted_by_name, revision, updated_at")
      .single();
    if (inserted.error) return responseError(inserted.error, "The PM proposal could not be saved.");
    return NextResponse.json({
      entry: { ...inserted.data.payload, id: inserted.data.id, template_id: inserted.data.template_id,
        period_start: inserted.data.period_start, scope_key: inserted.data.scope_key, status: inserted.data.status,
        can_edit_entry: true,
        submitted_by_name: inserted.data.submitted_by_name, proposed_cells: inserted.data.proposed_cells,
        revision: inserted.data.revision, updated_at: inserted.data.updated_at },
    }, { status: 201 });
  }

  const updated = await auth.admin.from("cmpri_pm_proposals")
    .update({ payload, proposed_cells: proposedCells, submitted_by_name: submittedByName })
    .eq("hotel_id", HOTEL_ID)
    .eq("id", existing.data.id)
    .eq("revision", expectedRevision)
    .eq("status", "pending")
    .eq("submitted_by", actor)
    .select("id, template_id, period_start, scope_key, payload, proposed_cells, status, submitted_by_name, revision, updated_at")
    .maybeSingle();
  if (updated.error) return responseError(updated.error, "The PM proposal could not be updated.");
  if (!updated.data) {
    return NextResponse.json({ error: "This PM proposal changed in another session. Refresh it before saving again.", conflict: true }, { status: 409 });
  }
  return NextResponse.json({
    entry: { ...updated.data.payload, id: updated.data.id, template_id: updated.data.template_id,
      period_start: updated.data.period_start, scope_key: updated.data.scope_key, status: updated.data.status,
      can_edit_entry: true,
      submitted_by_name: updated.data.submitted_by_name, proposed_cells: updated.data.proposed_cells,
      revision: updated.data.revision, updated_at: updated.data.updated_at },
  });
}
