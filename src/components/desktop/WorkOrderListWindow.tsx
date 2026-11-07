"use client";

import { formatWorkOrder, workOrderReferenceMatches } from "@/lib/work-order-reference.js";

import {sortWorkOrders,type WorkOrderSort} from "@/lib/work-order-sort";
import WorkOrderImportPill from "@/components/WorkOrderImportPill";
import GuestGroupBadge from "@/components/GuestGroupBadge";
import type { RoomGroupBadge } from "@/lib/room-group-badges";

import WorkOrderFilters, { type WorkOrderListFilter } from "@/components/WorkOrderFilters";
export type { WorkOrderListFilter } from "@/components/WorkOrderFilters";

import LoyaltyBadge from "@/components/LoyaltyBadge";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
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
  incoming_loyalty_tier?: string|null;
  incoming_reserved?: boolean;
  room_next_transition_at?: number|null;
  asset_name?: string | null;
  category?: string | null;
  issue?: string | null;
  priority?: string | null;
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

export function checkoutLabel(date?: string | null, time?: string | null) {
  if (!date) return null;
  const days = checkoutDays(date);
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  const displayDate = Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const when = time ? ` · ${time}` : "";
  if (days === 0) return { label: `Checkout today${when}`, className: "border-green-400/45 bg-green-950/35 text-green-200" };
  if (days === 1) return { label: `Checkout tomorrow${when}`, className: "border-blue-400/45 bg-blue-950/35 text-blue-200" };
  if (days !== null && days < 0) return { label: `Overdue · ${displayDate}${when}`, className: "border-red-400/45 bg-red-950/35 text-red-200" };
  return { label: `${displayDate}${when}`, className: "border-transparent bg-transparent text-slate-400" };
}

