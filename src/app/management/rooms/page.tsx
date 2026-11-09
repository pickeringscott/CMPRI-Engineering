"use client";

import { useCallback, useEffect, useMemo, useRef, useId, useState, type FormEvent } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { hasCapability, loadCmpriSession } from "@/lib/auth/client-session";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { groupLocations } from "@/lib/location-management";
import { modalTitleStyle } from "@/lib/ui/header-palette";
import "./locations.css";

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

type LocationFields = Pick<Location, "name" | "area" | "room_number" | "location_type">;

function LocationEditor({ location, areas, types, busy, error, onClose, onSave }: {
  location: Location | null; areas: string[]; types: string[]; busy: boolean; error: string;
  onClose: () => void; onSave: (fields: LocationFields) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const typeList = useId();
  const [fields, setFields] = useState<LocationFields>(() => ({ name: location?.name || "", area: location?.area || "", room_number: location?.room_number || "", location_type: location?.location_type || (location ? "" : "General") }));
  useEffect(() => { dialog.current?.showModal(); }, []);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!busy) void onSave(fields); }
  return <dialog ref={dialog} aria-labelledby={title} className="location-editor" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={title}>{location ? "Edit Location" : "Add Location"}</h2><button type="button" aria-label={location ? "Close Edit Location" : "Close Add Location"} disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <label>Name<input autoFocus required maxLength={200} value={fields.name || ""} onChange={event => setFields({ ...fields, name: event.target.value })} /></label>
        <label>Area{location
          ? <select required value={fields.area || ""} onChange={event => setFields({ ...fields, area: event.target.value })}><option value="" disabled>Select an area</option>{areas.map(area => <option key={area} value={area}>{area}</option>)}</select>
          : <input required maxLength={200} value={fields.area || ""} onChange={event => setFields({ ...fields, area: event.target.value })} />}</label>
        <label>Location Type{location
          ? <select required value={fields.location_type || ""} onChange={event => setFields({ ...fields, location_type: event.target.value })}><option value="" disabled>Select a location type</option>{types.map(type => <option key={type} value={type}>{type}</option>)}</select>
          : <><input required maxLength={200} list={typeList} value={fields.location_type || ""} onChange={event => setFields({ ...fields, location_type: event.target.value })} /><datalist id={typeList}>{types.map(type => <option key={type} value={type} />)}</datalist></>}</label>
        <label>Room Number (optional)<input maxLength={20} pattern="[A-Za-z0-9 -]+" value={fields.room_number || ""} onChange={event => setFields({ ...fields, room_number: event.target.value })} /></label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" data-cmpri-primary disabled={busy}>{busy ? "Saving…" : location ? "Save Location" : "Add Location"}</button></footer>
    </form>
  </dialog>;
}

