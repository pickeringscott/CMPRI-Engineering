"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { filterKpiWorkOrders, normalizeKpiStatus } from "@/lib/dashboard/kpi-filters";
import { roomStatusBadge } from "@/lib/room-availability";
import { HOTEL_TIME_ZONE } from "@/lib/constants";

export type DesktopWorkOrder = Record<string, unknown> & {
  id: string;
  display_id?: string | null;
  room?: string | null;
  room_status?: string | null;
  checkout_date?: string | null;
  checkout_time?: string | null;
  cn_room?: boolean | null;
  asset_name?: string | null;
  category?: string | null;
  issue?: string | null;
  priority?: string | null;
  technician_name?: string | null;
  status?: string | null;
  due_by?: string | null;
  created_at?: string | null;
};

export type WorkOrderListFilter = "pending" | "open" | "progress" | "priority" | "overdue" | "completed" | "closed" | "all";

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

export function priorityLabel(priority?: string | null) {
  const value = String(priority || "").trim();
  const normalized = value.toLowerCase();
  if (normalized === "urgent") return "Urgent Priority";
  if (normalized === "high") return "High Priority";
  if (normalized === "medium") return "Medium Priority";
  if (normalized === "low" || normalized === "normal") return "Normal Priority";
  return value;
}

export function groupWorkOrders<T extends DesktopWorkOrder>(orders: T[]): Record<WorkOrderListFilter, T[]> {
  const status = (order: T) => normalizeKpiStatus(order.status).toLowerCase();
  return {
    pending: orders.filter(isPendingApproval),
    open: filterKpiWorkOrders(orders, "open"),
    progress: filterKpiWorkOrders(orders, "progress"),
    priority: filterKpiWorkOrders(orders, "priority"),
    overdue: filterKpiWorkOrders(orders, "overdue"),
    completed: orders.filter((order) => status(order) === "completed"),
    closed: orders.filter((order) => ["closed", "duplicate", "will not do"].includes(status(order))),
    all: orders,
  };
}

const KPI_CARDS: Array<{ key: WorkOrderListFilter; label: string; tone: string }> = [
  { key: "pending", label: "Awaiting Approval", tone: "text-purple-200" },
  { key: "open", label: "Open", tone: "text-green-200" },
  { key: "progress", label: "In Progress", tone: "text-yellow-200" },
  { key: "priority", label: "Urgent / High", tone: "text-red-200" },
  { key: "overdue", label: "Overdue", tone: "text-orange-200" },
  { key: "completed", label: "Completed", tone: "text-blue-200" },
  { key: "closed", label: "Closed", tone: "text-slate-300" },
  { key: "all", label: "All", tone: "text-white" },
];

const ROW_LIMIT = 200;

