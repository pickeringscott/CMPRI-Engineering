"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { enforceSessionPreference } from "@/lib/auth/session-preference";

type Shipment = { id: string; tracking_number?: string | null; ship_from?: string | null; status?: string | null; eta?: string | null; delivered_at?: string | null; received_at?: string | null };
type Purchase = { id: string; order_number?: string | null; vendor?: string | null; status?: string | null; eta?: string | null; work_order_id?: string | null; updated_at?: string | null; cmpri_purchase_shipments?: Shipment[] };
type Enseo = { id: string; ticket_number?: string | null; room_number?: string | null; enseo_endpoint?: string | null; status?: string | null; work_order_id?: string | null; updated_at?: string | null };
type Warranty = { id: string; warranty_case_number?: string | null; rma_number?: string | null; vendor?: string | null; status?: string | null; work_order_id?: string | null; tracking_numbers?: string[] | null; ship_from?: string | null; eta?: string | null; updated_at?: string | null };
type Followup = { id: string; topic?: string | null; status?: string | null; purchase_id?: string | null; work_order_id?: string | null; updated_at?: string | null };
type Operations = { can_edit?: boolean; configured: boolean; error?: string; purchases: Purchase[]; enseo: Enseo[]; warranties: Warranty[]; followups: Followup[]; recentEmailEvents?: { id: string; category: string; subject?: string | null; message_at?: string | null }[] };

function pill(status?: string | null) {
  const value = String(status || "Unknown").toLowerCase();
  if (value.includes("received") || value.includes("closed") || value.includes("resolved")) return "border-green-400/40 bg-green-950/35 text-green-200";
  if (value.includes("delivered")) return "border-cyan-400/40 bg-cyan-950/35 text-cyan-200";
  if (value.includes("shipped") || value.includes("delivery")) return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  if (value.includes("backorder") || value.includes("awaiting") || value.includes("pending")) return "border-amber-400/40 bg-amber-950/35 text-amber-200";
  if (value.includes("cancel") || value.includes("problem")) return "border-red-400/40 bg-red-950/35 text-red-200";
  return "border-slate-600 bg-slate-900 text-slate-200";
}

