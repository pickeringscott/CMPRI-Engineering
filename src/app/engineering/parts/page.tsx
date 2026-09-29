"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SearchableSelect, { type SearchableSelectOption } from "@/components/SearchableSelect";
import { authorizationHeaders, hasCapability, loadCmpriSession } from "@/lib/auth/client-session";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";

type Vendor = { id: string; company_name: string; services?: string[]; main_phone?: string; email?: string; website?: string; emergency_phone?: string; preferred?: boolean; approved?: boolean; notes?: string; active?: boolean };
type Contact = { id: string; vendor_id: string; name: string; role_title?: string; phone?: string; mobile_phone?: string; email?: string; emergency_contact?: boolean; active?: boolean };
type Proposal = { id: string; vendor_id: string; vendor_contact_id?: string | null; asset_id?: string | null; location_id?: string | null; work_order_id?: string | null; proposal_number?: string; proposal_date: string; recommendation?: string; status: string; quoted_cost?: number; scope_summary?: string; vendor_company_snapshot: string; vendor_contact_snapshot?: string; vendor_phone_snapshot?: string; vendor_email_snapshot?: string; notes?: string };
type InventoryItem = { id: string; preferred_vendor_id?: string | null; item_name: string; description?: string; manufacturer?: string; vendor_sku?: string; product_url?: string; package_quantity: number; unit_of_measure: string; quantity_on_hand: number; quantity_reserved: number; reorder_level?: number | null; suggested_order_quantity?: number | null; storage_location?: string; current_unit_cost?: number | null; active?: boolean; notes?: string };
type Compatibility = { asset_id: string; inventory_item_id: string; notes?: string };
type Idea = { id: string; inventory_item_id?: string | null; asset_id?: string | null; work_order_id?: string | null; item_text: string; quantity?: number | null; status: string; source: string; created_by_name?: string; created_at: string; notes?: string };
type WorkOrderItem = { id: string; work_order_id: string; inventory_item_id: string; status: string; quantity: number; recorded_by_name?: string; recorded_at: string; notes?: string };
type Asset = { id: string; name: string; asset_type?: string; location_id?: string | null; active?: boolean };
type Location = { id: string; name: string; room_number?: string | null; area?: string | null; active?: boolean };
type Payload = { vendors: Vendor[]; contacts: Contact[]; proposals: Proposal[]; inventory: InventoryItem[]; compatibility: Compatibility[]; ideas: Idea[]; work_order_items: WorkOrderItem[]; assets: Asset[]; locations: Location[]; error?: string };
type AddPanel = "vendor" | "contact" | "inventory" | "idea" | "proposal" | "";

const emptyPayload: Payload = { vendors: [], contacts: [], proposals: [], inventory: [], compatibility: [], ideas: [], work_order_items: [], assets: [], locations: [] };

function inputClass() { return "min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-amber-400"; }
function num(value: string) { return value.trim() === "" ? null : Number(value); }
function money(value?: number | null) { return value === null || value === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value); }

