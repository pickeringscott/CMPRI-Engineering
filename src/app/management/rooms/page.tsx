"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getValidSession } from "@/lib/supabase/client";

interface Location {
  id: string;
  area: string | null;
  name: string | null;
  room_number: string | null;
  location_type: string | null;
  active: boolean;
}
interface WorkOrder {
  id: string;
  location_id: string | null;
  room: string | null;
  issue: string | null;
  status: string | null;
  created_at: string | null;
}

export default function RoomsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Location | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const session = await getValidSession();
    if (!session) { window.location.replace("/"); return; }
    const response = await fetch("/api/rooms", {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    const result = await response.json() as { error?: string; locations?: Location[]; work_orders?: WorkOrder[]; can_edit?: boolean };
    if (!response.ok) { setMessage(result.error || "Rooms could not be loaded."); return; }
    const list = result.locations || [];
    setLocations(list);
    setOrders(result.work_orders || []);
    setCanEdit(result.can_edit === true);
    setSelectedId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id || "");
    const selected = list.find((item) => item.id === (selectedId || list[0]?.id)) || list[0] || null;
    setDraft(selected ? { ...selected } : null);
  }, [selectedId]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const roomOrders = useMemo(() => {
    if (!draft) return [];
    return orders.filter((order) => order.location_id === draft.id || (!order.location_id && draft.room_number && order.room?.match(/\b\d{2,4}\b/)?.[0] === draft.room_number));
  }, [draft, orders]);

  function select(location: Location) {
    setSelectedId(location.id);
    setDraft({ ...location });
    setMessage("");
  }

  async function save() {
    if (!draft || !canEdit || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Your session has ended. Sign in again.");
      const response = await fetch("/api/rooms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id: draft.id, area: draft.area, name: draft.name, room_number: draft.room_number, location_type: draft.location_type }),
      });
      const result = await response.json() as { error?: string; location?: Location };
      if (!response.ok || !result.location) throw new Error(result.error || "Room/location could not be saved.");
      setLocations((items) => items.map((item) => item.id === result.location!.id ? result.location! : item));
      setDraft({ ...result.location });
      setMessage("Room/location saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Room/location could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">CMPRI Engineering</p>
            <h1 className="mt-1 text-2xl font-bold">Rooms & Locations</h1>
            <p className="mt-1 text-sm text-slate-400">Review room/location records and their linked work orders.</p>
          </div>
          <Link href="/engineering" className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold">← Dashboard</Link>
        </header>
        {message ? <div role="status" className="mt-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm">{message}</div> : null}
        <div className="mt-4 grid gap-3 lg:grid-cols-[245px_minmax(0,1fr)]">
          <section className="max-h-[76vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900">
            {locations.map((location) => (
              <button key={location.id} type="button" onClick={() => select(location)} className={`block w-full border-b border-slate-800 px-3 py-2.5 text-left ${selectedId === location.id ? "bg-indigo-950/45" : "hover:bg-slate-800"}`}>
                <div className="font-bold">{location.room_number ? `Room ${location.room_number}` : location.name || "Location"}</div>
                <div className="text-xs text-slate-400">{location.location_type || "Unclassified"}{location.area ? ` · ${location.area}` : ""}</div>
              </button>
            ))}
          </section>
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            {draft ? <>
              <h2 className="text-xl font-bold">{draft.room_number ? `Room ${draft.room_number}` : draft.name || "Location"}</h2>
              <fieldset disabled={!canEdit || busy} className="mt-4 grid gap-3 sm:grid-cols-2 disabled:opacity-70">
                <label className="grid gap-1 text-sm text-slate-300">Room number<input value={draft.room_number || ""} onChange={(e) => setDraft({ ...draft, room_number: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
                <label className="grid gap-1 text-sm text-slate-300">Room / location type<input value={draft.location_type || ""} onChange={(e) => setDraft({ ...draft, location_type: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
                <label className="grid gap-1 text-sm text-slate-300">Name<input value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
                <label className="grid gap-1 text-sm text-slate-300">Area<input value={draft.area || ""} onChange={(e) => setDraft({ ...draft, area: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
              </fieldset>
              {canEdit ? <div className="mt-3 flex justify-end"><button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold disabled:opacity-60">{busy ? "Saving…" : "Save Room / Location"}</button></div> : <p className="mt-3 text-xs text-slate-500">View-only access.</p>}
              <div className="mt-5 border-t border-slate-800 pt-4">
                <h3 className="font-bold">Tickets for this room/location</h3>
                <div className="mt-3 space-y-2">
                  {roomOrders.length ? roomOrders.map((order) => <Link key={order.id} href={`/work-orders/${order.id}`} className="block rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 hover:border-indigo-500"><div className="font-semibold">{order.issue || "No issue description"}</div><div className="mt-1 text-xs text-slate-500">{order.status || "Open"}</div></Link>) : <p className="text-sm text-slate-500">No tickets are tied to this location.</p>}
                </div>
              </div>
            </> : <p className="text-sm text-slate-500">No active locations are available.</p>}
          </section>
        </div>
      </div>
    </main>
  );
}
