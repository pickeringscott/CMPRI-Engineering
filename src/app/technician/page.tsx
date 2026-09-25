"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";

type AssignedWorkOrder = {
  id: string;
  display_id: string;
  room: string | null;
  asset_name: string | null;
  category: string | null;
  issue: string | null;
  priority: string | null;
  status: string | null;
  due_by: string | null;
};

export default function TechnicianDashboard() {
  const [orders, setOrders] = useState<AssignedWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  async function loadAssignedWork() {
    setLoading(true);
    setMessage("");
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again to load your technician dashboard.");
      const response = await fetch("/api/work-orders?mode=technician", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Assigned work could not be loaded.");
      setOrders((payload.work_orders || []) as AssignedWorkOrder[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Assigned work could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAssignedWork();
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Technician Workspace</p>
            <h1 className="mt-2 text-3xl font-bold">Technician Dashboard</h1>
            <p className="mt-2 text-sm text-slate-400">Your assigned active work, status, and due dates.</p>
          </div>
          <button type="button" onClick={() => void loadAssignedWork()} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200 disabled:opacity-50">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {message && <p role="status" className="mt-6 rounded-lg border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-100">{message}</p>}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <h2 className="text-xl font-bold">Assigned Work</h2>
            <span className="text-sm text-slate-400">{orders.length} active</span>
          </div>
          {loading ? <p className="p-5 text-slate-400">Loading assigned work…</p> : orders.length === 0 ? (
            <p className="p-5 text-slate-400">No active work is assigned to you.</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {orders.map((order) => (
                <article key={order.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_140px_150px] md:items-center">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-400">{order.display_id}</p>
                    <h3 className="mt-1 text-lg font-semibold">{order.issue || "Work order"}</h3>
                    <p className="mt-1 text-sm text-slate-400">{order.room || "No location"}{order.asset_name ? ` · ${order.asset_name}` : ""}</p>
                  </div>
                  <div className="text-sm">
                    <p className="font-semibold">{order.status || "Open"}</p>
                    <p className="mt-1 text-slate-400">{order.category || "General"} · {order.priority || "Medium"}</p>
                  </div>
                  <p className="text-sm text-slate-400">{order.due_by ? `Due ${new Date(order.due_by).toLocaleDateString()}` : "No due date"}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <Link href="/work-orders" className="mt-6 inline-block text-sm font-bold text-amber-400">Create a Work Order</Link>
      </div>
    </main>
  );
}
