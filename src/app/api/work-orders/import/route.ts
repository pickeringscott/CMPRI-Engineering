import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { normalizeWorkOrderCategory } from "@/lib/work-order-categories";
import { likelyDuplicate } from "@/lib/work-order-duplicates";
import { inferWorkOrder } from "@/lib/work-order-suggestions";

const IMPORT_LIMIT = 200;
const EXISTING_LIMIT = 5000;
const SOURCE_NAMES = new Set(["SafetyCulture", "Spreadsheet"]);
const STATUSES = new Map([
  ["open", "Open"],
  ["in progress", "In Progress"],
  ["in-progress", "In Progress"],
  ["completed", "Completed"],
  ["complete", "Completed"],
  ["closed", "Closed"],
  ["will not do", "Will Not Do"],
  ["wont do", "Will Not Do"],
  ["won't do", "Will Not Do"],
]);
const PRIORITIES = new Map([["urgent", "Urgent"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]);

type ImportRow = Record<string, unknown>;

function clean(value: unknown, max: number, label: string, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label} is required.`);
  if (result.length > max) throw new Error(`${label} is too long.`);
  return result;
}

function normalizedLocation(value: string) {
  return value.toLowerCase().replace(/^room\s*#?\s*/i, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function reportedAt(value: unknown) {
  const raw = clean(value, 100, "Reported date/time");
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`Reported date/time '${raw}' is invalid.`);
  return date.toISOString();
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "edit_tickets");
  if (!auth) return NextResponse.json({ error: "Engineering ticket-edit permission is required for imports." }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "A valid import request is required." }, { status: 400 });
  }

  const source = clean(body.source, 50, "Import source", true);
  if (!SOURCE_NAMES.has(source)) return NextResponse.json({ error: "Import source must be SafetyCulture or Spreadsheet." }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > IMPORT_LIMIT) {
    return NextResponse.json({ error: `Import between 1 and ${IMPORT_LIMIT} rows at a time.` }, { status: 400 });
  }
  if (body.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    return NextResponse.json({ error: "Every import row must be a structured record." }, { status: 400 });
  }

  const { admin } = auth;
  const [locationsResult, assetsResult, existingResult] = await Promise.all([
    admin.from("locations").select("id, name, room_number, active").eq("hotel_id", HOTEL_ID).eq("active", true).limit(2000),
    admin.from("assets").select("id, location_id, name, asset_type, manufacturer, model_number, generation, asset_tag, documentation_key, active").eq("hotel_id", HOTEL_ID).eq("active", true).limit(5000),
    admin.from("work_orders").select("id, display_id, location_id, asset_id, issue, status, import_source, import_external_id").eq("hotel_id", HOTEL_ID).order("created_at", { ascending: false }).limit(EXISTING_LIMIT),
  ]);
  if (locationsResult.error || assetsResult.error || existingResult.error) {
    return NextResponse.json({ error: "CMPRI locations, equipment, or existing work orders could not be verified. Nothing was imported." }, { status: 503 });
  }
  if ((locationsResult.data || []).length >= 2000 || (assetsResult.data || []).length >= 5000 || (existingResult.data || []).length >= EXISTING_LIMIT) {
    return NextResponse.json({ error: "Import safety limits were reached. Nothing was imported." }, { status: 503 });
  }

  const locations = locationsResult.data || [];
  const assets = assetsResult.data || [];
  const existing = existingResult.data || [];
  const actorName = auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI Engineering";
  const now = new Date().toISOString();
  const prepared: Record<string, unknown>[] = [];
  const skipped: { row: number; reason: string; existing_work_order_id?: string }[] = [];

  try {
    for (let index = 0; index < body.rows.length; index += 1) {
      const input = body.rows[index] as ImportRow;
      const externalId = clean(input.external_id ?? input.id, 300, "Source id");
      const issue = clean(input.issue, 4000, `Row ${index + 1} issue`, true);
      const notes = clean(input.notes, 20000, `Row ${index + 1} notes`);
      const locationInput = clean(input.location ?? input.room ?? input.location_name, 300, `Row ${index + 1} room/location`, true);
      const locationKey = normalizedLocation(locationInput);
      const location = locations.find((item) => {
        const room = normalizedLocation(String(item.room_number || ""));
        const name = normalizedLocation(String(item.name || ""));
        return locationKey === room || locationKey === name || (room && locationKey === `room ${room}`);
      });
      if (!location) throw new Error(`Row ${index + 1}: CMPRI room/location '${locationInput}' was not found.`);

      if (externalId) {
        const imported = existing.find((item) => item.import_source === source && item.import_external_id === externalId);
        if (imported) {
          skipped.push({ row: index + 1, reason: `Already imported from ${source}.`, existing_work_order_id: imported.id });
          continue;
        }
      }

      const candidates = assets.filter((asset) => asset.location_id === location.id && asset.active !== false);
      const guess = inferWorkOrder(`${issue} ${notes}`.trim(), candidates);
      const requestedCategory = clean(input.category, 200, `Row ${index + 1} category`);
      const category = requestedCategory ? normalizeWorkOrderCategory(requestedCategory) : guess.category || "General";
      if (!category) throw new Error(`Row ${index + 1}: '${requestedCategory}' is not a supported work-order category.`);
      const requestedPriority = clean(input.priority, 40, `Row ${index + 1} priority`).toLowerCase();
      const priority = requestedPriority ? PRIORITIES.get(requestedPriority) : guess.priority || "Medium";
      if (!priority) throw new Error(`Row ${index + 1}: priority is invalid.`);
      const requestedStatus = clean(input.status, 80, `Row ${index + 1} status`).toLowerCase();
      const status = requestedStatus ? STATUSES.get(requestedStatus) : "Open";
      if (!status) throw new Error(`Row ${index + 1}: status is invalid. Duplicate is not an importable status.`);
      const asset = guess.assetId ? candidates.find((item) => item.id === guess.assetId) : null;
      const row = {
        hotel_id: HOTEL_ID,
        location_id: location.id,
        room: location.name,
        asset_id: asset?.id || null,
        asset_name: asset?.name || "",
        category,
        issue,
        priority,
        notes,
        status,
        technician_name: "",
        action_root_cause: "",
        parts: "",
        cost: 0,
        hours: 0,
        created_by: auth.principal.identity.id,
        creator_account_user_id: auth.principal.identity.id,
        creator_name: actorName,
        creator_source: "signed_in_user",
        submitted_by_user_id: auth.principal.identity.id,
        submitted_by_name: null,
        import_source: source,
        import_external_id: externalId || null,
        import_reported_at: reportedAt(input.reported_at ?? input.created_at ?? input.date),
        imported_at: now,
        imported_by_user_id: auth.principal.identity.id,
      };

      const duplicate = [...existing, ...prepared].find((item) => likelyDuplicate(row, item));
      if (duplicate) {
        skipped.push({ row: index + 1, reason: "Likely duplicate of an existing CMPRI work order.", existing_work_order_id: typeof duplicate.id === "string" ? duplicate.id : undefined });
        continue;
      }
      prepared.push(row);
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import validation failed.", skipped, imported: 0 }, { status: 400 });
  }

  if (!prepared.length) return NextResponse.json({ ok: true, imported: 0, skipped });
  const { data: saved, error: saveError } = await admin.from("work_orders").insert(prepared).select("id, display_id, status, import_external_id");
  if (saveError) return NextResponse.json({ error: `Nothing was imported: ${saveError.message}`, imported: 0, skipped }, { status: 409 });
  return NextResponse.json({ ok: true, imported: saved?.length || prepared.length, skipped, work_orders: saved || [] });
}
