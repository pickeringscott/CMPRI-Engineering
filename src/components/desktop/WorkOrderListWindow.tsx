"use client";

import { useMemo, useState } from "react";
import { filterKpiWorkOrders, isKpiOverdue, normalizeKpiStatus } from "@/lib/dashboard/kpi-filters";
import { roomStatusBadge } from "@/lib/room-availability";

export type DesktopWorkOrder = Record<string, unknown> & {
  id: string;
  display_id?: string | null;
  room?: string | null;
  room_status?: string | null;
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
  if (value === "urgent") return "border-purple-400/40 bg-purple-950/45 text-purple-200";
  if (value === "high") return "border-red-400/40 bg-red-950/40 text-red-200";
  if (value === "medium") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  if (value === "low") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  return "border-slate-700 bg-slate-900 text-slate-300";
}

export function statusClass(status?: string | null) {
  const value = normalizeKpiStatus(status).toLowerCase();
  if (value === "pending verification") return "border-purple-400/50 bg-purple-950/45 text-purple-200";
  if (value === "open") return "border-green-400/40 bg-green-950/35 text-green-200";
  if (value === "in progress") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  if (value === "completed") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  if (value === "duplicate") return "border-orange-400/40 bg-orange-950/35 text-orange-200";
  if (value === "closed") return "border-red-400/40 bg-red-950/35 text-red-200";
  return "border-slate-600 bg-slate-800 text-slate-200";
}

export function isPendingApproval(order: { status?: string | null }) {
  return normalizeKpiStatus(order.status).toLowerCase() === "pending verification";
}

function formatDue(value?: string | null) {
  if (!value) return "—";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    <div className="cmpri-desktop-scale flex size-full min-h-0 flex-col gap-[0.5em] overflow-hidden p-[0.6em]">
      <div role="group" aria-label="Work order KPIs" className="grid shrink-0 grid-cols-2 gap-[0.4em] @md:grid-cols-4 @4xl:grid-cols-8">
        {KPI_CARDS.map((card) => {
          const selected = !normalizedQuery && filter === card.key;
          return (
            <button
              key={card.key}
              type="button"
              aria-pressed={selected}
              onClick={() => { setFilter(card.key); setQuery(""); }}
              className={`min-w-0 rounded-md border px-[0.6em] py-[0.35em] text-left ${selected ? "border-amber-400 bg-amber-950/25" : "border-slate-800 bg-slate-900/80 hover:border-slate-600"}`}
            >
              <span className="block truncate text-[0.78em] font-semibold uppercase tracking-wide text-slate-400">{card.label}</span>
              <span className={`block text-[1.35em] font-bold leading-tight ${card.tone}`}>{loading ? "—" : groups[card.key].length}</span>
            </button>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-[0.5em]">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search work orders…"
            aria-label="Search work orders"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-[0.75em] pr-[2.2em] text-white outline-none placeholder:text-slate-500 focus:border-amber-400"
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear work-order search" className="absolute right-[0.3em] top-1/2 -translate-y-1/2 rounded px-[0.4em] text-slate-400 hover:bg-slate-800 hover:text-white">×</button>}
        </div>
        <span role="status" className="shrink-0 text-[0.85em] text-slate-400">
          {loading ? "Loading…" : `${Math.min(rows.length, ROW_LIMIT)} of ${rows.length}`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-800 bg-slate-900/60">
        {!loading && rows.length === 0 && (
          <p className="p-[0.8em] text-slate-400">{normalizedQuery ? "No work orders match your search." : "No work orders match this filter."}</p>
        )}
        {rows.length > 0 && (
          <table className="w-full table-fixed border-collapse text-left text-[0.92em]">
            <thead className="sticky top-0 z-10 bg-slate-900 text-[0.8em] uppercase tracking-wide text-slate-400">
              <tr>
                <th scope="col" className="hidden w-[7em] px-[0.6em] py-[0.4em] @xl:table-cell">WO #</th>
                <th scope="col" className="w-[7.5em] px-[0.6em] py-[0.4em]">Location</th>
                <th scope="col" className="px-[0.6em] py-[0.4em]">Issue</th>
                <th scope="col" className="hidden w-[6.5em] px-[0.6em] py-[0.4em] @2xl:table-cell">Priority</th>
                <th scope="col" className="w-[9.5em] px-[0.6em] py-[0.4em]">Status</th>
                <th scope="col" className="hidden w-[9em] px-[0.6em] py-[0.4em] @3xl:table-cell">Technician</th>
                <th scope="col" className="hidden w-[6em] px-[0.6em] py-[0.4em] @4xl:table-cell">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.slice(0, ROW_LIMIT).map((order) => (
                <tr key={order.id} onClick={() => onOpenWorkOrder(order)} className="cursor-pointer align-top hover:bg-slate-800/60">
                  <td className="hidden truncate px-[0.6em] py-[0.45em] font-mono text-slate-300 @xl:table-cell">{order.display_id || "—"}</td>
                  <td className="px-[0.6em] py-[0.45em]">
                    <button type="button" onClick={(event) => { event.stopPropagation(); onOpenWorkOrder(order); }} className="max-w-full truncate text-left font-bold text-white hover:underline">
                      {order.room || "No location"}
                    </button>
                    {roomStatusBadge(order.room_status) && <span className={`ml-1 inline-flex rounded-full border px-1.5 py-0.5 align-middle text-[0.72em] font-bold leading-none ${roomStatusBadge(order.room_status)!.className}`}>{roomStatusBadge(order.room_status)!.label}</span>}
                    {order.category && <span className="block truncate text-[0.8em] text-slate-500">{order.category}</span>}
                  </td>
                  <td className="px-[0.6em] py-[0.45em]">
                    <span className="line-clamp-2 text-slate-200">{order.issue || "No issue description"}</span>
                    {order.asset_name && <span className="block truncate text-[0.8em] text-slate-500">{order.asset_name}</span>}
                  </td>
                  <td className="hidden px-[0.6em] py-[0.45em] @2xl:table-cell">
                    {order.priority && <span className={`inline-block rounded-full border px-[0.5em] text-[0.82em] font-semibold ${priorityClass(order.priority)}`}>{order.priority}</span>}
                  </td>
                  <td className="px-[0.6em] py-[0.45em]">
                    <span className={`inline-block max-w-full truncate rounded-full border px-[0.5em] text-[0.82em] font-semibold ${statusClass(order.status)}`}>{normalizeKpiStatus(order.status)}</span>
                  </td>
                  <td className="hidden truncate px-[0.6em] py-[0.45em] text-slate-300 @3xl:table-cell">{order.technician_name || "Unassigned"}</td>
                  <td className={`hidden px-[0.6em] py-[0.45em] @4xl:table-cell ${isKpiOverdue(order.due_by) ? "font-semibold text-orange-300" : "text-slate-400"}`}>{formatDue(order.due_by)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
