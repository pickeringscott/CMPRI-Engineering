import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { fetchAllPages } from "@/lib/server/paginated-query";

function text(value: unknown, label: string, max = 500, required = false): string {
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

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value.trim())) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function numberValue(value: unknown, label: string, options: { min?: number; positive?: boolean; nullable?: boolean } = {}): number | null {
  if (value === undefined || value === null || value === "") {
    if (options.nullable !== false) return null;
    throw new Error(`${label} is required.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} is invalid.`);
  if (options.positive && result <= 0) throw new Error(`${label} must be greater than zero.`);
  if (options.min !== undefined && result < options.min) throw new Error(`${label} is too small.`);
  return result;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

async function bodyObject(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function scopedExists(admin: SupabaseClient, table: string, id: string | null, label: string) {
  if (!id) return null;
  const { data, error } = await admin.from(table).select("id").eq("hotel_id", HOTEL_ID).eq("id", id).maybeSingle();
  if (error) throw new Error(`${label} could not be verified.`);
  if (!data) throw new Error(`${label} does not belong to CMPRI.`);
  return id;
}

async function scopedAsset(admin: SupabaseClient, id: string | null) {
  return scopedExists(admin, "assets", id, "Asset");
}
async function scopedLocation(admin: SupabaseClient, id: string | null) {
  return scopedExists(admin, "locations", id, "Location");
}
async function scopedWorkOrder(admin: SupabaseClient, id: string | null) {
  return scopedExists(admin, "work_orders", id, "Work order");
}
async function scopedVendor(admin: SupabaseClient, id: string | null) {
  return scopedExists(admin, "cmpri_vendors", id, "Vendor");
}
async function scopedInventory(admin: SupabaseClient, id: string | null) {
  return scopedExists(admin, "cmpri_inventory_items", id, "Inventory item");
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Parts and vendor access requires equipment-management permission." }, { status: 403 });
  const { admin } = auth;
  const [vendors, contacts, proposals, inventory, compatibility, ideas, workOrderItems, assets, locations] = await Promise.all([
    admin.from("cmpri_vendors").select("*").eq("hotel_id", HOTEL_ID).order("company_name"),
    admin.from("cmpri_vendor_contacts").select("*").eq("hotel_id", HOTEL_ID).order("name"),
    admin.from("cmpri_vendor_proposals").select("*").eq("hotel_id", HOTEL_ID).order("proposal_date", { ascending: false }).limit(250),
    admin.from("cmpri_inventory_items").select("*").eq("hotel_id", HOTEL_ID).order("item_name"),
    admin.from("cmpri_asset_inventory_compatibility").select("*").eq("hotel_id", HOTEL_ID),
    admin.from("cmpri_order_ideas").select("*").eq("hotel_id", HOTEL_ID).order("created_at", { ascending: false }).limit(250),
    admin.from("cmpri_work_order_items").select("*").eq("hotel_id", HOTEL_ID).order("recorded_at", { ascending: false }).limit(500),
    fetchAllPages((from, to) => admin.from("assets")
      .select("id, name, asset_type, location_id, active")
      .eq("hotel_id", HOTEL_ID).eq("active", true).order("name").range(from, to)),
    admin.from("locations").select("id, name, room_number, area, active").eq("hotel_id", HOTEL_ID).eq("active", true).order("name"),
  ]);
  const failed = [vendors, contacts, proposals, inventory, compatibility, ideas, workOrderItems, assets, locations]
    .find((result) => result.error);
  if (failed?.error) return NextResponse.json({ error: `Parts/vendor data is not configured: ${failed.error.message}` }, { status: 503 });
  return NextResponse.json({
    vendors: vendors.data || [],
    contacts: contacts.data || [],
    proposals: proposals.data || [],
    inventory: inventory.data || [],
    compatibility: compatibility.data || [],
    ideas: ideas.data || [],
    work_order_items: workOrderItems.data || [],
    assets: assets.data || [],
    locations: locations.data || [],
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Parts and vendor editing requires equipment-management permission." }, { status: 403 });
  const body = await bodyObject(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const kind = text(body.kind, "Record type", 50, true);
  const actorId = auth.principal.identity.id;
  const actorName = auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI Engineering";

  try {
    if (kind === "vendor") {
      const row = {
        hotel_id: HOTEL_ID,
        company_name: text(body.company_name, "Company name", 200, true),
        services: Array.isArray(body.services) ? body.services.map((value) => text(value, "Service", 100, true)).slice(0, 30) : [],
        main_phone: text(body.main_phone, "Main phone", 80),
        email: text(body.email, "Email", 200),
        website: text(body.website, "Website", 500),
        emergency_phone: text(body.emergency_phone, "Emergency phone", 80),
        preferred: booleanValue(body.preferred),
        approved: booleanValue(body.approved),
        notes: text(body.notes, "Notes", 3000),
        active: body.active === undefined ? true : booleanValue(body.active),
        created_by: actorId,
      };
      const { data, error } = await auth.admin.from("cmpri_vendors").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ vendor: data });
    }

    if (kind === "contact") {
      const vendorId = await scopedVendor(auth.admin, optionalId(body.vendor_id, "Vendor"));
      if (!vendorId) throw new Error("Vendor is required.");
      const row = {
        hotel_id: HOTEL_ID,
        vendor_id: vendorId,
        name: text(body.name, "Contact name", 200, true),
        role_title: text(body.role_title, "Role/title", 200),
        phone: text(body.phone, "Phone", 80),
        mobile_phone: text(body.mobile_phone, "Mobile phone", 80),
        email: text(body.email, "Email", 200),
        emergency_contact: booleanValue(body.emergency_contact),
        active: body.active === undefined ? true : booleanValue(body.active),
        notes: text(body.notes, "Notes", 3000),
        created_by: actorId,
      };
      const { data, error } = await auth.admin.from("cmpri_vendor_contacts").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ contact: data });
    }

    if (kind === "inventory") {
      const vendorId = await scopedVendor(auth.admin, optionalId(body.preferred_vendor_id, "Preferred vendor"));
      const onHand = numberValue(body.quantity_on_hand, "Quantity on hand", { min: 0 }) ?? 0;
      const reserved = numberValue(body.quantity_reserved, "Quantity reserved", { min: 0 }) ?? 0;
      if (reserved > onHand) throw new Error("Reserved quantity cannot exceed quantity on hand.");
      const row = {
        hotel_id: HOTEL_ID,
        preferred_vendor_id: vendorId,
        item_name: text(body.item_name, "Item name", 300, true),
        description: text(body.description, "Description", 3000),
        manufacturer: text(body.manufacturer, "Manufacturer", 200),
        vendor_sku: text(body.vendor_sku, "Vendor SKU", 200),
        product_url: text(body.product_url, "Product URL", 1000),
        package_quantity: numberValue(body.package_quantity, "Package quantity", { positive: true }) ?? 1,
        unit_of_measure: text(body.unit_of_measure, "Unit of measure", 80) || "Each",
        quantity_on_hand: onHand,
        quantity_reserved: reserved,
        reorder_level: numberValue(body.reorder_level, "Reorder level", { min: 0 }),
        suggested_order_quantity: numberValue(body.suggested_order_quantity, "Suggested order quantity", { positive: true }),
        storage_location: text(body.storage_location, "Storage location", 300),
        current_unit_cost: numberValue(body.current_unit_cost, "Unit cost", { min: 0 }),
        active: body.active === undefined ? true : booleanValue(body.active),
        notes: text(body.notes, "Notes", 3000),
        created_by: actorId,
      };
      const compatibleAssetId = await scopedAsset(auth.admin, optionalId(body.compatible_asset_id, "Compatible asset"));
      const { data, error } = await auth.admin.from("cmpri_inventory_items").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      if (compatibleAssetId) {
        const compatibilityRow = { hotel_id: HOTEL_ID, asset_id: compatibleAssetId, inventory_item_id: data.id, notes: "", created_by: actorId };
        const { error: compatibilityError } = await auth.admin.from("cmpri_asset_inventory_compatibility").insert(compatibilityRow);
        if (compatibilityError) {
          await auth.admin.from("cmpri_inventory_items").delete().eq("hotel_id", HOTEL_ID).eq("id", data.id);
          throw new Error(`Inventory item was not kept because compatible-equipment linkage failed: ${compatibilityError.message}`);
        }
      }
      return NextResponse.json({ inventory_item: data });
    }

    if (kind === "compatibility") {
      const assetId = await scopedAsset(auth.admin, optionalId(body.asset_id, "Asset"));
      const itemId = await scopedInventory(auth.admin, optionalId(body.inventory_item_id, "Inventory item"));
      if (!assetId || !itemId) throw new Error("Asset and inventory item are required.");
      const row = { hotel_id: HOTEL_ID, asset_id: assetId, inventory_item_id: itemId, notes: text(body.notes, "Compatibility notes", 2000), created_by: actorId };
      const { data, error } = await auth.admin.from("cmpri_asset_inventory_compatibility").upsert(row, { onConflict: "asset_id,inventory_item_id" }).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ compatibility: data });
    }

    if (kind === "idea") {
      const itemId = await scopedInventory(auth.admin, optionalId(body.inventory_item_id, "Inventory item"));
      const assetId = await scopedAsset(auth.admin, optionalId(body.asset_id, "Asset"));
      const workOrderId = await scopedWorkOrder(auth.admin, optionalId(body.work_order_id, "Work order"));
      const source = text(body.source, "Source", 40) || "manual";
      if (!["manual", "work_order", "inventory_reorder"].includes(source)) throw new Error("Order-idea source is invalid.");
      const row = {
        hotel_id: HOTEL_ID,
        inventory_item_id: itemId,
        asset_id: assetId,
        work_order_id: workOrderId,
        item_text: text(body.item_text, "Order idea", 500, true),
        quantity: numberValue(body.quantity, "Quantity", { positive: true }),
        status: "Idea",
        source,
        created_by_user_id: actorId,
        created_by_name: actorName,
        notes: text(body.notes, "Notes", 3000),
      };
      const { data, error } = await auth.admin.from("cmpri_order_ideas").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ idea: data });
    }

    if (kind === "proposal") {
      const vendorId = await scopedVendor(auth.admin, optionalId(body.vendor_id, "Vendor"));
      if (!vendorId) throw new Error("Vendor is required.");
      const { data: vendor, error: vendorError } = await auth.admin.from("cmpri_vendors").select("company_name, main_phone, email").eq("hotel_id", HOTEL_ID).eq("id", vendorId).single();
      if (vendorError || !vendor) throw new Error("Vendor could not be loaded.");
      const contactId = optionalId(body.vendor_contact_id, "Vendor contact");
      let contact: { name?: string | null; phone?: string | null; mobile_phone?: string | null; email?: string | null } | null = null;
      if (contactId) {
        const result = await auth.admin.from("cmpri_vendor_contacts").select("name, phone, mobile_phone, email").eq("hotel_id", HOTEL_ID).eq("vendor_id", vendorId).eq("id", contactId).maybeSingle();
        if (result.error || !result.data) throw new Error("Vendor contact does not belong to the selected vendor.");
        contact = result.data;
      }
      const recommendation = text(body.recommendation, "Recommendation", 50);
      if (!["", "Repair", "Replace", "Repair Or Replace", "Other"].includes(recommendation)) throw new Error("Recommendation is invalid.");
      const row = {
        hotel_id: HOTEL_ID,
        vendor_id: vendorId,
        vendor_contact_id: contactId,
        asset_id: await scopedAsset(auth.admin, optionalId(body.asset_id, "Asset")),
        location_id: await scopedLocation(auth.admin, optionalId(body.location_id, "Location")),
        work_order_id: await scopedWorkOrder(auth.admin, optionalId(body.work_order_id, "Work order")),
        proposal_number: text(body.proposal_number, "Proposal number", 200),
        proposal_date: text(body.proposal_date, "Proposal date", 20) || new Date().toISOString().slice(0, 10),
        recommendation,
        status: "Pending",
        quoted_cost: numberValue(body.quoted_cost, "Quoted cost", { min: 0 }) ?? 0,
        scope_summary: text(body.scope_summary, "Scope summary", 5000),
        storage_path: text(body.storage_path, "Storage path", 1000),
        vendor_company_snapshot: String(vendor.company_name || ""),
        vendor_contact_snapshot: String(contact?.name || ""),
        vendor_phone_snapshot: String(contact?.mobile_phone || contact?.phone || vendor.main_phone || ""),
        vendor_email_snapshot: String(contact?.email || vendor.email || ""),
        notes: text(body.notes, "Notes", 5000),
        created_by: actorId,
      };
      const { data, error } = await auth.admin.from("cmpri_vendor_proposals").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ proposal: data });
    }

    if (kind === "work_order_item") {
      const workOrderId = await scopedWorkOrder(auth.admin, optionalId(body.work_order_id, "Work order"));
      const itemId = await scopedInventory(auth.admin, optionalId(body.inventory_item_id, "Inventory item"));
      if (!workOrderId || !itemId) throw new Error("Work order and inventory item are required.");
      const { data: item, error: itemError } = await auth.admin.from("cmpri_inventory_items").select("current_unit_cost").eq("hotel_id", HOTEL_ID).eq("id", itemId).single();
      if (itemError || !item) throw new Error("Inventory item could not be loaded.");
      const status = text(body.status, "Part status", 50) || "Suggested";
      if (!["Suggested", "Reserved", "Installed / Used", "Returned To Inventory", "Ordered", "Received"].includes(status)) throw new Error("Part status is invalid.");
      const row = {
        hotel_id: HOTEL_ID,
        work_order_id: workOrderId,
        inventory_item_id: itemId,
        status,
        quantity: numberValue(body.quantity, "Quantity", { positive: true, nullable: false }),
        unit_cost_snapshot: item.current_unit_cost,
        recorded_by_user_id: actorId,
        recorded_by_name: actorName,
        notes: text(body.notes, "Notes", 3000),
      };
      const { data, error } = await auth.admin.from("cmpri_work_order_items").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ work_order_item: data });
    }

    return NextResponse.json({ error: "Unsupported record type." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Record could not be saved." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Parts and vendor editing requires equipment-management permission." }, { status: 403 });
  const body = await bodyObject(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const kind = text(body.kind, "Record type", 50, true);
  const id = optionalId(body.id, "Record id");
  if (!id) return NextResponse.json({ error: "Record id is required." }, { status: 400 });
  const now = new Date().toISOString();

  try {
    if (kind === "idea") {
      const status = text(body.status, "Status", 50, true);
      if (!["Idea", "Ready To Order", "Ordered", "Received", "Dismissed"].includes(status)) throw new Error("Order-idea status is invalid.");
      const { data, error } = await auth.admin.from("cmpri_order_ideas").update({ status, updated_at: now }).eq("hotel_id", HOTEL_ID).eq("id", id).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ idea: data });
    }
    if (kind === "proposal") {
      const status = text(body.status, "Status", 50, true);
      if (!["Pending", "Approved", "Declined", "Expired", "Completed"].includes(status)) throw new Error("Proposal status is invalid.");
      const { data, error } = await auth.admin.from("cmpri_vendor_proposals").update({ status, updated_at: now }).eq("hotel_id", HOTEL_ID).eq("id", id).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ proposal: data });
    }
    if (kind === "inventory") {
      const onHand = numberValue(body.quantity_on_hand, "Quantity on hand", { min: 0, nullable: false });
      const reserved = numberValue(body.quantity_reserved, "Quantity reserved", { min: 0 }) ?? 0;
      if (onHand === null || reserved > onHand) throw new Error("Reserved quantity cannot exceed quantity on hand.");
      const { data, error } = await auth.admin.from("cmpri_inventory_items")
        .update({ quantity_on_hand: onHand, quantity_reserved: reserved, updated_at: now })
        .eq("hotel_id", HOTEL_ID).eq("id", id).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ inventory_item: data });
    }
    if (kind === "vendor") {
      const active = booleanValue(body.active, true);
      const { data, error } = await auth.admin.from("cmpri_vendors").update({ active, updated_at: now }).eq("hotel_id", HOTEL_ID).eq("id", id).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ vendor: data });
    }
    return NextResponse.json({ error: "Unsupported record type." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Record could not be updated." }, { status: 400 });
  }
}
