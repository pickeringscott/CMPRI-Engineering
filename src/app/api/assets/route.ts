import * as baseline from "@/lib/server/pre-consolidation/assets-route";
import { dispatchConsolidation } from "@/lib/server/consolidation-stage";
import { listRegisteredAssetFiles } from "@/lib/server/asset-file-register";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { parseAssetInstallYear } from "@/lib/asset-install-year";
import { allows } from "@/lib/server/access";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { canEditEquipment, canReadEquipment } from "@/lib/server/roles";
import { extractManualPdfText, hasScannedManualContent, manualPdfSha256 } from "@/lib/manual-pdf-knowledge";
import { eligibleManualLinks } from "@/lib/manual-applicability";
import { EQUIPMENT_SELECTION_COLUMNS } from "@/lib/equipment-selection";

const BUCKET = "asset-documentation";
const VERIFY_MARKER = "_cmpri-verification.json";
const EN_DASH = " – ";
const ASSET_PAGE_SIZE = 1000;

async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function documentationState(data: SupabaseClient, assetId: string) {
  const { data: files, error } = await listRegisteredAssetFiles(data, assetId);
  if (error) return { verified: false, documentCount: 0, error: "Equipment documentation verification is unavailable." };
  const names = files.map(file => file.name);
  return {
    verified: names.includes(VERIFY_MARKER),
    documentCount: names.filter((name) => name && name !== VERIFY_MARKER).length,
    names,
    files,
    error: null,
  };
}

async function locationName(data: SupabaseClient, locationId: unknown) {
  if (typeof locationId !== "string" || !locationId.trim()) return { id: null, name: "Unassigned" };
  const { data: location, error } = await data.from("locations")
    .select("id, name, active")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", locationId.trim())
    .maybeSingle();
  if (error) throw new Error("Unable to verify the selected location.");
  if (!location || location.active === false) throw new Error("Select an active CMPRI location.");
  return { id: location.id as string, name: String(location.name || "Location").trim() || "Location" };
}

function optionalText(value: unknown, label: string, maximum = 500) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

