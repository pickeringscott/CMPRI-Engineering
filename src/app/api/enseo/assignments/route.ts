import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireCapability, requireUser } from "@/lib/server/auth";

type MoveInput = {
  asset_id?: unknown;
  device_type?: unknown;
  location_id?: unknown;
  room_number?: unknown;
  sub_location?: unknown;
  endpoint_code?: unknown;
  paired_asset_id?: unknown;
};

function readText(value: unknown, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid text value.");
  const text = value.trim();
  if (text.length > maximum) throw new Error("Text value is too long.");
  return text || null;
}

function normalizeMove(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each device move must be an object.");
  const input = value as MoveInput;
  const assetId = readText(input.asset_id, 80);
  const locationId = readText(input.location_id, 80);
  const deviceType = readText(input.device_type, 10)?.toUpperCase();
  const subLocation = readText(input.sub_location, 120);
  if (!assetId || !locationId || !subLocation || (deviceType !== "TV" && deviceType !== "STB")) {
    throw new Error("Every move requires an asset, TV/STB type, destination, and sub-location.");
  }
  return {
    asset_id: assetId,
    device_type: deviceType,
    location_id: locationId,
    room_number: readText(input.room_number, 30),
    sub_location: subLocation,
    endpoint_code: deviceType === "STB" ? readText(input.endpoint_code, 80)?.toUpperCase() || null : null,
    paired_asset_id: readText(input.paired_asset_id, 80),
  };
}

async function getData(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  if (!allows(auth.principal, "view_dashboard") && !allows(auth.principal, "manage_assets")) {
    return { response: NextResponse.json({ error: "Engineering access is required." }, { status: 403 }) } as const;
  }

  const [assignments, assets, locations, history] = await Promise.all([
    auth.admin.from("cmpri_enseo_assignments")
      .select("id, asset_id, device_type, location_id, room_number, sub_location, endpoint_code, paired_asset_id, active, revision, updated_at")
      .eq("hotel_id", HOTEL_ID).eq("active", true)
      .order("room_number", { ascending: true }).order("sub_location", { ascending: true }),
    auth.admin.from("assets")
      .select("id, name, asset_type, asset_tag, location_id, active, status, manufacturer, model_number, serial_number")
      .eq("hotel_id", HOTEL_ID).eq("active", true).order("name", { ascending: true }),
    auth.admin.from("locations")
      .select("id, name, room_number, location_type, area, active")
      .eq("hotel_id", HOTEL_ID).eq("active", true).order("room_number", { ascending: true }).order("name", { ascending: true }),
    auth.admin.from("cmpri_enseo_assignment_history")
      .select("id, batch_id, asset_id, reason, from_room_number, from_sub_location, from_endpoint_code, to_room_number, to_sub_location, to_endpoint_code, moved_at")
      .eq("hotel_id", HOTEL_ID).order("moved_at", { ascending: false }).limit(100),
  ]);

  const schemaError = assignments.error?.message || history.error?.message;
  if (schemaError) {
    return { response: NextResponse.json({ configured: false, error: "Enseo assignment storage has not been prepared.", assignments: [], assets: [], locations: [], history: [] }, { status: 503 }) } as const;
  }
  if (assets.error || locations.error) {
    return { response: NextResponse.json({ error: "CMPRI equipment or locations could not be loaded." }, { status: 503 }) } as const;
  }

  return {
    auth,
    payload: {
      configured: true,
      can_manage: allows(auth.principal, "manage_assets"),
      assignments: assignments.data || [],
      assets: assets.data || [],
      locations: locations.data || [],
      history: history.data || [],
    },
  } as const;
}

export async function GET(request: NextRequest) {
  const result = await getData(request);
  if ("response" in result) return result.response;
  return NextResponse.json(result.payload, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Equipment-management permission is required." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "A valid JSON body is required." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });

  try {
    const rawMoves = (body as { moves?: unknown }).moves;
    if (!Array.isArray(rawMoves) || rawMoves.length < 1 || rawMoves.length > 20) {
      return NextResponse.json({ error: "Provide 1 to 20 device moves." }, { status: 400 });
    }
    const moves = rawMoves.map(normalizeMove);
    if (new Set(moves.map((move) => move.asset_id)).size !== moves.length) {
      return NextResponse.json({ error: "The same device cannot be moved twice in one batch." }, { status: 400 });
    }
    const reason = readText((body as { reason?: unknown }).reason, 500);
    const { data, error } = await auth.admin.rpc("cmpri_apply_enseo_moves", {
      p_hotel_id: HOTEL_ID,
      p_actor_user_id: auth.principal.identity.id,
      p_moves: moves,
      p_reason: reason,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ assignments: data || [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Enseo assignments could not be updated." }, { status: 400 });
  }
}
