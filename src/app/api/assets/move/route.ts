import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { canEditEquipment } from "@/lib/server/roles";
import { accountRoleDisplayName } from "@/lib/account-display";
import { historyLine } from "@/lib/ticket-note-presentation";
import { isUuid } from "@/lib/uuid";

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth || !canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid move request." }, { status: 400 });
  const { assetId, destinationId, expectedAssetUpdatedAt, workOrderId, expectedWorkOrderRevision } = body as Record<string, unknown>;
  if (typeof assetId !== "string" || !isUuid(assetId) || typeof destinationId !== "string" || !isUuid(destinationId) || typeof expectedAssetUpdatedAt !== "string" || Number.isNaN(Date.parse(expectedAssetUpdatedAt)) || (workOrderId != null && (typeof workOrderId !== "string" || !isUuid(workOrderId) || !Number.isSafeInteger(expectedWorkOrderRevision) || Number(expectedWorkOrderRevision) < 1))) return NextResponse.json({ error: "Select an asset, destination and current work order." }, { status: 400 });
  if (workOrderId && !allows(auth.principal, "edit_tickets")) return NextResponse.json({ error: "Work-order editing permission is required." }, { status: 403 });
  const { data: asset, error: assetError } = await auth.admin.from("assets").select("location_id").eq("hotel_id", HOTEL_ID).eq("id", assetId).maybeSingle();
  if (assetError) return NextResponse.json({ error: "Asset could not be loaded." }, { status: 503 });
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  const ids = [asset.location_id, destinationId].filter((id): id is string => typeof id === "string");
  const locations = await auth.admin.from("locations").select("id,name").eq("hotel_id", HOTEL_ID).in("id", ids);
  if (locations.error) return NextResponse.json({ error: "Locations could not be loaded." }, { status: 503 });
  const from = locations.data?.find(item => item.id === asset.location_id)?.name || "Unassigned";
  const to = locations.data?.find(item => item.id === destinationId)?.name || "Unknown location";
  const note = historyLine({ id: "", kind: "note", text: `Moved asset from ${from} to ${to}.`, timestamp: new Date().toISOString(), actor: auth.principal.profile.full_name?.trim() || "CMPRI User", authorRole: accountRoleDisplayName(auth.principal.profile) });
  const { error } = await auth.admin.rpc("cmpri_move_asset_with_order", { p_hotel: HOTEL_ID, p_asset: assetId, p_destination: destinationId, p_expected_asset_updated_at: expectedAssetUpdatedAt, p_order: workOrderId || null, p_expected_order_revision: workOrderId ? expectedWorkOrderRevision : null, p_actor: auth.principal.identity.id, p_note: workOrderId ? note : null });
  if (error) return NextResponse.json({ error: "The move could not be saved. Reload the asset and work order, then retry." }, { status: 409 });
  return NextResponse.json({ moved: true }, { headers: { "Cache-Control": "no-store" } });
}
