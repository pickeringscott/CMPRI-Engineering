"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SearchableSelect, { type SearchableSelectOption } from "@/components/SearchableSelect";
import { authorizationHeaders, hasCapability, loadCmpriSession } from "@/lib/auth/client-session";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import InventoryCatalog, {InventoryIdeas} from "@/components/InventoryCatalog";
import InventoryItemDialog from "@/components/InventoryItemDialog";
import useInventoryCommands from "@/components/useInventoryCommands";
import {subscribeResources} from "@/lib/events/browser";
import {mergeInventorySnapshot} from "@/lib/inventory";
import type {InventoryItem, InventoryIdea as Idea, InventoryResult, PoOption} from "@/lib/inventory";

type Vendor = { id: string; company_name: string; services?: string[]; main_phone?: string; email?: string; website?: string; emergency_phone?: string; preferred?: boolean; approved?: boolean; notes?: string; active?: boolean };
type Contact = { id: string; vendor_id: string; name: string; role_title?: string; phone?: string; mobile_phone?: string; email?: string; emergency_contact?: boolean; active?: boolean };
type Proposal = { id: string; vendor_id: string; vendor_contact_id?: string | null; asset_id?: string | null; location_id?: string | null; work_order_id?: string | null; proposal_number?: string; proposal_date: string; recommendation?: string; status: string; quoted_cost?: number; scope_summary?: string; vendor_company_snapshot: string; vendor_contact_snapshot?: string; vendor_phone_snapshot?: string; vendor_email_snapshot?: string; notes?: string };
type Compatibility = { asset_id: string; inventory_item_id: string; notes?: string };
type WorkOrderItem = { id: string; work_order_id: string; inventory_item_id: string; status: string; quantity: number; recorded_by_name?: string; recorded_at: string; notes?: string };
type Asset = { id: string; name: string; asset_type?: string; location_id?: string | null; active?: boolean };
type Location = { id: string; name: string; room_number?: string | null; area?: string | null; active?: boolean };
type Payload = { vendors: Vendor[]; contacts: Contact[]; proposals: Proposal[]; inventory: InventoryItem[]; compatibility: Compatibility[]; ideas: Idea[]; work_order_items: WorkOrderItem[]; assets: Asset[]; locations: Location[]; po_options?: PoOption[]; as_of?: string; stock_only?: boolean; error?: string };
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
  const [activeForm, setActiveForm] = useState<AddPanel>("");
  const [vendorName, setVendorName] = useState("");
  const [vendorPhone, setVendorPhone] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [vendorWebsite, setVendorWebsite] = useState("");
  const [vendorServices, setVendorServices] = useState("");
  const [contactVendor, setContactVendor] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactTitle, setContactTitle] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
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

  const [scope,setScope]=useState("");
  const [ready,setReady]=useState(false),[refreshing,setRefreshing]=useState(false),[selectedId,setSelectedId]=useState("");
  const readInFlight=useRef<Promise<void>|null>(null),sessionRead=useRef<ReturnType<typeof loadCmpriSession>|null>(null);
  const applyInventoryResult=useCallback((result:InventoryResult)=>{
    setData(current=>{
      const item=result.inventory_item,idea=result.idea;
      const previous=item?current.inventory.find(value=>value.id===item.id):null;
      const useItem=item&&(!previous||Number(item.inventory_revision)>=Number(previous.inventory_revision));
      return {...current,inventory:useItem?[...current.inventory.filter(value=>value.id!==item.id),item].sort((a,b)=>a.item_name.localeCompare(b.item_name)):current.inventory,
       ideas:idea?[idea,...current.ideas.filter(value=>value.id!==idea.id)]:current.ideas,
       compatibility:result.compatibility?[...current.compatibility.filter(value=>!(value.asset_id===result.compatibility?.asset_id&&value.inventory_item_id===result.compatibility?.inventory_item_id)),result.compatibility]:current.compatibility};
    });
    if(result.inventory_item)setSelectedId(result.inventory_item.id);
    setMessage(result.replayed?"Previous save confirmed without duplicating inventory.":"Inventory activity saved.");
  },[]);
  const inventoryCommands=useInventoryCommands(scope,applyInventoryResult);
  const load=useCallback((force=false)=>{
    if(readInFlight.current)return readInFlight.current;
    const operation=(async()=>{
      setRefreshing(true);
      try{
        sessionRead.current??=loadCmpriSession();
        const session=await sessionRead.current;
        if(!hasCapability(session,"manage_assets")){router.replace(session.landing||"/engineering");return;}
        setScope(`${session.hotelId}:${session.user.id}`);
        const headers=await authorizationHeaders();
        let response=await fetch("/api/engineering/catalog?v=2",{headers,cache:force?"reload":"no-store"});
        let payload=await response.json() as Payload;
        if(!response.ok)throw Error(payload.error||"Inventory could not be loaded completely.");
        setData(current=>({...current,...payload,inventory:mergeInventorySnapshot(current.inventory,payload.inventory)}));
        if(response.headers.get("X-CMPRI-Data-Cache")==="hit"){
          setReady(false);
          response=await fetch("/api/engineering/catalog?v=2&stock=1",{headers,cache:"reload"});
          payload=await response.json() as Payload;
          if(!response.ok)throw Error(payload.error||"Current inventory could not be verified.");
          setData(current=>({...current,...payload,inventory:mergeInventorySnapshot(current.inventory,payload.inventory)}));
        }
        setReady(true);
      }catch(error){setReady(false);setMessage(error instanceof Error?error.message:"Inventory unavailable.");}
      finally{setLoading(false);setRefreshing(false);}
    })();
    readInFlight.current=operation.finally(()=>{readInFlight.current=null;});return readInFlight.current;
  },[router]);
  useEffect(()=>subscribeResources(["reference","rooms"],()=>load(false)),[load]);

  async function post(body: Record<string, unknown>, success: string) {
    if(body.kind==="idea"){
      const result=await inventoryCommands.command("POST",body);
      if(result)setMessage(success);return Boolean(result);
    }
    if (saving) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/engineering/catalog", { method: "POST", headers: { ...(await authorizationHeaders()), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Save failed.");
      setMessage(success);
      await load(true);
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Save failed."); return false; }
    finally { setSaving(false); }
  }

  async function patch(body: Record<string, unknown>, success: string) {
    if(body.kind==="idea"){
      const result=await inventoryCommands.command("PATCH",body);
      if(result)setMessage(success);return Boolean(result);
    }
    if (saving) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/engineering/catalog", { method: "PATCH", headers: { ...(await authorizationHeaders()), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Update failed.");
      setMessage(success);
      await load(true);
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
  const assetById=useMemo(()=>new Map(data.assets.map(asset=>[asset.id,asset])),[data.assets]);
  const inventoryById = useMemo(() => new Map(data.inventory.map((item) => [item.id, item])), [data.inventory]);
  const reorder = useMemo(() => data.inventory.filter((item) => item.active !== false && item.reorder_level !== null && item.reorder_level !== undefined && Number(item.quantity_on_hand || 0) - Number(item.quantity_reserved || 0) <= Number(item.reorder_level)), [data.inventory]);

  const actionTitle: Record<Exclude<AddPanel, "">, string> = {
    vendor: "Add Vendor",
    contact: "Add Vendor Contact",
    inventory: "Add Inventory",
    idea: "Add Order Idea",
    proposal: "Record Proposal",
  };

  if (loading) return <main className="min-h-screen bg-slate-950 p-6 text-slate-100">{embedded && <ModalDashboardLink className="mb-4 inline-block rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink>}<p>Loading inventory…</p></main>;

  return <main className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-6"><div className="mx-auto w-full">
    {!embedded && <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">CMPRI Engineering</p><h1 className="mt-1 text-3xl font-bold">Inventory</h1><p className="mt-2 max-w-3xl text-sm text-slate-400">Inventory, compatible parts, order ideas, vendor contacts and repair/replace proposals.</p></div>
      <ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink>
    </header>}
    {embedded && <div className="mb-4"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink></div>}

    <div className="mt-4 flex flex-wrap gap-2">
      {(["vendor","contact","inventory","idea","proposal"] as const).map((key) => <button key={key} type="button" disabled={inventoryCommands.busy||inventoryCommands.uncertain} onClick={() => {inventoryCommands.clearError();setMessage("");setActiveForm(key);}} className="rounded-full border border-amber-500/35 bg-amber-950/20 px-3 py-1.5 text-xs font-bold text-amber-100 hover:bg-amber-950/40">{actionTitle[key]}</button>)}
    </div>

    {message && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">{message}</div>}

    {inventoryCommands.error&&!activeForm&&<div role="alert" className="mt-3 rounded-lg border border-current p-3 text-sm">{inventoryCommands.error}{inventoryCommands.uncertain&&<button type="button" disabled={inventoryCommands.busy||!ready} className="ml-2 underline" onClick={()=>void inventoryCommands.retry()}>Retry unconfirmed save</button>}</div>}
    <section className="mt-5 grid gap-3 sm:grid-cols-4"><div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-sm text-slate-400">Inventory Items</p><p className="cmpri-modal-kpi-value mt-1 text-3xl font-bold">{data.inventory.length}</p></div><div className="rounded-xl border border-amber-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Reorder Suggestions</p><p className="cmpri-modal-kpi-value mt-1 text-3xl font-bold">{reorder.length}</p></div><div className="rounded-xl border border-sky-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Open Order Ideas</p><p className="cmpri-modal-kpi-value mt-1 text-3xl font-bold">{data.ideas.filter((idea) => !["Received", "Dismissed"].includes(idea.status)).length}</p></div><div className="rounded-xl border border-purple-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Pending Proposals</p><p className="cmpri-modal-kpi-value mt-1 text-3xl font-bold">{data.proposals.filter((proposal) => proposal.status === "Pending").length}</p></div></section>

    <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_.8fr]">
      <InventoryCatalog data={data} commands={inventoryCommands} ready={ready} refreshing={refreshing} updatedAt={data.as_of} onRefresh={()=>void load(true)} selectedId={selectedId} onSelect={setSelectedId} onResult={applyInventoryResult}/>
      <InventoryIdeas ideas={data.ideas} poOptions={data.po_options||[]} commands={inventoryCommands} ready={ready}/>

    </div>

    <div className="mt-5 grid gap-5 lg:grid-cols-2">    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><h2 className="text-xl font-bold">Vendors & Contacts</h2><div className="mt-3 space-y-2">{data.vendors.map((vendor) => <div key={vendor.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><div className="flex justify-between gap-3"><b>{vendor.company_name}</b><div className="flex gap-1">{vendor.preferred && <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-200">Preferred</span>}{vendor.approved && <span className="rounded-full border border-green-500/40 px-2 py-0.5 text-[10px] text-green-200">Approved</span>}</div></div><p className="mt-1 text-xs text-slate-400">{vendor.main_phone || "No phone"}{vendor.email ? ` · ${vendor.email}` : ""}</p>{vendor.website && <p className="mt-1 break-all text-xs text-slate-500">{vendor.website}</p>}{data.contacts.filter((c) => c.vendor_id === vendor.id && c.active !== false).map((contact) => <p key={contact.id} className="mt-1 text-xs text-slate-500">{contact.name}{contact.role_title ? ` · ${contact.role_title}` : ""}{contact.mobile_phone || contact.phone ? ` · ${contact.mobile_phone || contact.phone}` : ""}</p>)}</div>)}{!data.vendors.length && <p className="text-sm text-slate-500">No vendors recorded yet.</p>}</div></section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><h2 className="text-xl font-bold">Vendor Proposals</h2><div className="mt-3 space-y-2">{data.proposals.map((proposal) => <div key={proposal.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><div className="flex justify-between gap-3"><div><b>{proposal.vendor_company_snapshot}</b><p className="text-xs text-slate-500">{proposal.proposal_number ? `Proposal ${proposal.proposal_number} · ` : ""}{proposal.proposal_date}{proposal.asset_id ? ` · ${assetById.get(proposal.asset_id)?.name || "Equipment"}` : ""}</p></div><div className="text-right"><span className="text-xs font-semibold text-purple-200">{proposal.status}</span><p className="text-sm font-bold">{money(proposal.quoted_cost)}</p></div></div>{proposal.scope_summary && <p className="mt-2 text-sm text-slate-300">{proposal.scope_summary}</p>}{proposal.recommendation && <p className="mt-1 text-xs text-amber-200">Recommendation: {proposal.recommendation}</p>}{proposal.status === "Pending" && <div className="mt-2 flex gap-2"><button onClick={() => void patch({ kind: "proposal", id: proposal.id, status: "Approved" }, "Proposal approved.")} className="rounded border border-green-500/40 px-2 py-1 text-[11px]">Approve</button><button onClick={() => void patch({ kind: "proposal", id: proposal.id, status: "Declined" }, "Proposal declined.")} className="rounded border border-red-500/40 px-2 py-1 text-[11px]">Decline</button></div>}</div>)}{!data.proposals.length && <p className="text-sm text-slate-500">No vendor proposals recorded yet.</p>}</div></section></div>
  </div>

  {activeForm && activeForm!=="inventory" && <div className="cmpri-modal-backdrop fixed inset-0 z-[130] flex items-center justify-center bg-black/75">
    <div role="dialog" aria-modal="true" aria-label={actionTitle[activeForm]} className="cmpri-modal-shell overflow-y-auto border border-slate-700 bg-slate-900 shadow-2xl">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-amber-400">Quick Add</p><h2 className="mt-1 text-xl font-bold">{actionTitle[activeForm]}</h2></div><button type="button" disabled={inventoryCommands.busy||inventoryCommands.uncertain||saving} onClick={() => setActiveForm("")} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm">Close</button></div>

      {(message||inventoryCommands.error)&&<p role="alert" className="mt-3 rounded-lg border border-current p-2 text-sm">{inventoryCommands.error||message}</p>}
      {inventoryCommands.uncertain&&<button type="button" disabled={inventoryCommands.busy||!ready} className="mt-2 underline" onClick={()=>void inventoryCommands.retry().then(result=>{if(result)setActiveForm("");})}>Retry unconfirmed save</button>}
      {activeForm === "vendor" && <div className="mt-4 grid gap-2"><input className={inputClass()} value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Company name" /><input className={inputClass()} value={vendorServices} onChange={(e) => setVendorServices(e.target.value)} placeholder="Services, comma separated" /><input className={inputClass()} value={vendorPhone} onChange={(e) => setVendorPhone(e.target.value)} placeholder="Phone" /><input className={inputClass()} value={vendorEmail} onChange={(e) => setVendorEmail(e.target.value)} placeholder="Email" /><input className={inputClass()} value={vendorWebsite} onChange={(e) => setVendorWebsite(e.target.value)} placeholder="Website (optional)" /><button disabled={saving || !vendorName.trim()} onClick={() => void post({ kind: "vendor", company_name: vendorName, services: vendorServices.split(",").map((v) => v.trim()).filter(Boolean), main_phone: vendorPhone, email: vendorEmail, website: vendorWebsite }, `Added vendor ${vendorName}.`).then((ok) => { if (ok) { setVendorName(""); setVendorServices(""); setVendorPhone(""); setVendorEmail(""); setVendorWebsite(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Vendor</button></div>}

      {activeForm === "contact" && <div className="mt-4 grid gap-2"><SearchableSelect value={contactVendor} options={vendorOptions} onChange={setContactVendor} placeholder="Vendor" required /><input className={inputClass()} value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" /><input className={inputClass()} value={contactTitle} onChange={(e) => setContactTitle(e.target.value)} placeholder="Role / title" /><input className={inputClass()} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone / mobile" /><input className={inputClass()} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email" /><button disabled={saving || !contactVendor || !contactName.trim()} onClick={() => void post({ kind: "contact", vendor_id: contactVendor, name: contactName, role_title: contactTitle, mobile_phone: contactPhone, email: contactEmail }, `Added vendor contact ${contactName}.`).then((ok) => { if (ok) { setContactName(""); setContactTitle(""); setContactPhone(""); setContactEmail(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Contact</button></div>}



      {activeForm === "idea" && <div className="mt-4 grid gap-2"><input className={inputClass()} value={ideaText} onChange={(e) => setIdeaText(e.target.value)} placeholder="What should we order?" /><input className={inputClass()} type="number" min="0.001" step="0.001" value={ideaQty} onChange={(e) => setIdeaQty(e.target.value)} placeholder="Quantity (optional)" /><SearchableSelect value={ideaItem} options={itemOptions} onChange={(value) => { setIdeaItem(value); if (!ideaText) setIdeaText(inventoryById.get(value)?.item_name || ""); }} placeholder="Catalog item (optional)" /><SearchableSelect value={ideaAsset} options={assetOptions} onChange={setIdeaAsset} placeholder="Equipment (optional)" /><button disabled={saving || inventoryCommands.busy || inventoryCommands.uncertain || !ready || !ideaText.trim()} onClick={() => void post({ kind: "idea", item_text: ideaText, quantity: num(ideaQty), inventory_item_id: ideaItem || null, asset_id: ideaAsset || null, source: "manual" }, "Order idea added.").then((ok) => { if (ok) { setIdeaText(""); setIdeaQty(""); setIdeaItem(""); setIdeaAsset(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Add Idea</button></div>}

      {activeForm === "proposal" && <div className="mt-4 grid gap-2"><SearchableSelect value={proposalVendor} options={vendorOptions} onChange={(value) => { setProposalVendor(value); setProposalContact(""); }} placeholder="Vendor" required /><SearchableSelect value={proposalContact} options={contactOptions} onChange={setProposalContact} placeholder="Vendor contact (optional)" /><SearchableSelect value={proposalAsset} options={assetOptions} onChange={setProposalAsset} placeholder="Equipment (optional)" /><SearchableSelect value={proposalLocation} options={locationOptions} onChange={setProposalLocation} placeholder="Location (optional)" /><input className={inputClass()} value={proposalNo} onChange={(e) => setProposalNo(e.target.value)} placeholder="Proposal number" /><SearchableSelect value={proposalRecommendation} options={recommendationOptions} onChange={setProposalRecommendation} placeholder="Repair / Replace recommendation" /><input className={inputClass()} type="number" min="0" step="0.01" value={proposalCost} onChange={(e) => setProposalCost(e.target.value)} placeholder="Quoted cost" /><textarea className="min-h-20 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm" value={proposalScope} onChange={(e) => setProposalScope(e.target.value)} placeholder="Scope summary" /><button disabled={saving || !proposalVendor} onClick={() => void post({ kind: "proposal", vendor_id: proposalVendor, vendor_contact_id: proposalContact || null, asset_id: proposalAsset || null, location_id: proposalLocation || null, proposal_number: proposalNo, recommendation: proposalRecommendation, quoted_cost: num(proposalCost) ?? 0, scope_summary: proposalScope }, "Vendor proposal recorded.").then((ok) => { if (ok) { setProposalContact(""); setProposalAsset(""); setProposalLocation(""); setProposalNo(""); setProposalCost(""); setProposalScope(""); setProposalRecommendation(""); setActiveForm(""); } })} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Record Proposal</button></div>}
    </div>
  </div>}
  {activeForm==="inventory"&&<InventoryItemDialog mode="create" items={data.inventory} locations={data.locations} vendors={data.vendors} assets={data.assets} commands={inventoryCommands} ready={ready} onClose={()=>setActiveForm("")} onExisting={setSelectedId} onRefresh={()=>void load(true)}/>}
</main>;
}
