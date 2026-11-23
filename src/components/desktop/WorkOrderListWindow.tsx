"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";


import { formatWorkOrder } from "@/lib/work-order-reference.js";
import { matchesWorkOrderSearch } from "@/lib/work-order-search";
import { DEFAULT_WORK_ORDER_LIST_PREFERENCES, readWorkOrderListPreferences, saveWorkOrderListPreferences } from "@/lib/work-order-list-preferences";

import {sortWorkOrders,type WorkOrderSort} from "@/lib/work-order-sort";
import PartsStatusPill from "@/components/PartsStatusPill";
import type {PartStatus} from "@/lib/work-order-parts";
import WorkOrderImportPill from "@/components/WorkOrderImportPill";
import GuestGroupBadge from "@/components/GuestGroupBadge";
import type { RoomGroupBadge } from "@/lib/room-group-badges";

import WorkOrderFilters, { type WorkOrderListFilter } from "@/components/WorkOrderFilters";
export type { WorkOrderListFilter } from "@/components/WorkOrderFilters";

import LoyaltyBadge from "@/components/LoyaltyBadge";
import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { subscribeResources } from "@/lib/events/browser";
import { filterKpiWorkOrders, normalizeKpiStatus } from "@/lib/dashboard/kpi-filters";
import { roomStatusBadge } from "@/lib/room-availability";
import { normalizePrintedTime } from "@/lib/room-operations-reports";
import { HOTEL_TIME_ZONE } from "@/lib/constants";

export type DesktopWorkOrder = Record<string, unknown> & {
  id: string;
  display_id?: string | null;
  import_source?: string | null;
  import_external_id?: string | null;
  room?: string | null;
  room_status?: string | null;
  checkout_date?: string | null;
  checkout_time?: string | null;
  cn_room?: boolean | null;
  guest_group_badge?: RoomGroupBadge | null;
  incoming_group_badge?: RoomGroupBadge | null;
  loyalty_tier?: string|null;
  guest_name?: string|null;
  incoming_loyalty_tier?: string|null;
  incoming_reserved?: boolean;
  room_next_transition_at?: number|null;
  asset_name?: string | null;
  category?: string | null;
  issue?: string | null;
  priority?: string | null;
  parts_status?: PartStatus | null;
  technician_name?: string | null;
  status?: string | null;
  due_by?: string | null;
  created_at?: string | null;
};

export type DesktopWorkOrderDraft = {
  id: string;
  location_id?: string | null;
  asset_id?: string | null;
  room?: string | null;
  issue?: string | null;
  creator_name?: string | null;
  updated_at?: string | null;
  potential_duplicate?: boolean;
};

export function priorityClass(priority?: string | null) {
  const value = String(priority || "").toLowerCase();
  if (value === "urgent" || value === "high") return "border-red-400/40 bg-red-950/40 text-red-200";
  if (value === "medium") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  return "border-slate-600 bg-slate-800 text-slate-300";
}

export function statusClass(status?: string | null) {
  const value = normalizeKpiStatus(status).toLowerCase();
  if (value === "pending verification" || value === "in review") return "border-purple-400/50 bg-purple-950/45 text-purple-200";
  if (value === "open") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  if (value === "in progress") return "border-orange-400/40 bg-orange-950/35 text-orange-200";
  if (value === "completed") return "border-green-400/40 bg-green-950/35 text-green-200";
  if (value === "will not do") return "border-red-400/40 bg-red-950/35 text-red-200";
  return "border-slate-600 bg-slate-800 text-slate-300";
}

export function isPendingApproval(order: { status?: string | null }) {
  return normalizeKpiStatus(order.status).toLowerCase() === "pending verification";
}

function hotelDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOTEL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function checkoutDays(value: string, today = hotelDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const checkout = new Date(`${value}T00:00:00Z`);
  const current = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(checkout.getTime()) || Number.isNaN(current.getTime())) return null;
  return Math.round((checkout.getTime() - current.getTime()) / 86_400_000);
}

export function checkoutLabel(date?: string | null, time?: string | null, locale = "en-US") {
  if (!date) return null;
  const days = checkoutDays(date);
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  const displayDate = Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const when = time ? ` · ${time}` : "";
  if (days === 0) return { label: `Checkout today${when}`, className: "border-green-400/45 bg-green-950/35 text-green-200" };
  if (days === 1) return { label: `Checkout tomorrow${when}`, className: "border-blue-400/45 bg-blue-950/35 text-blue-200" };
  if (days !== null && days < 0) return { label: `Overdue · ${displayDate}${when}`, className: "border-red-400/45 bg-red-950/35 text-red-200" };
  return { label: `${displayDate}${when}`, className: "border-transparent bg-transparent text-slate-400" };
}

