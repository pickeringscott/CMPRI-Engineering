import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { parseAssetInstallYear } from "@/lib/asset-install-year";
import { allows } from "@/lib/server/access";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { canEditEquipment, canReadEquipment } from "@/lib/server/roles";
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
  const prefix = `${HOTEL_ID}/${assetId}`;
  const names: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data: files, error } = await data.storage.from(BUCKET).list(prefix, { limit: 100, offset });
    if (error) {
      if (/not found|bucket/i.test(error.message || "")) return { verified: false, documentCount: 0, error: null };
      return { verified: false, documentCount: 0, error: "Equipment documentation verification is unavailable." };
    }
    names.push(...(files || []).map((file) => String(file.name || "")));
    if ((files || []).length < 100) break;
  }
  return {
    verified: names.includes(VERIFY_MARKER),
    documentCount: names.filter((name) => name && name !== VERIFY_MARKER).length,
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
      .select("id, location_id, asset_type, name, asset_tag, binder_tag, quantity, active, status, manufacturer, model_family, model_number, serial_number, generation, install_year, documentation_key, documentation_verified_at, documentation_verified_by")
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
            documentation_verified: Boolean(asset.documentation_verified_at) || state.verified,
            documentation_count: state.documentCount,
          },
        };
      }))
    : assets.map((asset) => ({
      state: { verified: false, documentCount: 0, error: null },
      asset: {
        ...asset,
        documentation_verified: Boolean(asset.documentation_verified_at),
        documentation_count: 0,
      },
    }));
  return NextResponse.json({
    assets: results.map((result) => result.asset),
    can_manage: canEditEquipment(auth.principal.profile.role),
    documentation_state_available: !results.some((result) => result.state.error),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
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
  if (state.verified) {
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
    if (!state.documentCount) return NextResponse.json({ error: "Upload and process documentation before confirming this equipment." }, { status: 400 });
    const marker = JSON.stringify({
      asset_id: id,
      verified_at: new Date().toISOString(),
      verified_by_user_id: auth.principal.identity.id,
      verified_by: auth.principal.profile.full_name || auth.principal.identity.email || "Unknown User",
    });
    const path = `${HOTEL_ID}/${id}/${VERIFY_MARKER}`;
    const { error: markerError } = await auth.admin.storage.from(BUCKET).upload(path, new TextEncoder().encode(marker), {
      contentType: "application/json", upsert: true, metadata: { cmpri_type: "equipment_verification" },
    });
    if (markerError) return NextResponse.json({ error: `Could not save verification record: ${markerError.message}` }, { status: 400 });
    const { error: verifyError } = await auth.admin.rpc("cmpri_verify_asset_documentation", {
      p_asset_id: id,
      p_hotel_id: HOTEL_ID,
      p_expected_updated_at: existing.updated_at,
      p_actor_id: auth.principal.identity.id,
    });
    if (verifyError) {
      const { data: current, error: currentError } = await auth.admin.from("assets")
        .select("documentation_verified_at")
        .eq("hotel_id", HOTEL_ID)
        .eq("id", id)
        .maybeSingle();
      if (currentError) {
        return NextResponse.json({ error: "Verification status could not be confirmed. The uploaded marker was retained for administrator review." }, { status: 503 });
      }
      if (current?.documentation_verified_at) {
        return NextResponse.json({
          asset: { ...existing, documentation_verified_at: current.documentation_verified_at, documentation_verified: true, documentation_count: state.documentCount },
          verified: true,
        });
      }
      const { error: cleanupError } = await auth.admin.storage.from(BUCKET).remove([path]);
      if (cleanupError) {
        console.error("Uncommitted equipment verification marker could not be removed.", { assetId: id, cleanupError });
        return NextResponse.json({ error: "Equipment verification was not committed and its marker could not be removed. An administrator must review it." }, { status: 503 });
      }
      return NextResponse.json({ error: "The equipment changed during verification. Reload it and verify again." }, { status: 409 });
    }
    return NextResponse.json({
      asset: { ...existing, documentation_verified: true, documentation_count: state.documentCount },
      verified: true,
    });
  }

  try {
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
    const { data, error } = await auth.admin.from("assets").update(update).eq("hotel_id", HOTEL_ID).eq("id", id).select("*").single();
    if (error) {
      const status = /verified equipment is locked/i.test(error.message) ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ asset: { ...data, documentation_verified: false, documentation_count: state.documentCount } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Equipment could not be updated." }, { status: 400 });
  }
}
