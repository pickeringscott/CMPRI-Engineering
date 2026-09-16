import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { canSuperviseDraftRole } from "@/lib/server/roles";

const MAX_DRAFTS = 100;
type Authorized = NonNullable<Awaited<ReturnType<typeof requireCapability>>>;

function text(value: unknown, maximum: number, required = false) {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || value.length > maximum) return null;
  return normalized;
}

async function readBody(request: NextRequest) {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function creatorProfiles(admin: SupabaseClient, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; role: string | null; full_name: string | null; active: boolean | null }>();
  const { data, error } = await admin
    .from("profiles")
    .select("id, role, full_name, active")
    .in("id", ids);
  if (error) throw new Error("Draft ownership could not be verified.");
  return new Map((data || []).map((profile) => [String(profile.id), profile]));
}

async function draftById(auth: Authorized, id: string) {
  const { data, error } = await auth.admin
    .from("cmpri_work_order_drafts")
    .select("*")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Draft could not be loaded.");
  return data;
}

async function canManageDraft(
  auth: Authorized,
  draft: { created_by: string },
) {
  if (draft.created_by === auth.principal.identity.id) return true;
  const profiles = await creatorProfiles(auth.admin, [draft.created_by]);
  const target = profiles.get(draft.created_by);
  return Boolean(target && canSuperviseDraftRole(auth.principal.profile.role, target.role));
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "submit");
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await auth.admin
    .from("cmpri_work_order_drafts")
    .select("*")
    .eq("hotel_id", HOTEL_ID)
    .order("updated_at", { ascending: false })
    .limit(MAX_DRAFTS);
  if (error) return NextResponse.json({ error: "Drafts could not be loaded." }, { status: 503 });

  const rows = data || [];
  const profiles = await creatorProfiles(auth.admin, Array.from(new Set(rows.map((row) => String(row.created_by || "")).filter(Boolean))));
  const visible = rows.filter((row) => {
    if (row.created_by === auth.principal.identity.id) return true;
    const target = profiles.get(String(row.created_by));
    return Boolean(target && canSuperviseDraftRole(auth.principal.profile.role, target.role));
  }).map((row) => ({
    ...row,
    creator_name: profiles.get(String(row.created_by))?.full_name || "Unknown User",
    creator_role: profiles.get(String(row.created_by))?.role || "",
    can_delete: row.created_by === auth.principal.identity.id || Boolean(
      profiles.get(String(row.created_by)) && canSuperviseDraftRole(auth.principal.profile.role, profiles.get(String(row.created_by))?.role),
    ),
  }));

  return NextResponse.json({ drafts: visible });
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "submit");
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid draft is required." }, { status: 400 });

  const locationId = text(body.location_id, 100, true);
  const issue = text(body.issue, 4000, true);
  const notes = text(body.notes, 20000) ?? "";
  if (!locationId || !issue || notes === null) {
    return NextResponse.json({ error: "A draft requires a valid room/location and issue." }, { status: 400 });
  }

  const { data: location, error: locationError } = await auth.admin
    .from("locations")
    .select("id, name, active")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", locationId)
    .maybeSingle();
  if (locationError) return NextResponse.json({ error: "Location could not be verified." }, { status: 503 });
  if (!location || location.active === false) return NextResponse.json({ error: "Select an active CMPRI location." }, { status: 400 });

  const row = {
    hotel_id: HOTEL_ID,
    created_by: auth.principal.identity.id,
    staff_first_name: text(body.staff_first_name, 80) || null,
    location_id: location.id,
    room: location.name,
    issue,
    notes,
    asset_id: text(body.asset_id, 100) || null,
    asset_name: text(body.asset_name, 500) || "",
    category: text(body.category, 500) || "General",
    priority: text(body.priority, 100) || "Medium",
  };

  const { data, error } = await auth.admin
    .from("cmpri_work_order_drafts")
    .insert(row)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: "Draft could not be saved." }, { status: 400 });
  return NextResponse.json({ draft: data });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireCapability(request, "submit");
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readBody(request);
  if (!body || typeof body.id !== "string" || !body.id.trim()) {
    return NextResponse.json({ error: "Draft id is required." }, { status: 400 });
  }
  const existing = await draftById(auth, body.id.trim());
  if (!existing) return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  if (existing.created_by !== auth.principal.identity.id) {
    return NextResponse.json({ error: "Only the draft creator can edit a draft." }, { status: 403 });
  }
  if (typeof body.expected_revision !== "number" || body.expected_revision !== existing.revision) {
    return NextResponse.json({ error: "This draft changed. Reload it before saving." }, { status: 409 });
  }

  const update: Record<string, unknown> = {};
  for (const [field, max] of [["staff_first_name", 80], ["issue", 4000], ["notes", 20000], ["asset_id", 100], ["asset_name", 500], ["category", 500], ["priority", 100]] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const parsed = text(body[field], max, field === "issue");
    if (parsed === null) return NextResponse.json({ error: `Invalid ${field}.` }, { status: 400 });
    update[field] = parsed || (field === "asset_id" || field === "staff_first_name" ? null : "");
  }
  if (Object.prototype.hasOwnProperty.call(body, "location_id")) {
    const locationId = text(body.location_id, 100, true);
    if (!locationId) return NextResponse.json({ error: "A valid location is required." }, { status: 400 });
    const { data: location, error } = await auth.admin.from("locations")
      .select("id, name, active").eq("hotel_id", HOTEL_ID).eq("id", locationId).maybeSingle();
    if (error) return NextResponse.json({ error: "Location could not be verified." }, { status: 503 });
    if (!location || location.active === false) return NextResponse.json({ error: "Select an active CMPRI location." }, { status: 400 });
    update.location_id = location.id;
    update.room = location.name;
  }
  if (!Object.keys(update).length) return NextResponse.json({ error: "No draft changes were supplied." }, { status: 400 });

  const { data, error } = await auth.admin.from("cmpri_work_order_drafts")
    .update({ ...update, updated_at: new Date().toISOString(), revision: existing.revision + 1 })
    .eq("hotel_id", HOTEL_ID)
    .eq("id", existing.id)
    .eq("revision", existing.revision)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Draft could not be saved." }, { status: 400 });
  if (!data) return NextResponse.json({ error: "This draft changed. Reload it before saving." }, { status: 409 });
  return NextResponse.json({ draft: data });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireCapability(request, "submit");
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id")?.trim() || "";
  if (!id) return NextResponse.json({ error: "Draft id is required." }, { status: 400 });
  const existing = await draftById(auth, id);
  if (!existing) return NextResponse.json({ ok: true });
  if (!(await canManageDraft(auth, existing))) {
    return NextResponse.json({ error: "You cannot delete this draft." }, { status: 403 });
  }
  const { error } = await auth.admin.from("cmpri_work_order_drafts")
    .delete().eq("hotel_id", HOTEL_ID).eq("id", id);
  if (error) return NextResponse.json({ error: "Draft could not be deleted." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