export function listCheckoutLabel(date?: string | null, time?: string | null, roomStatus?: string | null, today = hotelDate(), locale = "en-US") {
  if (!date) return null;
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || parsed.toISOString().slice(0, 10) !== date) return null;
  const displayDate = parsed.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  const normalized = normalizePrintedTime(time || "") || "11:00:00";
  const [hour, minute] = normalized.split(":").map(Number);
  const displayTime = `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "a.m." : "p.m."}`;
  return {
    label: `C/O ${displayDate}${date === today ? ` · ${displayTime}` : ""}`,
    className: roomStatusBadge(roomStatus)?.className || "border-slate-600 bg-slate-900 text-slate-300",
  };
}

export function priorityLabel(priority?: string | null) {
  const value = String(priority || "").trim();
  const normalized = value.toLowerCase();
  if (normalized === "urgent") return "Urgent Priority";
  if (normalized === "high") return "High Priority";
  if (normalized === "medium") return "Medium Priority";
  if (normalized === "low" || normalized === "normal") return "Normal Priority";
  return value;
}

export function groupWorkOrders<T extends DesktopWorkOrder>(orders: T[], drafts: DesktopWorkOrderDraft[] = []): Record<WorkOrderListFilter, Array<T | DesktopWorkOrder>> {
  const status = (order: T) => normalizeKpiStatus(order.status).toLowerCase();
  const draftOrders: DesktopWorkOrder[] = drafts.map((draft) => ({
    id: `draft:${draft.id}`,
    source_draft_id: draft.id,
    is_draft: true,
    potential_duplicate: draft.potential_duplicate === true,
    room: draft.room,
    issue: draft.issue,
    technician_name: draft.creator_name || "Original submitter",
    created_at: draft.updated_at,
    status: "Draft",
  }));
  return {
    pending: [...orders.filter(isPendingApproval), ...draftOrders],
    open: filterKpiWorkOrders(orders, "open"),
    progress: filterKpiWorkOrders(orders, "progress"),
    priority: filterKpiWorkOrders(orders, "priority"),
    overdue: filterKpiWorkOrders(orders, "overdue"),
    completed: orders.filter((order) => status(order) === "completed"),
    closed: orders.filter((order) => ["closed", "duplicate", "will not do"].includes(status(order))),
    all: [...orders, ...draftOrders],
  };
}

const ROW_LIMIT = 200;