export default function RoomsPage() {
  const embedded = useEmbeddedModal();
  const [locations, setLocations] = useState<Location[]>([]);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [pmPlans, setPmPlans] = useState<PmPlan[]>([]);
  const [pmCompletions, setPmCompletions] = useState<PmCompletion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editor, setEditor] = useState<{ location: Location | null } | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canManageCorporatePm, setCanManageCorporatePm] = useState(false);
  const [pageAllowed, setPageAllowed] = useState(false);
  const [message, setMessage] = useState("");
  const [editorError, setEditorError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const session = await getValidSession();
    if (!session) { window.location.replace("/"); return; }
    const response = await fetch("/api/rooms", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) { setMessage(result.error || "Locations could not be loaded."); return; }
    setLocations(result.locations || []); setOrders(result.work_orders || []);
    setPmPlans(result.pm_plans || []); setPmCompletions(result.pm_completions || []);
    setCanEdit(result.can_edit === true); setCanManageCorporatePm(result.can_manage_corporate_pm === true);
  }, []);
  useEffect(() => {
    let active = true;
    void loadCmpriSession().then(session => {
      if (!active) return;
      if (!hasCapability(session, "view_engineering_operations")) { window.location.replace(session.landing); return; }
      setPageAllowed(true); void load();
    }).catch(() => { if (active) window.location.replace("/"); });
    return () => { active = false; };
  }, [load]);
  const groups = useMemo(() => groupLocations(locations), [locations]);
  const areas = useMemo(() => [...new Set(locations.map(location => location.area).filter((area): area is string => !!area?.trim()))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [locations]);
  const types = useMemo(() => [...new Set(locations.map(location => location.location_type).filter((type): type is string => !!type?.trim()))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [locations]);
  const workOrderCounts = useMemo(() => {
    const byLocation = new Map<string, number>();
    const byRoom = new Map<string, number>();
    for (const order of orders) {
      if (order.location_id) byLocation.set(order.location_id, (byLocation.get(order.location_id) || 0) + 1);
      else {
        const room = order.room?.match(/\b\d{2,4}\b/)?.[0];
        if (room) byRoom.set(room, (byRoom.get(room) || 0) + 1);
      }
    }
    return { byLocation, byRoom };
  }, [orders]);
  const draft = locations.find(location => location.id === selectedId) || null;
  const roomOrders = useMemo(() => !draft ? [] : orders.filter(order => order.location_id === draft.id || (!order.location_id && draft.room_number && order.room?.match(/\b\d{2,4}\b/)?.[0] === draft.room_number)), [draft, orders]);
  const locationPmPlans = useMemo(() => pmPlans.filter(plan => plan.location_id === selectedId), [pmPlans, selectedId]);
  const locationPmCompletions = useMemo(() => { const ids = new Set(locationPmPlans.map(plan => plan.id)); return pmCompletions.filter(completion => ids.has(completion.pm_plan_id)); }, [locationPmPlans, pmCompletions]);
  function openEditor(location: Location | null) { setEditorError(""); setEditor({ location }); }
  async function save(fields: LocationFields) {
    if (!editor || !canEdit || busy) return;
    setBusy(true); setEditorError("");
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Your session has ended. Sign in again.");
      const response = await fetch("/api/rooms", {
        method: editor.location ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ ...(editor.location ? { id: editor.location.id } : {}), ...fields }),
      });
      const result = await response.json() as { error?: string; location?: Location };
      if (!response.ok || !result.location) throw new Error(result.error || "Location could not be saved.");
      const saved = result.location;
      setLocations(items => editor.location ? items.map(item => item.id === saved.id ? saved : item) : [...items, saved]);
      setSelectedId(saved.id); setEditor(null); setMessage(editor.location ? "Location saved." : "Location added.");
    } catch (error) { setEditorError(error instanceof Error ? error.message : "Location could not be saved."); }
    finally { setBusy(false); }
  }
  if (!pageAllowed) return null;
  return <main data-cmpri-action-surface className="manage-locations min-h-screen bg-slate-950 text-white">
    <div className="mx-auto w-full px-3 py-3 sm:px-4">
      {!embedded && <header className="mb-3 flex items-center justify-between"><h1 className="text-xl font-bold">Manage Locations</h1><ModalDashboardLink /></header>}
      {message && <p role="status" className="mb-3 text-sm">{message}</p>}
      <div className="location-groups">
        {groups.map((group, index) => <section key={group.type} aria-labelledby={`location-type-${index}`} className="location-group">
          <h2 id={`location-type-${index}`}>{group.type}<span>{group.locations.length}</span></h2>
          {group.locations.map(location => {
            const open = selectedId === location.id;
            const plans = pmPlans.filter(plan => plan.location_id === location.id);
            const ticketCount = (workOrderCounts.byLocation.get(location.id) || 0) + (location.room_number ? workOrderCounts.byRoom.get(location.room_number) || 0 : 0);
            const activePlans = plans.filter(plan => plan.active);
            const nextDue = activePlans.map(plan => plan.next_due_on).filter((date): date is string => !!date).sort()[0];
            const pmLabel = !activePlans.length ? "PM: Not scheduled" : !nextDue ? "PM: Due date not set" : dueState(nextDue).label.startsWith("Overdue") ? "PM: Overdue" : "PM: Scheduled";
            return <article key={location.id} className="location-row">
              <button type="button" className="location-toggle" aria-expanded={open} aria-controls={`location-details-${location.id}`} onClick={() => setSelectedId(current => current === location.id ? "" : location.id)}>
                <span><span aria-hidden="true">{open ? "▾" : "▸"}</span> {location.room_number ? `Room ${location.room_number}` : location.name || "Location"}<small>{location.area}{location.room_number && location.name && location.name !== `Room ${location.room_number}` ? ` · ${location.name}` : ""}</small></span>
                <span className="location-indicators">
                  <span className="location-work-order-count">{ticketCount} Work Order{ticketCount === 1 ? "" : "s"}</span>
                  <span className="location-pm-status" style={modalTitleStyle("Preventive Maintenance")} title={nextDue ? `Next due ${localDate(nextDue)}` : pmLabel}>{pmLabel}</span>
                </span>
              </button>
              {open && draft && <div id={`location-details-${location.id}`} className="location-details" role="region" aria-label={`${location.room_number ? `Room ${location.room_number}` : location.name} details`}>
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold">Preventive maintenance</h3>
                  <div className="location-actions">
                    {canEdit && <button type="button" onClick={() => openEditor(location)} className="location-action">Edit Location</button>}
                    {canManageCorporatePm && <ModalNavigationButton href="/engineering/preventive-maintenance" className="location-action">Open PM Tracker →</ModalNavigationButton>}
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  {locationPmPlans.length ? locationPmPlans.map((plan) => {
                    const due = dueState(plan.next_due_on);
                    const history = locationPmCompletions.filter((completion) => completion.pm_plan_id === plan.id).slice(0, 4);
                    return <div key={plan.id} className="location-panel rounded-xl border p-3">
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
                  }) : <p className="location-panel rounded-xl border p-3 text-sm text-slate-500">No PM plan is linked to this location yet.</p>}
                </div>
              </div>

              <div className="mt-5 border-t border-slate-800 pt-4">
                <h3 className="font-bold">Tickets for this room/location</h3>
                <div className="mt-3 space-y-2">
                  {roomOrders.length ? roomOrders.map((order) => <ModalNavigationButton key={order.id} href={`/work-orders/${encodeURIComponent(order.id)}`} className="location-panel location-ticket block w-full rounded-xl border px-3 py-2 text-left"><div className="font-semibold">{order.issue || "No issue description"}</div><div className="mt-1 text-xs text-slate-500">{order.status || "Open"}</div></ModalNavigationButton>) : <p className="text-sm text-slate-500">No tickets are tied to this location.</p>}
                </div>
              </div>
              </div>}
            </article>;
          })}
        </section>)}
        {!locations.length && <p className="text-sm text-slate-400">No active locations are available.</p>}
      </div>
      {canEdit && <footer className="location-add"><button type="button" data-cmpri-primary onClick={() => openEditor(null)}>Add Location</button></footer>}
    </div>
    {editor && <LocationEditor location={editor.location} areas={areas} types={editor.location ? types : [...new Set(["General", ...types])]} busy={busy} error={editorError} onClose={() => { if (!busy) setEditor(null); }} onSave={save} />}
  </main>;
}