export function listCheckoutLabel(date?: string | null, time?: string | null, roomStatus?: string | null, today = hotelDate()) {
  if (!date) return null;
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || parsed.toISOString().slice(0, 10) !== date) return null;
  const displayDate = parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
}: {
  frontDeskLayout?: boolean;
  orders: DesktopWorkOrder[];
  drafts?: DesktopWorkOrderDraft[];
  loading: boolean;
  onOpenWorkOrder: (order: DesktopWorkOrder) => void;
  onOpenDraft?: (draftId: string) => void;
}) {
  const [filter, setFilter] = useState<WorkOrderListFilter>("all");
  const [query, setQuery] = useState("");
  const [sort,setSort] = useState<WorkOrderSort>("default");
  const [page, setPage] = useState(0);
  const [boundaryVersion,setBoundaryVersion]=useState(0);
  const [remote, setRemote] = useState<{ orders: DesktopWorkOrder[]; total: number; counts: Record<string, number> } | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const stop = subscribeResources(["orders", "rooms"], async () => {
      if (active) setPageLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), filter, sort, q: query });
        const response = await fetch(`/api/work-orders?${params}`, { headers: await authorizationHeaders(), cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Work orders could not be loaded.");
        if (active) { setRemote({ orders: data.work_orders, total: data.total, counts: data.counts }); setError(""); }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : "Work orders could not be loaded."); }
      finally { if (active) setPageLoading(false); }
    });
    return () => { active = false; stop(); };
  }, [page, filter, sort, query,boundaryVersion]);
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
  const matchingRows = normalizedQuery
    ? groups.all.filter((order) => (workOrderReferenceMatches(order.display_id, normalizedQuery) || [...Object.values(order), formatWorkOrder(order.display_id)].some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery))))
    : groups[filter];
  const rows = remote ? [...matchingRows.filter(row => row.is_draft), ...remote.orders] : sortWorkOrders(matchingRows,sort);

  return (
    <div data-front-desk-list={undefined} className="cmpri-work-order-list cmpri-desktop-scale flex size-full min-h-0 flex-col gap-[0.3em] overflow-hidden bg-slate-950 p-[0.45em] text-white">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-[0.35em]">

        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-start gap-[0.3em] @md:flex-nowrap">
          <label className="flex min-w-0 items-center gap-[0.3em] text-[0.85em] text-slate-300">
            <select aria-label="Sort work orders" data-sort-default={sort==="default"} value={sort} onChange={event=>{setSort(event.target.value as WorkOrderSort);setPage(0);}} className="work-order-sort min-w-0 max-w-full px-[0.6em] py-[0.45em] text-white">
              <option value="default">Sort by…</option><option value="tier-high">Bonvoy Tier: high to low</option><option value="tier-low">Bonvoy Tier: low to high</option><option value="created-newest">Created: newest first</option>
              <option value="created-oldest">Created: oldest first</option>
              <option value="due-earliest">Due: earliest first</option>
              <option value="due-latest">Due: latest first</option>
            </select>
          </label>
          <div className="relative min-w-[12em] flex-1 @md:max-w-[32em] @md:ml-auto">
            <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute left-[0.65em] top-1/2 size-[1em] -translate-y-1/2 fill-none stroke-slate-400" strokeWidth="1.7">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => {setQuery(event.target.value); setPage(0);}}
              placeholder="Search rooms, locations, or issues..."
              aria-label="Search rooms, locations, or issues"
              className="w-full rounded-md border border-slate-700 bg-slate-900 py-[0.45em] pl-[2em] pr-[2.2em] text-white outline-none placeholder:text-slate-400 focus:border-sky-400"
            />
            {query && <button type="button" onClick={() => {setQuery(""); setPage(0);}} aria-label="Clear work-order search" className="absolute right-[0.3em] top-1/2 -translate-y-1/2 rounded px-[0.4em] text-slate-400 hover:bg-slate-800 hover:text-white">×</button>}
          </div>
        </div>
      </header>

      <WorkOrderFilters
        filter={filter}
        searching={!!normalizedQuery}
        loading={loading}
        countFor={countFor}
        onChange={key => { setFilter(key); setQuery(""); setPage(0); }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loading && rows.length === 0 && (
          <p className="rounded-md border border-slate-700 bg-slate-900 p-[0.5em] text-slate-300">{normalizedQuery ? "No work orders match your search." : "No work orders match this filter."}</p>
        )}
        {rows.length > 0 && (
          <div className="flex flex-col gap-[0.2em]">
            {rows.slice(0, ROW_LIMIT).map((order) => {
              const occupancy = roomStatusBadge(order.room_status);
              const checkout = listCheckoutLabel(order.checkout_date, order.checkout_time, order.room_status);
              const isDraft = order.is_draft === true;
              const sourceDraftId = typeof order.source_draft_id === "string" ? order.source_draft_id : "";
              return (
                <button
                  key={order.id}

                  data-preview-status={order.status}
                  type="button"
                  onClick={() => isDraft && sourceDraftId ? onOpenDraft?.(sourceDraftId) : onOpenWorkOrder(order)}
                  aria-label={`${isDraft ? "Review draft" : "Open work order"} for ${order.room || "No location"}: ${order.issue || "No issue description"}`}
                  className="flex w-full min-w-0 items-center gap-x-[0.5em] rounded-md border border-slate-700 bg-slate-900 px-[0.6em] py-[0.28em] text-left transition-colors hover:border-slate-500 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400"
                >
                  <div className="preview-row-content">
                    <div className="work-order-ticket-line" data-preview-pills>
                      {!isDraft && order.display_id && <span className="preview-wo-number">{formatWorkOrder(order.display_id)}</span>}
                      <span className={`work-order-pill ${statusClass(order.status)}`}>{normalizeKpiStatus(order.status)}</span>
                      {!isDraft && order.priority && <span className={`work-order-pill ${priorityClass(order.priority)}`}>{priorityLabel(order.priority)}</span>}
                      {!isDraft && <WorkOrderImportPill order={order} />}
                    </div>
                    <div className="work-order-room-line">
                      <span className="preview-room">{order.room || "No location"}</span>
                      {!isDraft && <>
                        {order.cn_room && order.guest_group_badge !== 'railway-cn' && <Image src="/railway-cn-logo.png" alt="CN" width={42} height={27} className="preview-group-badge" />}
                        <GuestGroupBadge badge={order.guest_group_badge} className="preview-group-badge" />
                        <LoyaltyBadge tier={order.loyalty_tier} />
                      </>}
                      {occupancy && <span data-preview-room-status className={`work-order-pill ${occupancy.className}`}>{occupancy.label}</span>}
                      {checkout && <span data-work-order-checkout className={`work-order-pill ${checkout.className}`}>{checkout.label}</span>}
                    </div>
                  <span className="block break-words text-[0.92em] leading-tight text-white">{order.issue || "No issue description"}</span>
                  {isDraft && <span className="block text-[0.78em] font-semibold leading-tight text-amber-200">Draft — awaiting Chief Engineer approval{order.potential_duplicate === true ? " · Possible duplicate — review" : ""}</span>}
                  <span data-preview-technician className="block break-words text-[0.78em] leading-tight text-slate-300">Assigned to: {order.technician_name || "Unassigned"}</span>
                  <div data-room-occupancy className="preview-incoming">
                    {!isDraft && order.incoming_reserved&&<><GuestGroupBadge badge={order.incoming_group_badge} className="preview-group-badge"/><LoyaltyBadge tier={order.incoming_loyalty_tier}/><span className="reserved-pill">Reserved</span></>}
                  </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {remote && remote.total > 100 && <nav aria-label="Work order pages" className="flex justify-end gap-2 text-xs"><button disabled={page === 0 || pageLoading} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page+1} of {Math.ceil(remote.total/100)}</span><button disabled={(page+1)*100>=remote.total || pageLoading} onClick={()=>setPage(p=>p+1)}>Next</button></nav>}
      <span role="status" className="shrink-0 text-right text-[0.68em] leading-tight text-slate-400">
        {loading ? "Loading…" : `${Math.min(rows.length, ROW_LIMIT)} of ${remote?.total ?? rows.length}`}
      </span>
    </div>
  );
}