export async function GET(request: NextRequest) {
  const staged = await dispatchConsolidation(request, baseline.GET);
  if (staged) return staged;
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const mode = request.nextUrl.searchParams.get("mode") || "management";

  if (mode === "create") {
    if (!allows(auth.principal, "submit")) {
      return NextResponse.json({ error: "Work-order submission permission is required." }, { status: 403 });
    }
    const assets: Array<Record<string, unknown>> = [];
    for (let offset = 0; ; offset += ASSET_PAGE_SIZE) {
      const { data, error } = await auth.admin.from("assets")
        .select(EQUIPMENT_SELECTION_COLUMNS)
        .eq("hotel_id", HOTEL_ID)
        .eq("active", true)
        .order("name", { ascending: true })
        .range(offset, offset + ASSET_PAGE_SIZE - 1);
      if (error) return NextResponse.json({ error: "Equipment could not be loaded." }, { status: 503 });
      assets.push(...((data || []) as Array<Record<string, unknown>>));
      if ((data || []).length < ASSET_PAGE_SIZE) break;
    }
    return NextResponse.json({ assets }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!canReadEquipment(auth.principal.profile.role)) {
    return NextResponse.json({ error: "Equipment management permission is required." }, { status: 403 });
  }
  const includeDocumentation = request.nextUrl.searchParams.get("include_documentation") !== "false";
  const assets: Array<Record<string, unknown> & { id: string }> = [];
  for (let offset = 0; ; offset += ASSET_PAGE_SIZE) {
    const { data, error } = await auth.admin.from("assets")
      .select("id, location_id, asset_type, name, asset_tag, binder_tag, quantity, active, status, manufacturer, model_family, model_number, serial_number, generation, install_year, documentation_key, documentation_verified_at, documentation_verified_by, documentation_revision_id, updated_at")
      .range(offset, offset + ASSET_PAGE_SIZE - 1)
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: "Equipment could not be loaded." }, { status: 503 });
    assets.push(...((data || []) as Array<Record<string, unknown> & { id: string }>));
    if ((data || []).length < ASSET_PAGE_SIZE) break;
  }
  const results = includeDocumentation
    ? await Promise.all(assets.map(async (asset) => {
        const state = await documentationState(auth.admin, asset.id);
        return {
          state,
          asset: {
            ...asset,
            documentation_verified: !asset.documentation_revision_id && (Boolean(asset.documentation_verified_at) || state.verified),
            documentation_count: state.documentCount,
          },
        };
      }))
    : assets.map((asset) => ({
      state: { verified: false, documentCount: 0, error: null },
      asset: {
        ...asset,
        documentation_verified: !asset.documentation_revision_id && Boolean(asset.documentation_verified_at),
        documentation_count: 0,
      },
    }));
  return NextResponse.json({
    assets: results.map((result) => result.asset),
    can_manage: canEditEquipment(auth.principal.profile.role) && allows(auth.principal, "manage_assets"),
    documentation_state_available: !results.some((result) => result.state.error),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const staged = await dispatchConsolidation(request, baseline.POST);
  if (staged) return staged;
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
  if (!canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Only engineers can edit equipment." }, { status: 403 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  try {
    const assetType = optionalText(body.asset_type, "equipment type", 200);
    if (!assetType) return NextResponse.json({ error: "Equipment type is required." }, { status: 400 });
    if (typeof body.location_id !== "string" || !body.location_id.trim()) {
      return NextResponse.json({ error: "A location is required for every new CMPRI asset." }, { status: 400 });
    }
    const location = await locationName(auth.admin, body.location_id);
    const installYear = parseAssetInstallYear(body.install_year);
    const row = {
      hotel_id: HOTEL_ID,
      location_id: location.id,
      asset_type: assetType,
      // Naming is enforced for NEW assets only. Existing legacy names are not retro-converted.
      name: `${assetType}${EN_DASH}${location.name}`,
      asset_tag: optionalText(body.asset_tag, "asset tag", 200),
      manufacturer: optionalText(body.manufacturer, "manufacturer", 200) ?? "",
      model_family: optionalText(body.model_family, "model family", 200),
      model_number: optionalText(body.model_number, "model number", 200),
      serial_number: optionalText(body.serial_number, "serial number", 300) ?? "",
      generation: optionalText(body.generation, "generation", 200),
      install_year: installYear,
      documentation_key: optionalText(body.documentation_key, "documentation key", 300),
      active: true,
      status: "Active",
    };
    const { data, error } = await auth.admin.from("assets").insert(row).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ asset: { ...data, documentation_verified: false, documentation_count: 0 } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Equipment could not be created." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const staged = await dispatchConsolidation(request, baseline.PATCH);
  if (staged) return staged;
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
  if (!canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Only engineers can edit equipment." }, { status: 403 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Asset id is required." }, { status: 400 });

  const { data: existing, error: existingError } = await auth.admin.from("assets")
    .select("*").eq("hotel_id", HOTEL_ID).eq("id", id).maybeSingle();
  if (existingError) return NextResponse.json({ error: "Equipment could not be verified." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  if (body.begin_documentation_revision === true) {
    if (typeof body.revision_reason !== "string" || body.revision_reason.trim().length < 5 || body.revision_reason.length > 2000
      || typeof body.expected_updated_at !== "string" || !Number.isFinite(Date.parse(body.expected_updated_at))) {
      return NextResponse.json({ error: "Supply the current record timestamp and a revision reason (5–2000 characters)." }, { status: 400 });
    }
    const { data: revisionId, error } = await auth.admin.rpc("cmpri_begin_equipment_revision", {
      p_asset_id: id, p_hotel_id: HOTEL_ID, p_expected_updated_at: body.expected_updated_at,
      p_actor_id: auth.principal.identity.id, p_reason: body.revision_reason.trim(),
    });
    if (error) return NextResponse.json({ error: "Revision could not be opened. Reload the verified equipment and check your access." }, { status: 409 });
    return NextResponse.json({ revision_id: revisionId, revision_open: true });
  }
  const state = await documentationState(auth.admin, id);
  if (state.error) return NextResponse.json({ error: state.error }, { status: 503 });
  const verifiedAt = typeof existing.documentation_verified_at === "string" ? existing.documentation_verified_at : null;
  if (verifiedAt) {
    if (body.verify_with_documentation === true) {
      return NextResponse.json({
        asset: { ...existing, documentation_verified: true, documentation_count: state.documentCount },
        verified: true,
      });
    }
    return NextResponse.json({
      error: "This equipment record is verified from documentation and is locked. A documented revision workflow is required before changing verified fields.",
    }, { status: 409 });
  }
  if (state.verified && !existing.documentation_revision_id) {
    const { error: syncError } = await auth.admin.rpc("cmpri_verify_asset_documentation", {
      p_asset_id: id,
      p_hotel_id: HOTEL_ID,
      p_expected_updated_at: existing.updated_at,
      p_actor_id: auth.principal.identity.id,
    });
    if (syncError) {
      return NextResponse.json({ error: "The existing documentation verification could not be safely locked to this equipment record." }, { status: 409 });
    }
    if (body.verify_with_documentation !== true) {
      return NextResponse.json({
        error: "This equipment record is verified from documentation and is locked. A documented revision workflow is required before changing verified fields.",
      }, { status: 409 });
    }
    return NextResponse.json({ asset: { ...existing, documentation_verified: true, documentation_count: state.documentCount }, verified: true });
  }
  if (body.verify_with_documentation === true) {
    if (Object.keys(body).some((key) => !["id", "verify_with_documentation", "expected_updated_at"].includes(key))) {
      return NextResponse.json({ error: "Save equipment changes separately before verifying." }, { status: 400 });
    }
    if (!state.documentCount) return NextResponse.json({ error: "Upload and process documentation before confirming this equipment." }, { status: 400 });
    if (body.expected_updated_at !== existing.updated_at) {
      return NextResponse.json({ error: "Reload and save the equipment before verification." }, { status: 409 });
    }
    // File presence alone is insufficient: historical empty objects are retained
    // for audit, but only a readable, nonempty PDF can support new verification.
    let readable = false;
    for (const registered of state.files || []) {
      const name = registered.name;
      if (!name.toLowerCase().endsWith(".pdf")) continue;
      const { data: file, error } = await auth.admin.storage.from(BUCKET).download(registered.storage_path);
      if (error || !file || !file.size || file.size > 100 * 1024 * 1024) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0,5)) !== "%PDF-") continue;
      try {
        if ((await extractManualPdfText(bytes)).trim()) { readable = true; break; }
        // Image-only sources must have an explicitly reviewed match for this
        // asset and the exact same original bytes. OCR remains a separate step.
        const links = Array.isArray(existing.pdf_import_links) ? existing.pdf_import_links : [];
        const applicability = eligibleManualLinks(existing, links);
        const match = applicability.eligible.find(link => link.object_id === registered.id && link.storage_path === registered.storage_path
          && link.sha256 === manualPdfSha256(bytes) && (link as {file_verified?: boolean}).file_verified === true
          && !applicability.warnings.some(warning => warning.link === link));
        if (match && await hasScannedManualContent(bytes)) { readable = true; break; }
      } catch { /* Try another saved PDF. */ }
    }
    if (!readable) return NextResponse.json({ error: "Verification requires a saved, readable PDF. Empty or unreadable files remain preserved; upload a valid copy before verifying." }, { status: 400 });
    // Database verification is authoritative. Leave historical marker files intact.
    const { error: verifyError } = await auth.admin.rpc("cmpri_verify_asset_documentation", {
      p_asset_id: id, p_hotel_id: HOTEL_ID, p_expected_updated_at: existing.updated_at,
      p_actor_id: auth.principal.identity.id,
    });
    if (verifyError) return NextResponse.json({ error: "Equipment changed during verification. Reload and review before verifying." }, { status: 409 });
    return NextResponse.json({ asset: { ...existing, documentation_verified: true, documentation_count: state.documentCount }, verified: true });
  }

  try {
    if (existing.documentation_revision_id && body.expected_updated_at !== existing.updated_at) {
      return NextResponse.json({ error: "This equipment revision changed. Reload before saving corrections." }, { status: 409 });
    }
    const update: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "location_id")) update.location_id = (await locationName(auth.admin, body.location_id)).id;
    for (const [field, maximum] of [["asset_type", 200], ["name", 500], ["asset_tag", 200], ["manufacturer", 200], ["model_family", 200], ["model_number", 200], ["serial_number", 300], ["generation", 200], ["documentation_key", 300]] as const) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        const value = optionalText(body[field], field, maximum);
        update[field] = field === "manufacturer" || field === "serial_number" ? value ?? "" : value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "install_year")) {
      update.install_year = parseAssetInstallYear(body.install_year);
    }
    if (Object.prototype.hasOwnProperty.call(body, "active")) {
      if (typeof body.active !== "boolean") throw new Error("Active must be true or false.");
      update.active = body.active;
      update.status = body.active ? "Active" : "Retired";
    }
    if (!Object.keys(update).length) return NextResponse.json({ error: "No equipment changes were supplied." }, { status: 400 });
    let mutation = auth.admin.from("assets").update(update).eq("hotel_id", HOTEL_ID).eq("id", id);
    if (existing.documentation_revision_id) mutation = mutation.eq("updated_at", existing.updated_at);
    const { data, error } = await mutation.select("*").single();
    if (error) {
      const status = /verified equipment is locked/i.test(error.message) ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ asset: { ...data, documentation_verified: false, documentation_count: state.documentCount } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Equipment could not be updated." }, { status: 400 });
  }
}
