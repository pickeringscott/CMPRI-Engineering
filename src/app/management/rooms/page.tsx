"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { hasCapability, loadCmpriSession } from "@/lib/auth/client-session";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";

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
interface PmPlan {
  id: string;
  location_id: string | null;
  asset_id: string | null;
  title: string;
  description: string | null;
  checklist: unknown;
  frequency_value: number;
  frequency_unit: string;
  last_completed_on: string | null;
  next_due_on: string | null;
  active: boolean;
}
interface PmCompletion {
  id: string;
  pm_plan_id: string;
  completed_on: string;
  completed_by_name: string | null;
  notes: string | null;
  created_at: string | null;
}

function localDate(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString();
}

function dueState(nextDueOn: string | null) {
  if (!nextDueOn) return { label: "Due date not set", className: "border-slate-700 bg-slate-950 text-slate-400" };
  const due = new Date(`${nextDueOn}T23:59:59`);
  const now = new Date();
  if (due.getTime() < now.getTime()) return { label: `Overdue · ${localDate(nextDueOn)}`, className: "border-red-500/40 bg-red-950/30 text-red-200" };
  const days = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
  if (days <= 30) return { label: `Due ${localDate(nextDueOn)}`, className: "border-amber-500/40 bg-amber-950/30 text-amber-200" };
  return { label: `Due ${localDate(nextDueOn)}`, className: "border-emerald-500/30 bg-emerald-950/20 text-emerald-200" };
}

