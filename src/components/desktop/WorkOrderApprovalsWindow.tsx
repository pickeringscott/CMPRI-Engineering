"use client";

import type { WorkOrderNotification } from "@/lib/dashboard/work-order-notifications";
import { roleDisplayName } from "@/lib/account-display";
import { priorityClass, type DesktopWorkOrder } from "./WorkOrderListWindow";
import { roomStatusBadge } from "@/lib/room-availability";

function formatWhen(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function WorkOrderApprovalsWindow({
  user,
  notifications,
  awaitingApproval,
  notificationError,
  soundEnabled,
  onToggleSound,
  onOpenWorkOrder,
  onOpenNotification,
  onClear,
  onClearAll,
}: {
  user: { name: string | null; email: string | null; role: string };
  notifications: WorkOrderNotification[];
  awaitingApproval: DesktopWorkOrder[];
  notificationError: string;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onOpenWorkOrder: (workOrderId: string) => void;
  onOpenNotification: (notification: WorkOrderNotification) => void;
  onClear: (notificationId: string) => void;
  onClearAll: () => void;
}) {
  return (
    <div className="cmpri-desktop-scale flex size-full min-h-0 flex-col gap-[0.6em] overflow-auto p-[0.6em]">
      <div role="group" aria-label="Signed-in account" className="flex shrink-0 flex-wrap items-center gap-x-[0.75em] gap-y-[0.25em] rounded-md border border-slate-800 bg-slate-900/70 px-[0.7em] py-[0.45em]">
        <span className="font-semibold text-white">{user.name?.trim() || "Name not set"}</span>
        <span className="rounded-full border border-sky-500/40 bg-sky-950/30 px-[0.5em] text-[0.82em] font-semibold text-sky-200">{roleDisplayName(user.role)}</span>
        {user.email && <span className="min-w-0 truncate text-[0.88em] text-slate-400">{user.email}</span>}
        <button type="button" onClick={onToggleSound} aria-pressed={soundEnabled} className="ml-auto rounded border border-slate-700 px-[0.6em] py-[0.15em] text-[0.85em] text-slate-300 hover:border-slate-500">
          {soundEnabled ? "Sound on" : "Sound off"}
        </button>
      </div>

      <div className="grid min-h-0 flex-1 gap-[0.6em] @3xl:grid-cols-2">
        <div className="flex min-h-[8em] flex-col overflow-hidden rounded-md border border-purple-400/30 bg-slate-900/60">
          <div className="flex shrink-0 items-center justify-between gap-[0.5em] border-b border-slate-800 px-[0.7em] py-[0.4em]">
            <span className="font-bold text-purple-100">Awaiting approval</span>
            <span className="text-[0.85em] text-slate-400">{awaitingApproval.length}</span>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-slate-800 overflow-auto">
            {awaitingApproval.length === 0 && <li className="p-[0.7em] text-slate-400">No work orders are waiting for approval.</li>}
            {awaitingApproval.map((order) => (
              <li key={order.id}>
                <button type="button" onClick={() => onOpenWorkOrder(order.id)} className="flex w-full items-start gap-[0.6em] px-[0.7em] py-[0.45em] text-left hover:bg-slate-800/60">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-white">{order.display_id ? `${order.display_id} · ` : ""}{order.room || "No location"}{roomStatusBadge(order.room_status) && <span className={`ml-1 inline-flex rounded-full border px-1.5 py-0.5 align-middle text-[10px] font-bold leading-none ${roomStatusBadge(order.room_status)!.className}`}>{roomStatusBadge(order.room_status)!.label}</span>}</span>
                    <span className="block truncate text-[0.88em] text-slate-300">{order.issue || "No issue description"}</span>
                    <span className="block truncate text-[0.8em] text-slate-500">{order.technician_name || "Unassigned"}</span>
                  </span>
                  {order.priority && <span className={`shrink-0 rounded-full border px-[0.5em] text-[0.8em] font-semibold ${priorityClass(order.priority)}`}>{order.priority}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-h-[8em] flex-col overflow-hidden rounded-md border border-sky-400/30 bg-slate-900/60">
          <div className="flex shrink-0 items-center justify-between gap-[0.5em] border-b border-slate-800 px-[0.7em] py-[0.4em]">
            <span className="font-bold text-sky-100">Notifications <span className="font-normal text-slate-400">({notifications.length})</span></span>
            {notifications.length > 0 && (
              <button type="button" onClick={onClearAll} className="rounded border border-sky-400/40 px-[0.6em] py-[0.1em] text-[0.85em] font-semibold text-sky-100 hover:bg-sky-950/40">Clear all</button>
            )}
          </div>
          {notificationError && <p role="status" className="shrink-0 border-b border-amber-400/30 bg-amber-950/25 px-[0.7em] py-[0.35em] text-[0.88em] text-amber-100">{notificationError}</p>}
          <ul aria-live="polite" className="min-h-0 flex-1 divide-y divide-slate-800 overflow-auto">
            {notifications.length === 0 && <li className="p-[0.7em] text-slate-400">No notifications. New ones stay on your account, on every computer, until you clear them.</li>}
            {notifications.map((notification) => (
              <li key={notification.id} className="flex items-start gap-[0.4em] px-[0.7em] py-[0.4em] hover:bg-slate-800/40">
                <button type="button" onClick={() => onOpenNotification(notification)} className="min-w-0 flex-1 text-left">
                  <span className="block text-slate-100 hover:underline">{notification.message}</span>
                  <span className="block text-[0.8em] text-slate-500">{formatWhen(notification.recorded_at)}</span>
                </button>
                <button type="button" onClick={() => onClear(notification.id)} aria-label={`Clear notification: ${notification.message}`} className="shrink-0 rounded border border-slate-700 px-[0.5em] text-[0.82em] text-slate-300 hover:border-slate-500 hover:text-white">Clear</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