export default function WorkOrderListWindow({
  orders,
  loading,
  onOpenWorkOrder,
}: {
  orders: DesktopWorkOrder[];
  loading: boolean;
  onOpenWorkOrder: (order: DesktopWorkOrder) => void;
}) {
  const [filter, setFilter] = useState<WorkOrderListFilter>("all");
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupWorkOrders(orders), [orders]);
  const normalizedQuery = query.trim().toLowerCase();
  const rows = normalizedQuery
    ? orders.filter((order) => Object.values(order).some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery)))
    : groups[filter];

  return (
    <div className="cmpri-desktop-scale flex size-full min-h-0 flex-col gap-[0.3em] overflow-hidden bg-slate-950 p-[0.45em] text-white">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-[0.35em]">
        <h1 className="text-[1.35em] font-bold leading-tight text-white">Work Order List</h1>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-[0.3em] @md:flex-nowrap">
          <div className="relative min-w-[12em] flex-1 @md:max-w-[32em]">
            <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute left-[0.65em] top-1/2 size-[1em] -translate-y-1/2 fill-none stroke-slate-400" strokeWidth="1.7">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search rooms, locations, or issues..."
              aria-label="Search rooms, locations, or issues"
              className="w-full rounded-md border border-[#28527b] bg-[#0b2038] py-[0.45em] pl-[2em] pr-[2.2em] text-white outline-none placeholder:text-slate-400 focus:border-sky-400"
            />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear work-order search" className="absolute right-[0.3em] top-1/2 -translate-y-1/2 rounded px-[0.4em] text-slate-400 hover:bg-slate-800 hover:text-white">×</button>}
          </div>
        </div>
      </header>

      <div id="work-order-kpi-filters" role="group" aria-label="Work order filters" className="grid shrink-0 grid-cols-4 gap-[0.2em] @md:grid-cols-8">
        {KPI_CARDS.map((card) => {
          const selected = !normalizedQuery && filter === card.key;
          return (
            <button
              key={card.key}
              type="button"
              title={card.label}
              aria-pressed={selected}
              onClick={() => { setFilter(card.key); setQuery(""); }}
              className={`flex min-w-0 items-center justify-between gap-[0.25em] rounded border px-[0.4em] py-[0.18em] text-left ${selected ? "border-sky-400 bg-[#102a47]" : "border-[#1b3d60] bg-[#0a1e34] hover:border-[#3974a8]"}`}
            >
              <span className="min-w-0 truncate text-[0.62em] font-semibold uppercase leading-tight tracking-wide text-slate-300">{card.label}</span>
              <span className={`shrink-0 text-[0.9em] font-bold leading-tight ${card.tone}`}>{loading ? "—" : groups[card.key].length}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loading && rows.length === 0 && (
          <p className="rounded-md border border-[#1b3d60] bg-[#0a1e34] p-[0.5em] text-slate-300">{normalizedQuery ? "No work orders match your search." : "No work orders match this filter."}</p>
        )}
        {rows.length > 0 && (
          <div className="flex flex-col gap-[0.2em]">
            {rows.slice(0, ROW_LIMIT).map((order) => {
              const occupancy = roomStatusBadge(order.room_status);
              const checkout = checkoutLabel(order.checkout_date, order.checkout_time);
              return (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => onOpenWorkOrder(order)}
                  aria-label={`Open work order for ${order.room || "No location"}: ${order.issue || "No issue description"}`}
                  className="flex w-full min-w-0 flex-col gap-[0.12em] rounded-md border border-[#1b4771] bg-[#0b2340] px-[0.6em] py-[0.28em] text-left transition-colors hover:border-[#3277b7] hover:bg-[#102b4b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-[0.5em] gap-y-[0.12em]">
                    <div className="flex min-w-0 flex-wrap items-center gap-[0.25em]">
                      <span className="font-bold leading-tight text-white">{order.room || "No location"}</span>
                      {order.cn_room && (
                        <Image
                          src="/railway-cn-logo.png"
                          alt="CN"
                          width={42}
                          height={27}
                          className="h-[1.15em] w-auto rounded-[3px] object-contain"
                        />
                      )}
                      {occupancy && <span className={`inline-flex rounded-full border px-[0.45em] py-[0.08em] text-[0.7em] font-semibold leading-tight ${occupancy.className}`}>{occupancy.label}</span>}
                      {checkout && <span className={`inline-flex rounded-full border px-[0.45em] py-[0.08em] text-[0.7em] font-semibold leading-tight ${checkout.className}`}>{checkout.label}</span>}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-[0.22em]">
                      {order.priority && <span className={`inline-flex rounded-full border px-[0.45em] py-[0.08em] text-[0.72em] font-semibold leading-tight ${priorityClass(order.priority)}`}>{priorityLabel(order.priority)}</span>}
                      <span className={`inline-flex rounded-full border px-[0.45em] py-[0.08em] text-[0.72em] font-semibold leading-tight ${statusClass(order.status)}`}>{normalizeKpiStatus(order.status)}</span>
                      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-[0.95em] shrink-0 fill-none stroke-sky-400" strokeWidth="2">
                        <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </div>
                  <span className="block break-words text-[0.92em] leading-tight text-white">{order.issue || "No issue description"}</span>
                  <span className="block break-words text-[0.78em] leading-tight text-sky-200/75">Assigned to: {order.technician_name || "Unassigned"}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <span role="status" className="shrink-0 text-right text-[0.68em] leading-tight text-sky-200/70">
        {loading ? "Loading…" : `${Math.min(rows.length, ROW_LIMIT)} of ${rows.length}`}
      </span>
    </div>
  );
}