export default function WorkOrderListWindow({
  orders,
  drafts = [],
  loading,
  onOpenWorkOrder,
  onOpenDraft,
  preferencesScope,
}: {
  frontDeskLayout?: boolean;
  orders: DesktopWorkOrder[];
  drafts?: DesktopWorkOrderDraft[];
  loading: boolean;
  onOpenWorkOrder: (order: DesktopWorkOrder, opener: HTMLButtonElement) => void;
  onOpenDraft?: (draftId: string, opener: HTMLButtonElement) => void;
  preferencesScope?: string;
}) {
  const { t, locale } = useUiLanguage();
  const [preferences, setPreferences] = useState(DEFAULT_WORK_ORDER_LIST_PREFERENCES);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const { filter, query, sort, page } = preferences;
  const setFilter = (value: WorkOrderListFilter) => setPreferences(previous => ({ ...previous, filter: value }));
  const setQuery = (value: string) => setPreferences(previous => ({ ...previous, query: value.slice(0, 200) }));
  const setSort = (value: WorkOrderSort) => setPreferences(previous => ({ ...previous, sort: value }));
  const setPage = (value: SetStateAction<number>) => setPreferences(previous => ({ ...previous, page: typeof value === "function" ? value(previous.page) : value }));
  const scope = preferencesScope || "";
  const preferencesReady = loadedScope === scope;
  useEffect(() => {
    let active = true;
    // Read device preferences after mounting; do not request or save the default
    // list before the verified account/property's selection has been restored.
    void Promise.resolve().then(() => {
      if (!active) return;
      let restored = { ...DEFAULT_WORK_ORDER_LIST_PREFERENCES };
      try { restored = readWorkOrderListPreferences(window.localStorage, preferencesScope); } catch { /* Device storage can be disabled. */ }
      setPreferences(restored);
      setLoadedScope(scope);
    });
    return () => { active = false; };
  }, [preferencesScope, scope]);
  useEffect(() => {
    if (!preferencesReady) return;
    try { saveWorkOrderListPreferences(window.localStorage, preferencesScope, preferences); } catch { /* Keep the list usable without device storage. */ }
  }, [preferencesReady, preferencesScope, preferences]);
  const [boundaryVersion,setBoundaryVersion]=useState(0);
  const [result, setResult] = useState<{ requestKey: string; orders: DesktopWorkOrder[]; total: number; counts: Record<string, number> } | null>(null);
  const requestKey = JSON.stringify([scope, page, filter, sort, query]);
  const remote = result?.requestKey === requestKey ? result : null;
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!preferencesReady) return;
    let active = true;
    let stop: (() => void) | undefined;
    const controller = new AbortController();
    const load = async () => {
      if (active) setPageLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), filter, sort, q: query });
        const response = await fetch(`/api/work-orders?${params}`, { headers: await authorizationHeaders(), cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Work orders could not be loaded.");
        const lastPage = Math.max(0, Math.ceil(data.total / 100) - 1);
        if (active && Number.isSafeInteger(data.total) && page > lastPage) {
          // A saved page can disappear while CMPRI is closed. Reopen the last
          // remaining page rather than stranding the list behind a hidden pager.
          setPreferences(previous => ({ ...previous, page: lastPage }));
          return;
        }
        if (active) { setResult({ requestKey, orders: data.work_orders, total: data.total, counts: data.counts }); setError(""); }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : "Work orders could not be loaded."); }
      finally { if (active) setPageLoading(false); }
    };
    // Wait for a pause in typing before subscribing and loading the results.
    // The initial subscription refresh catches changes during that short wait.
    const timer = window.setTimeout(() => {
      if (active) stop = subscribeResources(["orders", "rooms"], load);
    }, query ? 300 : 0);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); stop?.(); };
  }, [page, filter, sort, query, boundaryVersion, preferencesReady, requestKey]);
  useEffect(()=>{
    // A single business-boundary wake-up, not recurring network polling. The
    // subscription visibility gate defers hidden-window reads until reopening.
    const boundaries=(remote?.orders||[]).map(order=>order.room_next_transition_at).filter((value):value is number=>typeof value==='number'&&value>Date.now());
    if(!boundaries.length)return;
    const timer=setTimeout(()=>setBoundaryVersion(value=>value+1),Math.min(...boundaries)-Date.now()+50);
    return()=>clearTimeout(timer);
  },[remote]);
  const groups = useMemo(() => groupWorkOrders(remote?.orders || orders, page === 0 ? drafts : []), [remote, orders, drafts, page]);
  const countFor = (key: WorkOrderListFilter) => (remote?.counts[key] ?? groups[key].length) + (remote && ["all", "pending"].includes(key) ? drafts.length : 0);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingRows = groups[filter].filter(order => matchesWorkOrderSearch(order, normalizedQuery));
  const rows = remote ? [...matchingRows.filter(row => row.is_draft), ...remote.orders] : sortWorkOrders(matchingRows,sort);

  return (
    <div data-front-desk-list={undefined} className="cmpri-work-order-list cmpri-desktop-scale flex size-full min-h-0 flex-col gap-[0.3em] overflow-hidden bg-slate-950 p-[0.45em] text-white">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-[0.35em]">

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-start gap-[0.3em] @md:flex-nowrap">
          <label className="flex min-w-0 items-center gap-[0.3em] text-[0.85em] text-slate-300">
            <select aria-label={t("Sort work orders")} data-sort-default={sort==="default"} value={sort} onChange={event=>{setSort(event.target.value as WorkOrderSort);setPage(0);}} className="work-order-sort min-w-0 max-w-full px-[0.6em] py-[0.45em] text-white">
              <option value="default">{t("Sort by…")}</option><option value="tier-high">{t("Bonvoy Tier: high to low")}</option><option value="tier-low">{t("Bonvoy Tier: low to high")}</option><option value="created-newest">{t("Created: newest first")}</option>
              <option value="created-oldest">{t("Created: oldest first")}</option>
              <option value="due-earliest">{t("Due: earliest first")}</option>
              <option value="due-latest">{t("Due: latest first")}</option>
            </select>
          </label>
          <div className="relative min-w-[12em] flex-1 @md:max-w-[32em] @md:ml-auto">
            <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute left-[0.65em] top-1/2 size-[1em] -translate-y-1/2 fill-none stroke-slate-400" strokeWidth="1.7">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => {setQuery(event.target.value); setPage(0);}}
              placeholder={t("Search rooms, locations, or issues...")}
              aria-label={t("Search rooms, locations, or issues")}
              className="w-full rounded-md border border-slate-700 bg-slate-900 py-[0.45em] pl-[2em] pr-[2.2em] text-white outline-none placeholder:text-slate-400 focus:border-sky-400"
            />
            {query && <button type="button" onClick={() => {setQuery(""); setPage(0);}} aria-label={t("Clear work-order search")} className="absolute right-[0.3em] top-1/2 -translate-y-1/2 rounded px-[0.4em] text-slate-400 hover:bg-slate-800 hover:text-white">×</button>}
          </div>
        </div>
      </header>

      <WorkOrderFilters
        filter={filter}
        searching={false}
        loading={loading}
        countFor={countFor}
        onChange={key => { setFilter(key); setPage(0); }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loading && rows.length === 0 && (
          <p className="rounded-md border border-slate-700 bg-slate-900 p-[0.5em] text-slate-300">{normalizedQuery ? t("No work orders match your search.") : t("No work orders match this filter.")}</p>
        )}
        {rows.length > 0 && (
          <div className="flex flex-col gap-[0.2em]">
            {rows.slice(0, ROW_LIMIT).map((order) => {
              const occupancy = roomStatusBadge(order.room_status);
              const checkout = listCheckoutLabel(order.checkout_date, order.checkout_time, order.room_status, undefined, locale);
              const isDraft = order.is_draft === true;
              const sourceDraftId = typeof order.source_draft_id === "string" ? order.source_draft_id : "";
              return (
                <button
                  key={order.id}

                  data-preview-status={order.status}
                  type="button"
                  onClick={event => isDraft && sourceDraftId ? onOpenDraft?.(sourceDraftId, event.currentTarget) : onOpenWorkOrder(order, event.currentTarget)}
                  aria-label={t("{value0} for {value1}: {value2}", { value0: String(t(isDraft ? "Review draft" : "Open work order")), value1: String(order.room || t("No location")), value2: String(order.issue || t("No issue description")) })}
                  className="flex w-full min-w-0 items-center gap-x-[0.5em] rounded-md border border-slate-700 bg-slate-900 px-[0.6em] py-[0.28em] text-left transition-colors hover:border-slate-500 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400"
                >
                  <div className="preview-row-content">
                    <div className="work-order-ticket-line" data-preview-pills>
                      {!isDraft && order.display_id && <span className="preview-wo-number">{formatWorkOrder(order.display_id)}</span>}
                      <span className={`work-order-pill ${statusClass(order.status)}`}>{t(normalizeKpiStatus(order.status))}</span>
                      {!isDraft && order.priority && <span className={`work-order-pill ${priorityClass(order.priority)}`}>{t(priorityLabel(order.priority))}</span>}
                      {!isDraft && <PartsStatusPill status={order.parts_status} />}
                      {!isDraft && <WorkOrderImportPill order={order} />}
                    </div>
                    <div className="work-order-room-line">
                      <span className="preview-room">{order.room || t("No location")}</span>
                      {occupancy && <span data-preview-room-status className={`work-order-pill ${occupancy.className}`}>{t(occupancy.label)}</span>}
                      {checkout && <span data-work-order-checkout className={`work-order-pill ${checkout.className}`}>{checkout.label.replace(/^C\/O /, t("Check-out") + " ")}</span>}
                    </div>
                    {!isDraft && (order.guest_name || order.loyalty_tier || order.guest_group_badge) && <div className="work-order-guest-line">
                      {order.guest_name && <span>{order.guest_name}</span>}
                      <GuestGroupBadge badge={order.guest_group_badge} className="preview-group-badge" />
                      <LoyaltyBadge tier={order.loyalty_tier} />
                    </div>}
                  <span className="block break-words text-[0.92em] leading-tight text-white">{order.issue || t("No issue description")}</span>
                  {isDraft && <span className="block text-[0.78em] font-semibold leading-tight text-amber-200">{t("Draft — awaiting Chief Engineer approval")}{order.potential_duplicate === true ? t(" · Possible duplicate — review") : ""}</span>}
                  <div data-room-occupancy className="preview-incoming">
                    {!isDraft && order.incoming_reserved&&<><GuestGroupBadge badge={order.incoming_group_badge} className="preview-group-badge"/><LoyaltyBadge tier={order.incoming_loyalty_tier}/><span className="reserved-pill">{t("Reserved")}</span></>}
                  </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-red-300">{t(error)}</p>}
      {remote && remote.total > 100 && <nav aria-label={t("Work order pages")} className="flex justify-end gap-2 text-xs"><button disabled={page === 0 || pageLoading} onClick={()=>setPage(p=>p-1)}>{t("Previous")}</button><span>{t("Page ")}{page+1}{t(" of ")}{Math.ceil(remote.total/100)}</span><button disabled={(page+1)*100>=remote.total || pageLoading} onClick={()=>setPage(p=>p+1)}>{t("Next")}</button></nav>}
      <span role="status" className="shrink-0 text-right text-[0.68em] leading-tight text-slate-400">
        {loading ? t("Loading…") : t("{value0} of {value1}", { value0: String(Math.min(rows.length, ROW_LIMIT)), value1: String(remote?.total ?? rows.length) })}
      </span>
    </div>
  );
}
