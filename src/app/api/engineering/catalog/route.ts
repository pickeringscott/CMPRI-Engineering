import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { inventoryRequest } from "@/lib/inventory";

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
  const {data,error} = await auth.admin.rpc("cmpri_inventory_snapshot",{p_hotel:HOTEL_ID,p_stock_only:request.nextUrl.searchParams.get("stock")==="1"});
  if(error || !data)return NextResponse.json({error:"Inventory could not be loaded completely."},{status:503});
  return NextResponse.json(data,{headers:{"Cache-Control":"private, no-store"}});
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Parts and vendor editing requires equipment-management permission." }, { status: 403 });
  const body = await bodyObject(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  let kind: string;
  try {
    kind = text(body.kind, "Record type", 50, true);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Record type is invalid." }, { status: 400 });
  }
  const actorId = auth.principal.identity.id;

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

    if (kind === "inventory") return saveInventory(auth,body,"POST");

    if (kind === "compatibility") {
      const assetId = await scopedAsset(auth.admin, optionalId(body.asset_id, "Asset"));
      const itemId = await scopedInventory(auth.admin, optionalId(body.inventory_item_id, "Inventory item"));
      if (!assetId || !itemId) throw new Error("Asset and inventory item are required.");
      const row = { hotel_id: HOTEL_ID, asset_id: assetId, inventory_item_id: itemId, notes: text(body.notes, "Compatibility notes", 2000), created_by: actorId };
      const { data, error } = await auth.admin.from("cmpri_asset_inventory_compatibility").upsert(row, { onConflict: "asset_id,inventory_item_id" }).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ compatibility: data });
    }

    if (kind === "idea") return saveIdea(auth,body,null);

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

    if (kind === "work_order_item") return NextResponse.json({error:"Record actual usage through Labor & Parts; stock changes require the guarded inventory workflow."},{status:409});

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
  let kind: string;
  let id: string | null;
  try {
    kind = text(body.kind, "Record type", 50, true);
    id = optionalId(body.id, "Record id");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Record details are invalid." }, { status: 400 });
  }
  if (!id) return NextResponse.json({ error: "Record id is required." }, { status: 400 });
  const now = new Date().toISOString();

  try {
    if (kind === "idea") return saveIdea(auth,body,id);

    if (kind === "proposal") {
      const status = text(body.status, "Status", 50, true);
      if (!["Pending", "Approved", "Declined", "Expired", "Completed"].includes(status)) throw new Error("Proposal status is invalid.");
      const { data, error } = await auth.admin.from("cmpri_vendor_proposals").update({ status, updated_at: now }).eq("hotel_id", HOTEL_ID).eq("id", id).select("*").single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ proposal: data });
    }
    if (kind === "inventory") return saveInventory(auth,body,"PATCH");

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

type CatalogAuth = NonNullable<Awaited<ReturnType<typeof requireCapability>>>;
function inventoryFailure(error:{code?:string;message?:string}) {
 const conflict=error.code==="40001"||error.code==="23505";
 return NextResponse.json({error:error.message||"Inventory save was not confirmed.",refresh_required:error.code==="40001"},{status:conflict?409:/^(P0001|22|23)/.test(error.code||"")?400:503});
}
async function saveInventory(auth:CatalogAuth,body:Record<string,unknown>,method:"POST"|"PATCH") {
 try{
  const parsed=inventoryRequest(body,method);
  const {data,error}=await auth.admin.rpc("cmpri_inventory_mutate",{p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_id:parsed.requestId,p_action:parsed.action,p_item:parsed.item,p_data:parsed.data,p_expected:parsed.expected});
  if(error)return inventoryFailure(error);
  return NextResponse.json(data,{headers:{"Cache-Control":"no-store"}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid inventory details."},{status:400});}
}
async function saveIdea(auth:CatalogAuth,body:Record<string,unknown>,id:string|null) {
 if(typeof body.request_id!=="string"||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.request_id))return NextResponse.json({error:"A stable order-idea save ID is required."},{status:400});
 const {data,error}=await auth.admin.rpc("cmpri_inventory_idea_mutate",{p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_id:body.request_id,p_idea:id,p_data:body});
 if(error)return inventoryFailure(error);
 return NextResponse.json(data,{headers:{"Cache-Control":"no-store"}});
}