export default function PurchasingPage() {
  const embedded = useEmbeddedModal();
  const [data, setData] = useState<Operations | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const token = useCallback(async () => {
    const session = await getValidSession();
    return session?.access_token || "";
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await token();
      if (!accessToken) throw new Error("Sign in is required.");
      const response = await fetch("/api/engineering/operations", { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load purchasing activity.");
      setData(body);
    } catch (error) {
      setData(null);
      setMessage(error instanceof Error ? error.message : "Connection failed. Please retry.");
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void (async () => {
    try {
      const allowed = await enforceSessionPreference();
      if (allowed) await load();
      else setLoading(false);
    } catch { setMessage("Unable to verify your session. Please sign in again."); setLoading(false); }
  })(); }, [load]);

  async function scanNow() {
    if (data?.can_edit !== true || loading || scanning || updating) return;
    setScanning(true); setMessage("");
    try {
      const accessToken = await token();
      const response = await fetch("/api/integrations/email/scan", { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
      const body = await response.json();
      if (!response.ok || body.complete === false) {
        const details = body.errors?.join(" ") || body.error || "The mailbox scan limit was reached. Some messages remain unprocessed.";
        setMessage(`Scan incomplete: ${body.saved || 0} messages imported. ${details}`);
      } else setMessage(`${body.provider === "microsoft365" ? "Microsoft 365" : "Gmail"} scan complete: ${body.saved} new messages, ${body.duplicates} already imported.`);
      await load();
    } catch { setMessage("Email scan connection failed. Please retry."); }
    finally { setScanning(false); }
  }

  async function updateStatus(kind: "purchase" | "shipment", id: string, status: string) {
    if (data?.can_edit !== true || loading || scanning || updating) return;
    setUpdating(id); setMessage("");
    try {
      const accessToken = await token();
      const response = await fetch("/api/engineering/operations", {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ kind, id, status }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Status update failed.");
      setMessage(`${kind === "shipment" ? "Shipment" : "Purchase"} marked ${status}.`);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection failed. Please retry."); }
    finally { setUpdating(null); }
  }

  const waiting = (data?.purchases || []).filter((p) => !["received", "installed / used", "cancelled", "canceled", "complete"].includes(String(p.status || "").toLowerCase()));

  return <main className="min-h-screen bg-slate-950 text-white"><div className="mx-auto w-full px-3 py-4 sm:px-4">
    {!embedded && <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">CMPRI v1.0</p><h1 className="mt-1 text-3xl font-bold">Purchasing & External Activity</h1><p className="mt-2 text-sm text-slate-400">iBuy orders, split shipments, supplier follow-ups, warranty/RMA activity, and Enseo tickets.</p></div><div className="flex flex-wrap gap-2"><button onClick={() => void scanNow()} disabled={data?.can_edit !== true || loading || scanning || !!updating} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-60">{scanning ? "Scanning…" : "Scan Email Now"}</button><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink></div></header>}
    {embedded && <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink><button onClick={() => void scanNow()} disabled={data?.can_edit !== true || loading || scanning || !!updating} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-60">{scanning ? "Scanning…" : "Scan Email Now"}</button></div>}
    {message && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">{message}</div>}
    {!loading && data?.configured === false && <div className="mt-4 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3 text-sm text-red-200">The v1.0 integration tables or Microsoft 365 / Gmail connection are not configured on this deployment yet. The application is built to use them as soon as the deployment settings are present.</div>}

    <section className="mt-5 grid gap-3 sm:grid-cols-4"><div className="rounded-xl border border-amber-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Waiting on Material</p><p className="mt-1 text-3xl font-bold">{loading ? "—" : waiting.length}</p></div><div className="rounded-xl border border-blue-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Active Enseo Tickets</p><p className="mt-1 text-3xl font-bold">{loading ? "—" : (data?.enseo || []).filter(x => !/closed|resolved/i.test(x.status || "")).length}</p></div><div className="rounded-xl border border-purple-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Warranty / RMA</p><p className="mt-1 text-3xl font-bold">{loading ? "—" : (data?.warranties || []).filter(x => !/closed|resolved/i.test(x.status || "")).length}</p></div><div className="rounded-xl border border-orange-500/30 bg-slate-900 p-4"><p className="text-sm text-slate-400">Vendor Follow-ups</p><p className="mt-1 text-3xl font-bold">{loading ? "—" : (data?.followups || []).filter(x => /awaiting|pending|contacted/i.test(x.status || "")).length}</p></div></section>

    <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-5 py-4"><h2 className="text-2xl font-bold">Orders & Shipments</h2><p className="text-sm text-slate-400">Purchase status remains separate from work-order status. Confirm all ordered items are present before marking the whole order Received.</p></div><div className="divide-y divide-slate-800">{!(data?.purchases || []).length && <p className="p-5 text-sm text-slate-500">No imported purchase activity yet.</p>}{(data?.purchases || []).map((purchase) => <div key={purchase.id} className="px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-lg font-bold">{purchase.vendor || "Supplier"} · {purchase.order_number ? `PO ${purchase.order_number}` : "Order"}</div>{purchase.work_order_id && <ModalNavigationButton href={`/work-orders/${encodeURIComponent(purchase.work_order_id)}`} className="text-xs text-amber-300 hover:underline">Linked work order</ModalNavigationButton>}</div><div className="flex flex-wrap items-center justify-end gap-2"><span className={`rounded-full border px-3 py-1 text-xs font-bold ${pill(purchase.status)}`}>{purchase.status || "Ordered"}</span>{!/^(Received|Installed \/ Used|Complete|Cancelled)$/i.test(purchase.status || "") && <button type="button" disabled={data?.can_edit !== true || loading || scanning || !!updating} onClick={() => void updateStatus("purchase", purchase.id, "Received")} className="rounded-lg border border-green-500/40 px-2.5 py-1 text-xs font-semibold text-green-200 disabled:opacity-50">Mark Received</button>}{/^Received$/i.test(purchase.status || "") && <button type="button" disabled={data?.can_edit !== true || loading || scanning || !!updating} onClick={() => void updateStatus("purchase", purchase.id, "Installed / Used")} className="rounded-lg border border-cyan-500/40 px-2.5 py-1 text-xs font-semibold text-cyan-200 disabled:opacity-50">Mark Installed / Used</button>}{/Installed/i.test(purchase.status || "") && <button type="button" disabled={data?.can_edit !== true || loading || scanning || !!updating} onClick={() => void updateStatus("purchase", purchase.id, "Complete")} className="rounded-lg border border-blue-500/40 px-2.5 py-1 text-xs font-semibold text-blue-200 disabled:opacity-50">Complete</button>}</div></div>{purchase.eta && <p className="mt-2 text-sm text-slate-300">ETA: {purchase.eta}</p>}<div className="mt-3 grid gap-2 lg:grid-cols-2">{(purchase.cmpri_purchase_shipments || []).map((shipment, index) => <div key={shipment.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3"><div className="flex items-center justify-between gap-2"><b>Shipment {index + 1}{purchase.cmpri_purchase_shipments && purchase.cmpri_purchase_shipments.length > 1 ? ` of ${purchase.cmpri_purchase_shipments.length}` : ""}</b><span className={`rounded-full border px-2 py-0.5 text-[11px] ${pill(shipment.status)}`}>{shipment.status || "Shipped"}</span></div><p className="mt-1 text-xs text-slate-400">From: {shipment.ship_from || "Origin not listed"}</p><p className="mt-1 break-all text-xs text-slate-400">Tracking: {shipment.tracking_number || "Not provided"}</p>{shipment.eta && <p className="mt-1 text-xs text-slate-400">ETA: {shipment.eta}</p>}{!/received/i.test(shipment.status || "") && <div className="mt-2 flex flex-wrap gap-2">{!/delivered/i.test(shipment.status || "") && <button type="button" disabled={data?.can_edit !== true || loading || scanning || !!updating} onClick={() => void updateStatus("shipment", shipment.id, "Delivered")} className="rounded border border-cyan-500/40 px-2 py-1 text-[11px] font-semibold text-cyan-200 disabled:opacity-50">Mark Delivered</button>}<button type="button" disabled={data?.can_edit !== true || loading || scanning || !!updating} onClick={() => void updateStatus("shipment", shipment.id, "Received")} className="rounded border border-green-500/40 px-2 py-1 text-[11px] font-semibold text-green-200 disabled:opacity-50">Mark Received</button></div>}</div>)}</div></div>)}</div></section>

    <div className="mt-5 grid gap-5 lg:grid-cols-3"><section className="rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-4 py-3"><h2 className="text-xl font-bold">Enseo</h2></div><div className="divide-y divide-slate-800">{(data?.enseo || []).slice(0,20).map(item => <div key={item.id} className="p-4"><div className="flex justify-between gap-2"><b>{item.ticket_number ? `Ticket ${item.ticket_number}` : "Enseo ticket"}</b><span className={`rounded-full border px-2 py-0.5 text-[11px] ${pill(item.status)}`}>{item.status || "Updated"}</span></div><p className="mt-1 text-sm text-slate-400">Room {item.room_number || "—"}{item.enseo_endpoint ? ` · ${item.enseo_endpoint}` : ""}</p>{item.work_order_id && <ModalNavigationButton href={`/work-orders/${encodeURIComponent(item.work_order_id)}`} className="text-xs text-amber-300">Open linked work order</ModalNavigationButton>}</div>)}</div></section>
    <section className="rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-4 py-3"><h2 className="text-xl font-bold">Warranty / RMA</h2></div><div className="divide-y divide-slate-800">{(data?.warranties || []).slice(0,20).map(item => <div key={item.id} className="p-4"><b>{item.rma_number ? `RMA ${item.rma_number}` : item.warranty_case_number ? `Case ${item.warranty_case_number}` : "Warranty case"}</b><p className="mt-1 text-sm text-slate-400">{item.vendor || "Vendor"} · {item.status || "Open"}</p>{item.ship_from && <p className="mt-1 text-xs text-slate-500">From: {item.ship_from}</p>}{item.eta && <p className="mt-1 text-xs text-slate-500">ETA: {item.eta}</p>}{(item.tracking_numbers || []).map((tracking) => <p key={tracking} className="mt-1 break-all text-xs text-slate-500">Tracking: {tracking}</p>)}{item.work_order_id && <ModalNavigationButton href={`/work-orders/${encodeURIComponent(item.work_order_id)}`} className="text-xs text-amber-300">Open linked work order</ModalNavigationButton>}</div>)}</div></section>
    <section className="rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-4 py-3"><h2 className="text-xl font-bold">Supplier Follow-up</h2></div><div className="divide-y divide-slate-800">{(data?.followups || []).slice(0,20).map(item => <div key={item.id} className="p-4"><b>{item.topic || "Supplier follow-up"}</b><p className="mt-1 text-sm text-amber-200">{item.status || "Awaiting response"}</p>{item.work_order_id && <ModalNavigationButton href={`/work-orders/${encodeURIComponent(item.work_order_id)}`} className="text-xs text-amber-300">Open linked work order</ModalNavigationButton>}</div>)}</div></section></div>
  </div></main>;
}