export default function PartsVendorsPage() {
  const embedded = useEmbeddedModal();
  const router = useRouter();
  const [data, setData] = useState<Payload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [assetFilter, setAssetFilter] = useState("");
  const [activeForm, setActiveForm] = useState<AddPanel>("");
  const [vendorName, setVendorName] = useState("");
  const [vendorPhone, setVendorPhone] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [vendorServices, setVendorServices] = useState("");
  const [contactVendor, setContactVendor] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactTitle, setContactTitle] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemVendor, setItemVendor] = useState("");
  const [itemSku, setItemSku] = useState("");
  const [itemManufacturer, setItemManufacturer] = useState("");
  const [itemOnHand, setItemOnHand] = useState("0");
  const [itemReorder, setItemReorder] = useState("");
  const [itemOrderQty, setItemOrderQty] = useState("");
  const [itemStorage, setItemStorage] = useState("");
  const [itemCost, setItemCost] = useState("");
  const [itemAsset, setItemAsset] = useState("");
  const [ideaText, setIdeaText] = useState("");
  const [ideaQty, setIdeaQty] = useState("");
  const [ideaItem, setIdeaItem] = useState("");
  const [ideaAsset, setIdeaAsset] = useState("");
  const [proposalVendor, setProposalVendor] = useState("");
  const [proposalContact, setProposalContact] = useState("");
  const [proposalAsset, setProposalAsset] = useState("");
  const [proposalLocation, setProposalLocation] = useState("");
  const [proposalNo, setProposalNo] = useState("");
  const [proposalCost, setProposalCost] = useState("");
  const [proposalScope, setProposalScope] = useState("");
  const [proposalRecommendation, setProposalRecommendation] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextSession = await loadCmpriSession();
      if (!hasCapability(nextSession, "manage_assets")) { router.replace(nextSession.landing || "/engineering"); return; }
      const response = await fetch("/api/engineering/catalog", { headers: await authorizationHeaders(), cache: "no-store" });
      const payload = await response.json() as Payload;
      if (!response.ok) throw new Error(payload.error || "Parts and vendor data could not be loaded.");
      setData(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Parts and vendor data could not be loaded.");
    } finally { setLoading(false); }
  }, [router]);

  useEffect(() => { void Promise.resolve().then(load).catch(() => router.replace("/")); }, [load, router]);

  async function post(body: Record<string, unknown>, success: string) {
    if (saving) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/engineering/catalog", { method: "POST", headers: { ...(await authorizationHeaders()), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Save failed.");
      setMessage(success);
      await load();
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Save failed."); return false; }
    finally { setSaving(false); }
  }

  async function patch(body: Record<string, unknown>, success: string) {
    if (saving) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/engineering/catalog", { method: "PATCH", headers: { ...(await authorizationHeaders()), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Update failed.");
      setMessage(success);
      await load();
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Update failed."); return false; }
    finally { setSaving(false); }
  }

  const vendorOptions = useMemo<SearchableSelectOption[]>(() => data.vendors.filter((v) => v.active !== false).map((v) => ({ value: v.id, label: v.company_name, group: v.preferred ? "Preferred Vendors" : "Vendors", keywords: [v.main_phone || "", v.email || "", ...(v.services || [])] })), [data.vendors]);
  const itemOptions = useMemo<SearchableSelectOption[]>(() => data.inventory.filter((item) => item.active !== false).map((item) => ({ value: item.id, label: item.item_name, group: item.manufacturer || "Parts / Supplies", keywords: [item.vendor_sku || "", item.description || "", item.storage_location || ""] })), [data.inventory]);
  const assetOptions = useMemo<SearchableSelectOption[]>(() => data.assets.map((asset) => ({ value: asset.id, label: asset.name, group: asset.asset_type || "Equipment", keywords: [asset.asset_type || ""] })), [data.assets]);
  const locationOptions = useMemo<SearchableSelectOption[]>(() => data.locations.map((location) => ({ value: location.id, label: location.room_number ? `Room ${location.room_number}` : location.name, group: location.area || "Locations", keywords: [location.name, location.room_number || ""] })), [data.locations]);
  const contactOptions = useMemo<SearchableSelectOption[]>(() => data.contacts.filter((contact) => contact.vendor_id === proposalVendor && contact.active !== false).map((contact) => ({ value: contact.id, label: contact.name, group: contact.role_title || "Contacts", keywords: [contact.phone || "", contact.mobile_phone || "", contact.email || ""] })), [data.contacts, proposalVendor]);
  const recommendationOptions = useMemo<SearchableSelectOption[]>(() => ["Repair", "Replace", "Repair Or Replace", "Other"].map((value) => ({ value, label: value })), []);
  const inventoryById = useMemo(() => new Map(data.inventory.map((item) => [item.id, item])), [data.inventory]);
  const vendorById = useMemo(() => new Map(data.vendors.map((vendor) => [vendor.id, vendor])), [data.vendors]);
  const assetById = useMemo(() => new Map(data.assets.map((asset) => [asset.id, asset])), [data.assets]);
  const compatibleIds = useMemo(() => new Set(data.compatibility.filter((row) => !assetFilter || row.asset_id === assetFilter).map((row) => row.inventory_item_id)), [assetFilter, data.compatibility]);
  const shownInventory = useMemo(() => assetFilter ? data.inventory.filter((item) => compatibleIds.has(item.id)) : data.inventory, [assetFilter, compatibleIds, data.inventory]);
  const reorder = useMemo(() => data.inventory.filter((item) => item.active !== false && item.reorder_level !== null && item.reorder_level !== undefined && Number(item.quantity_on_hand || 0) - Number(item.quantity_reserved || 0) <= Number(item.reorder_level)), [data.inventory]);

  const actionTitle: Record<Exclude<AddPanel, "">, string> = {
    vendor: "Add Vendor",
    contact: "Add Vendor Contact",
    inventory: "Add Inventory",
    idea: "Add Order Idea",
    proposal: "Record Proposal",
  };

  if (loading) return <main className="min-h-screen bg-slate-950 p-6 text-slate-100">{embedded && <ModalDashboardLink className="mb-4 inline-block rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink>}<p>Loading parts and vendors…</p></main>;

  return <main className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-6"><div className="mx-auto w-full">
    {!embedded && <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">CMPRI Engineering</p><h1 className="mt-1 text-3xl font-bold">Parts, Order Ideas & Vendors</h1><p className="mt-2 max-w-3xl text-sm text-slate-400">Inventory, compatible parts, order ideas, vendor contacts and repair/replace proposals.</p></div>
      <ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink>
    </header>}
    {embedded && <div className="mb-4"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink></div>}

    <div className="mt-4 flex flex-wrap gap-2">
      {(["vendor","contact","inventory","idea","proposal"] as const).map((key) => <button key={key} type="button" onClick={() => setActiveForm(key)} className="rounded-full border border-amber-500/35 bg-amber-950/20 px-3 py-1.5 text-xs font-bold text-amber-100 hover:bg-amber-950/40">{actionTitle[key]}</button>)}
    </div>

    {message && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">{message}</div>}

    <section className="mt-5 grid gap-3 sm:grid-cols-4"><div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-sm text-slate-400">Inventory Items</p><p className="mt-1 text-3xl font-bold">{data.inventory.length}</p></div><div className="rounded-xl border border-amber-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Reorder Suggestions</p><p className="mt-1 text-3xl font-bold">{reorder.length}</p></div><div className="rounded-xl border border-sky-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Open Order Ideas</p><p className="mt-1 text-3xl font-bold">{data.ideas.filter((idea) => !["Received", "Dismissed"].includes(idea.status)).length}</p></div><div className="rounded-xl border border-purple-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Pending Proposals</p><p className="mt-1 text-3xl font-bold">{data.proposals.filter((proposal) => proposal.status === "Pending").length}</p></div></section>

    <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_.8fr]">
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-xl font-bold">Parts Catalog</h2><p className="text-xs text-slate-400">Filter by equipment to see only parts explicitly marked compatible.</p></div><div className="w-full sm:w-80"><SearchableSelect value={assetFilter} options={assetOptions} onChange={setAssetFilter} placeholder="Filter by equipment" expandOnOpen footerActionLabel={assetFilter ? "Show all parts" : undefined} onFooterAction={assetFilter ? () => setAssetFilter("") : undefined} /></div></div>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-2">Part</th><th className="pb-2">Vendor / SKU</th><th className="pb-2">Available</th><th className="pb-2">Reorder</th><th className="pb-2">Storage</th><th className="pb-2">Cost</th></tr></thead><tbody className="divide-y divide-slate-800">{shownInventory.map((item) => { const available = Number(item.quantity_on_hand || 0) - Number(item.quantity_reserved || 0); const low = item.reorder_level !== null && item.reorder_level !== undefined && available <= Number(item.reorder_level); return <tr key={item.id}><td className="py-2 pr-3"><b>{item.item_name}</b>{item.description && <p className="max-w-md text-xs text-slate-500">{item.description}</p>}</td><td className="py-2 pr-3">{vendorById.get(item.preferred_vendor_id || "")?.company_name || "—"}{item.vendor_sku ? <p className="text-xs text-slate-500">SKU {item.vendor_sku}</p> : null}</td><td className={`py-2 pr-3 font-semibold ${low ? "text-amber-300" : ""}`}>{available} {item.unit_of_measure}</td><td className="py-2 pr-3">{item.reorder_level ?? "—"}{low && <button type="button" disabled={saving} onClick={() => void post({ kind: "idea", inventory_item_id: item.id, item_text: item.item_name, quantity: item.suggested_order_quantity || null, source: "inventory_reorder", notes: `Available ${available}; reorder level ${item.reorder_level}.` }, `Added ${item.item_name} to Order Ideas.`)} className="ml-2 rounded border border-amber-500/40 px-2 py-1 text-[11px] font-semibold text-amber-200">Add Idea</button>}</td><td className="py-2 pr-3">{item.storage_location || "—"}</td><td className="py-2">{money(item.current_unit_cost)}</td></tr>; })}{!shownInventory.length && <tr><td colSpan={6} className="py-5 text-slate-500">{assetFilter ? "No compatible parts have been linked to this equipment yet." : "No inventory items yet."}</td></tr>}</tbody></table></div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><h2 className="text-xl font-bold">Order Ideas</h2><p className="mt-1 text-xs text-slate-400">A lightweight list before an item becomes an order.</p><div className="mt-4 space-y-2">{data.ideas.map((idea) => <div key={idea.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><div className="flex justify-between gap-3"><div><b>{idea.item_text}</b><p className="text-xs text-slate-500">{idea.quantity ? `Qty ${idea.quantity} · ` : ""}{idea.source.replaceAll("_", " ")}{idea.asset_id ? ` · ${assetById.get(idea.asset_id)?.name || "Equipment"}` : ""}</p></div><span className="text-xs font-semibold text-amber-200">{idea.status}</span></div>{!["Received", "Dismissed"].includes(idea.status) && <div className="mt-2 flex flex-wrap gap-2">{idea.status === "Idea" && <button onClick={() => void patch({ kind: "idea", id: idea.id, status: "Ready To Order" }, "Order idea marked ready.")} className="rounded border border-amber-500/40 px-2 py-1 text-[11px]">Ready To Order</button>}{idea.status === "Ready To Order" && <button onClick={() => void patch({ kind: "idea", id: idea.id, status: "Ordered" }, "Order idea marked ordered.")} className="rounded border border-blue-500/40 px-2 py-1 text-[11px]">Ordered</button>}{idea.status === "Ordered" && <button onClick={() => void patch({ kind: "idea", id: idea.id, status: "Received" }, "Order idea marked received.")} className="rounded border border-green-500/40 px-2 py-1 text-[11px]">Received</button>}<button onClick={() => void patch({ kind: "idea", id: idea.id, status: "Dismissed" }, "Order idea dismissed.")} className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400">Dismiss</button></div>}</div>)}{!data.ideas.length && <p className="text-sm text-slate-500">No order ideas yet.</p>}</div></section>
    </div>

    <div className="mt-5 grid gap-5 lg:grid-cols-2"><section className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><h2 className="text-xl font-bold">Vendors & Contacts</h2><div className="mt-3 space-y-2">{data.vendors.map((vendor) => <div key={vendor.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><div className="flex justify-between gap-3"><b>{vendor.company_name}</b><div className="flex gap-1">{vendor.preferred && <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-200">Preferred</span>}{vendor.approved && <span className="rounded-full border border-green-500/40 px-2 py-0.5 text-[10px] text-green-200">Approved</span>}</div></div><p className="mt-1 text-xs text-slate-400">{vendor.main_phone || "No phone"}{vendor.email ? ` · ${vendor.email}` : ""}</p>{data.contacts.filter((c) => c.vendor_id === vendor.id && c.active !== false).map((contact) => <p key={contact.id} className="mt-1 text-xs text-slate-500">{contact.name}{contact.role_title ? ` · ${contact.role_title}` : ""}{contact.mobile_phone || contact.phone ? ` · ${contact.mobile_phone || contact.phone}` : ""}</p>)}</div>)}{!data.vendors.length && <p className="text-sm text-slate-500">No vendors recorded yet.</p>}</div></section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><h2 className="text-xl font-bold">Vendor Proposals</h2><div className="mt-3 space-y-2">{data.proposals.map((proposal) => <div key={proposal.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><div className="flex justify-between gap-3"><div><b>{proposal.vendor_company_snapshot}</b><p className="text-xs text-slate-500">{proposal.proposal_number ? `Proposal ${proposal.proposal_number} · ` : ""}{proposal.proposal_date}{proposal.asset_id ? ` · ${assetById.get(proposal.asset_id)?.name || "Equipment"}` : ""}</p></div><div className="text-right"><span className="text-xs font-semibold text-purple-200">{proposal.status}</span><p className="text-sm font-bold">{money(proposal.quoted_cost)}</p></div></div>{proposal.scope_summary && <p className="mt-2 text-sm text-slate-300">{proposal.scope_summary}</p>}{proposal.recommendation && <p className="mt-1 text-xs text-amber-200">Recommendation: {proposal.recommendation}</p>}{proposal.status === "Pending" && <div className="mt-2 flex gap-2"><button onClick={() => void patch({ kind: "proposal", id: proposal.id, status: "Approved" }, "Proposal approved.")} className="rounded border border-green-500/40 px-2 py-1 text-[11px]">Approve</button><button onClick={() => void patch({ kind: "proposal", id: proposal.id, status: "Declined" }, "Proposal declined.")} className="rounded border border-red-500/40 px-2 py-1 text-[11px]">Decline</button></div>}</div>)}{!data.proposals.length && <p className="text-sm text-slate-500">No vendor proposals recorded yet.</p>}</div></section></div>
  </div>

  {activeForm && <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/75 p-1">
    <div role="dialog" aria-modal="true" aria-label={actionTitle[activeForm]} className="cmpri-modal-shell overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-amber-400">Quick Add</p><h2 className="mt-1 text-xl font-bold">{actionTitle[activeForm]}</h2></div><button type="button" onClick={() => setActiveForm("")} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm">Close</button></div>

      {activeForm === "vendor" && <div className="mt-4 grid gap-2"><input className={inputClass()} value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Company name" /><input className={inputClass()} value={vendorServices} onChange={(e) => setVendorServices(e.target.value)} placeholder="Services, comma separated" /><input className={inputClass()} value={vendorPhone} onChange={(e) => setVendorPhone(e.target.value)} placeholder="Phone" /><input className={inputClass()} value={vendorEmail} onChange={(e) => setVendorEmail(e.target.value)} placeholder="Email" /><button disabled={saving || !vendorName.trim()} onClick={() => void post({ kind: "vendor", company_name: vendorName, services: vendorServices.split(",").map((v) => v.trim()).filter(Boolean), main_phone: vendorPhone, email: vendorEmail }, `Added vendor ${vendorName}.`).then((ok) => { if (ok) { setVendorName(""); setVendorServices(""); setVendorPhone(""); setVendorEmail(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Vendor</button></div>}

      {activeForm === "contact" && <div className="mt-4 grid gap-2"><SearchableSelect value={contactVendor} options={vendorOptions} onChange={setContactVendor} placeholder="Vendor" required /><input className={inputClass()} value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" /><input className={inputClass()} value={contactTitle} onChange={(e) => setContactTitle(e.target.value)} placeholder="Role / title" /><input className={inputClass()} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone / mobile" /><input className={inputClass()} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email" /><button disabled={saving || !contactVendor || !contactName.trim()} onClick={() => void post({ kind: "contact", vendor_id: contactVendor, name: contactName, role_title: contactTitle, mobile_phone: contactPhone, email: contactEmail }, `Added vendor contact ${contactName}.`).then((ok) => { if (ok) { setContactName(""); setContactTitle(""); setContactPhone(""); setContactEmail(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Contact</button></div>}

      {activeForm === "inventory" && <div className="mt-4 grid gap-2"><input className={inputClass()} value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Part / supply" /><SearchableSelect value={itemVendor} options={vendorOptions} onChange={setItemVendor} placeholder="Preferred vendor" /><input className={inputClass()} value={itemSku} onChange={(e) => setItemSku(e.target.value)} placeholder="Vendor SKU" /><input className={inputClass()} value={itemManufacturer} onChange={(e) => setItemManufacturer(e.target.value)} placeholder="Manufacturer" /><div className="grid grid-cols-2 gap-2"><input className={inputClass()} type="number" min="0" step="0.001" value={itemOnHand} onChange={(e) => setItemOnHand(e.target.value)} placeholder="On hand" /><input className={inputClass()} type="number" min="0" step="0.001" value={itemReorder} onChange={(e) => setItemReorder(e.target.value)} placeholder="Reorder at" /></div><div className="grid grid-cols-2 gap-2"><input className={inputClass()} type="number" min="0.001" step="0.001" value={itemOrderQty} onChange={(e) => setItemOrderQty(e.target.value)} placeholder="Order qty" /><input className={inputClass()} type="number" min="0" step="0.01" value={itemCost} onChange={(e) => setItemCost(e.target.value)} placeholder="Unit cost" /></div><input className={inputClass()} value={itemStorage} onChange={(e) => setItemStorage(e.target.value)} placeholder="Storage location" /><SearchableSelect value={itemAsset} options={assetOptions} onChange={setItemAsset} placeholder="Compatible equipment (optional)" /><button disabled={saving || !itemName.trim()} onClick={() => void post({ kind: "inventory", item_name: itemName, preferred_vendor_id: itemVendor || null, vendor_sku: itemSku, manufacturer: itemManufacturer, quantity_on_hand: num(itemOnHand) ?? 0, reorder_level: num(itemReorder), suggested_order_quantity: num(itemOrderQty), storage_location: itemStorage, current_unit_cost: num(itemCost), compatible_asset_id: itemAsset || null }, itemAsset ? `Added ${itemName} and linked it to compatible equipment.` : `Added inventory item ${itemName}.`).then((ok) => { if (ok) { setItemName(""); setItemSku(""); setItemManufacturer(""); setItemOnHand("0"); setItemReorder(""); setItemOrderQty(""); setItemStorage(""); setItemCost(""); setItemAsset(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Inventory Item</button></div>}

      {activeForm === "idea" && <div className="mt-4 grid gap-2"><input className={inputClass()} value={ideaText} onChange={(e) => setIdeaText(e.target.value)} placeholder="What should we order?" /><input className={inputClass()} type="number" min="0.001" step="0.001" value={ideaQty} onChange={(e) => setIdeaQty(e.target.value)} placeholder="Quantity (optional)" /><SearchableSelect value={ideaItem} options={itemOptions} onChange={(value) => { setIdeaItem(value); if (!ideaText) setIdeaText(inventoryById.get(value)?.item_name || ""); }} placeholder="Catalog item (optional)" /><SearchableSelect value={ideaAsset} options={assetOptions} onChange={setIdeaAsset} placeholder="Equipment (optional)" /><button disabled={saving || !ideaText.trim()} onClick={() => void post({ kind: "idea", item_text: ideaText, quantity: num(ideaQty), inventory_item_id: ideaItem || null, asset_id: ideaAsset || null, source: "manual" }, "Order idea added.").then((ok) => { if (ok) { setIdeaText(""); setIdeaQty(""); setIdeaItem(""); setIdeaAsset(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Idea</button></div>}

      {activeForm === "proposal" && <div className="mt-4 grid gap-2"><SearchableSelect value={proposalVendor} options={vendorOptions} onChange={(value) => { setProposalVendor(value); setProposalContact(""); }} placeholder="Vendor" required /><SearchableSelect value={proposalContact} options={contactOptions} onChange={setProposalContact} placeholder="Vendor contact (optional)" /><SearchableSelect value={proposalAsset} options={assetOptions} onChange={setProposalAsset} placeholder="Equipment (optional)" /><SearchableSelect value={proposalLocation} options={locationOptions} onChange={setProposalLocation} placeholder="Location (optional)" /><input className={inputClass()} value={proposalNo} onChange={(e) => setProposalNo(e.target.value)} placeholder="Proposal number" /><SearchableSelect value={proposalRecommendation} options={recommendationOptions} onChange={setProposalRecommendation} placeholder="Repair / Replace recommendation" /><input className={inputClass()} type="number" min="0" step="0.01" value={proposalCost} onChange={(e) => setProposalCost(e.target.value)} placeholder="Quoted cost" /><textarea className="min-h-20 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm" value={proposalScope} onChange={(e) => setProposalScope(e.target.value)} placeholder="Scope summary" /><button disabled={saving || !proposalVendor} onClick={() => void post({ kind: "proposal", vendor_id: proposalVendor, vendor_contact_id: proposalContact || null, asset_id: proposalAsset || null, location_id: proposalLocation || null, proposal_number: proposalNo, recommendation: proposalRecommendation, quoted_cost: num(proposalCost) ?? 0, scope_summary: proposalScope }, "Vendor proposal recorded.").then((ok) => { if (ok) { setProposalContact(""); setProposalAsset(""); setProposalLocation(""); setProposalNo(""); setProposalCost(""); setProposalScope(""); setProposalRecommendation(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Record Proposal</button></div>}
    </div>
  </div>}
</main>;
}
