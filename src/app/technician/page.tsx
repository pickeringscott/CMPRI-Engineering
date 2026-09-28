"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { signOutDevice } from "@/lib/supabase/client";
import type { CmpriClientSession } from "@/lib/auth/client-session";
import AccountSummary from "@/components/AccountSummary";
import { dashboardTitleForRole } from "@/lib/account-display";

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
  const router = useRouter();
  const [orders, setOrders] = useState<AssignedWorkOrder[]>([]);
  const [account, setAccount] = useState<CmpriClientSession["user"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  async function signOut() {
    await signOutDevice();
    router.replace("/");
  }

  async function loadAssignedWork() {
    setLoading(true);
    setMessage("");
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again to load your technician dashboard.");
      const accountResponse = await fetch("/api/session", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const accountPayload = await accountResponse.json().catch(() => ({}));
      if (!accountResponse.ok || !accountPayload.user) throw new Error(accountPayload.error || "Your account could not be loaded.");
      setAccount(accountPayload.user as CmpriClientSession["user"]);
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
    // The loader updates async state after the effect returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAssignedWork();
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Technician Workspace</p>
            <h1 className="mt-2 text-3xl font-bold">{dashboardTitleForRole(account?.role || "Maintenance Technician")}</h1>
            <p className="mt-2 text-sm text-slate-400">Your assigned active work, status, and due dates.</p>
            {account && <div className="mt-3"><AccountSummary user={account} /></div>}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link href="/profile" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-slate-800">Manage Profile</Link>
            <button type="button" onClick={() => void loadAssignedWork()} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200 disabled:opacity-50">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" onClick={() => void signOut()} className="rounded-lg border border-red-400/50 bg-red-950/30 px-4 py-2 text-sm font-bold text-red-100 hover:bg-red-900/40">Sign Out</button>
          </div>
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
                <Link key={order.id} href={`/work-orders/${encodeURIComponent(order.id)}`} className="grid gap-3 px-5 py-4 hover:bg-slate-800/50 md:grid-cols-[1fr_140px_150px] md:items-center">
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
                </Link>
              ))}
            </div>
          )}
        </section>

        <Link href="/work-orders" className="mt-6 inline-block text-sm font-bold text-amber-400">Create a Work Order</Link>
      </div>
    </main>
  );
}