export default function RoomsPage() {
  const embedded = useEmbeddedModal();
  const [locations, setLocations] = useState<Location[]>([]);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [pmPlans, setPmPlans] = useState<PmPlan[]>([]);
  const [pmCompletions, setPmCompletions] = useState<PmCompletion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Location | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canManageCorporatePm, setCanManageCorporatePm] = useState(false);
  const [pageAllowed, setPageAllowed] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const session = await getValidSession();
    if (!session) { window.location.replace("/"); return; }
    const response = await fetch("/api/rooms", {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    const result = await response.json() as {
      error?: string;
      locations?: Location[];
      work_orders?: WorkOrder[];
      pm_plans?: PmPlan[];
      pm_completions?: PmCompletion[];
      can_edit?: boolean;
      can_manage_corporate_pm?: boolean;
    };
    if (!response.ok) { setMessage(result.error || "Rooms could not be loaded."); return; }
    const list = result.locations || [];
    setLocations(list);
    setOrders(result.work_orders || []);
    setPmPlans(result.pm_plans || []);
    setPmCompletions(result.pm_completions || []);
    setCanEdit(result.can_edit === true);
    setCanManageCorporatePm(result.can_manage_corporate_pm === true);
    setSelectedId((current) => {
      const nextId = current && list.some((item) => item.id === current) ? current : list[0]?.id || "";
      const selected = list.find((item) => item.id === nextId) || null;
      setDraft(selected ? { ...selected } : null);
      return nextId;
    });
  }, []);

  useEffect(() => {
    let active = true;
    void loadCmpriSession().then((session) => {
      if (!active) return;
      if (!hasCapability(session, "view_engineering_operations")) {
        window.location.replace(session.landing);
        return;
      }
      setPageAllowed(true);
      void load();
    }).catch(() => {
      if (active) window.location.replace("/");
    });
    return () => { active = false; };
  }, [load]);

  const roomOrders = useMemo(() => {
    if (!draft) return [];
    return orders.filter((order) => order.location_id === draft.id || (!order.location_id && draft.room_number && order.room?.match(/\b\d{2,4}\b/)?.[0] === draft.room_number));
  }, [draft, orders]);

  const locationPmPlans = useMemo(() => {
    if (!draft) return [];
    return pmPlans.filter((plan) => plan.location_id === draft.id);
  }, [draft, pmPlans]);

  const locationPmCompletions = useMemo(() => {
    const planIds = new Set(locationPmPlans.map((plan) => plan.id));
    return pmCompletions.filter((completion) => planIds.has(completion.pm_plan_id));
  }, [locationPmPlans, pmCompletions]);

  const overdueCount = useMemo(() => {
    const now = new Date();
    return locationPmPlans.filter((plan) => plan.next_due_on && new Date(`${plan.next_due_on}T23:59:59`).getTime() < now.getTime()).length;
  }, [locationPmPlans]);

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

  if (!pageAllowed) return null;
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-3 py-4 sm:px-4">
        {!embedded && <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">CMPRI Engineering</p>
            <h1 className="mt-1 text-2xl font-bold">Rooms & Locations</h1>
            <p className="mt-1 text-sm text-slate-400">Review room/location records, work orders, and preventive maintenance history.</p>
          </div>
          <ModalDashboardLink className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink>
        </header>}
        {embedded && <div className="mb-4"><ModalDashboardLink className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink></div>}
        {message ? <div role="status" className="mt-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm">{message}</div> : null}
        <div className="mt-4 grid gap-3 lg:grid-cols-[245px_minmax(0,1fr)]">
          <section className="max-h-[76vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900">
            {locations.map((location) => {
              const plans = pmPlans.filter((plan) => plan.location_id === location.id);
              const overdue = plans.some((plan) => plan.next_due_on && new Date(`${plan.next_due_on}T23:59:59`).getTime() < Date.now());
              return (
                <button key={location.id} type="button" onClick={() => select(location)} className={`block w-full border-b border-slate-800 px-3 py-2.5 text-left ${selectedId === location.id ? "bg-indigo-950/45" : "hover:bg-slate-800"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold">{location.room_number ? `Room ${location.room_number}` : location.name || "Location"}</div>
                    {plans.length ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${overdue ? "bg-red-950 text-red-200" : "bg-emerald-950 text-emerald-200"}`}>{overdue ? "PM due" : "PM"}</span> : null}
                  </div>
                  <div className="text-xs text-slate-400">{location.location_type || "Unclassified"}{location.area ? ` · ${location.area}` : ""}</div>
                </button>
              );
            })}
          </section>
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            {draft ? <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">{draft.room_number ? `Room ${draft.room_number}` : draft.name || "Location"}</h2>
                  {locationPmPlans.length ? <p className="mt-1 text-xs text-slate-400">{locationPmPlans.length} active PM plan{locationPmPlans.length === 1 ? "" : "s"} · {overdueCount} overdue</p> : null}
                </div>
                {draft.room_number && locationPmPlans.length ? <span className="rounded-full border border-indigo-500/30 bg-indigo-950/30 px-3 py-1 text-xs font-bold text-indigo-200">PM linked to this room</span> : null}
              </div>

              <fieldset disabled={!canEdit || busy} className="mt-4 grid gap-3 sm:grid-cols-2 disabled:opacity-70">
                <label className="grid gap-1 text-sm text-slate-300">Room number<input value={draft.room_number || ""} onChange={(e) => setDraft({ ...draft, room_number: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
                <label className="grid gap-1 text-sm text-slate-300">Room / location type<input value={draft.location_type || ""} onChange={(e) => setDraft({ ...draft, location_type: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
                <label className="grid gap-1 text-sm text-slate-300">Name<input value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
                <label className="grid gap-1 text-sm text-slate-300">Area<input value={draft.area || ""} onChange={(e) => setDraft({ ...draft, area: e.target.value })} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
              </fieldset>
              {canEdit ? <div className="mt-3 flex justify-end"><button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold disabled:opacity-60">{busy ? "Saving…" : "Save Room / Location"}</button></div> : <p className="mt-3 text-xs text-slate-500">View-only access.</p>}

              <div className="mt-5 border-t border-slate-800 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold">Preventive maintenance</h3>
                  {canManageCorporatePm && <ModalNavigationButton href="/engineering/preventive-maintenance" className="text-xs font-semibold text-indigo-300 hover:text-indigo-200">Open corporate PM tracker →</ModalNavigationButton>}
                </div>
                <div className="mt-3 space-y-3">
                  {locationPmPlans.length ? locationPmPlans.map((plan) => {
                    const due = dueState(plan.next_due_on);
                    const history = locationPmCompletions.filter((completion) => completion.pm_plan_id === plan.id).slice(0, 4);
                    return <div key={plan.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold">{plan.title}</div>
                          <div className="mt-1 text-xs text-slate-500">Every {plan.frequency_value} {plan.frequency_unit.toLowerCase()} · Last completed {localDate(plan.last_completed_on)}</div>
                        </div>
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${due.className}`}>{due.label}</span>
                      </div>
                      {plan.description ? <p className="mt-2 text-xs leading-5 text-slate-400">{plan.description}</p> : null}
                      {history.length ? <div className="mt-3 border-t border-slate-800 pt-2">
                        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Recent PM history</div>
                        <div className="mt-2 grid gap-1 sm:grid-cols-2">
                          {history.map((completion) => <div key={completion.id} className="text-xs text-slate-300">✓ {localDate(completion.completed_on)} <span className="text-slate-600">·</span> {completion.completed_by_name || "Technician not recorded"}</div>)}
                        </div>
                      </div> : <p className="mt-3 text-xs text-slate-500">No completion history recorded yet.</p>}
                    </div>;
                  }) : <p className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm text-slate-500">No PM plan is linked to this location yet.</p>}
                </div>
              </div>

              <div className="mt-5 border-t border-slate-800 pt-4">
                <h3 className="font-bold">Tickets for this room/location</h3>
                <div className="mt-3 space-y-2">
                  {roomOrders.length ? roomOrders.map((order) => <ModalNavigationButton key={order.id} href={`/work-orders/${encodeURIComponent(order.id)}`} className="block w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-left hover:border-indigo-500"><div className="font-semibold">{order.issue || "No issue description"}</div><div className="mt-1 text-xs text-slate-500">{order.status || "Open"}</div></ModalNavigationButton>) : <p className="text-sm text-slate-500">No tickets are tied to this location.</p>}
                </div>
              </div>
            </> : <p className="text-sm text-slate-500">No active locations are available.</p>}
          </section>
        </div>
      </div>
    </main>
  );
}
