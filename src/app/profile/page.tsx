"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";

type Profile = { id: string; email: string | null; full_name: string | null; role: string | null };
type Preferences = {
  language: "en" | "es";
  appearance: "light" | "dark";
  notifications: { new_work_orders: boolean; status_changes: boolean; mentions: boolean };
};
type Payload = { profile: Profile; preferences: Preferences; can_manage_users: boolean; personal_ai: { connected: boolean; status: string; message: string } };

export default function ProfilePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [name, setName] = useState("");
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  async function headers() {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error("Sign in again to manage your profile.");
    return { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/profile", { headers: await headers(), cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Profile could not be loaded.");
        if (cancelled) return;
        const result = payload as Payload;
        setData(result);
        setName(result.profile.full_name || "");
        setPreferences(result.preferences);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Profile could not be loaded.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!preferences || !name.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: await headers(),
        body: JSON.stringify({ full_name: name, preferences }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Profile could not be saved.");
      setMessage("Profile and preferences saved.");
      setData((current) => current ? { ...current, profile: payload.profile, preferences: payload.preferences } : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function setPersonalAiConnection(action: "connect" | "disconnect") {
    setAiBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: await headers(),
        body: JSON.stringify({ personal_ai_action: action }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Personal AI connection could not be updated.");
      setData((current) => current ? { ...current, personal_ai: payload.personal_ai } : current);
      setMessage(action === "connect" ? "Personal AI connected for this user." : "Personal AI disconnected for this user.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Personal AI connection could not be updated.");
    } finally {
      setAiBusy(false);
    }
  }

  if (!data || !preferences) return <main className="min-h-screen bg-slate-950 p-6 text-white">{message || "Loading profile…"}</main>;

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-400">CMPRI Account</p>
            <h1 className="mt-1 text-3xl font-bold">Manage Profile</h1>
          </div>
          <Link href={data.profile.role === "Senior Management" ? "/engineering" : "/engineering"} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Dashboard</Link>
        </div>

        {message && <div role="status" className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm">{message}</div>}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">Profile</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm text-slate-300">Display name<input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white" /></label>
            <label className="grid gap-1 text-sm text-slate-300">Sign-in email<input value={data.profile.email || ""} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>
            <label className="grid gap-1 text-sm text-slate-300 sm:col-span-2">CMPRI role/title<input value={data.profile.role || "Unknown"} readOnly className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-400" /></label>
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">Personal Preferences</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm text-slate-300">Language<select value={preferences.language} onChange={(event) => setPreferences({ ...preferences, language: event.target.value as Preferences["language"] })} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"><option value="en">English</option><option value="es">Spanish</option></select></label>
            <label className="grid gap-1 text-sm text-slate-300">Appearance<select value={preferences.appearance} onChange={(event) => setPreferences({ ...preferences, appearance: event.target.value as Preferences["appearance"] })} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white"><option value="dark">Dark</option><option value="light">Light</option></select></label>
          </div>
          <div className="mt-4 space-y-3">
            <p className="text-sm font-semibold text-slate-300">Notifications</p>
            {(["new_work_orders", "status_changes", "mentions"] as const).map((key) => <label key={key} className="flex items-center gap-3 text-sm text-slate-300"><input type="checkbox" checked={preferences.notifications[key]} onChange={(event) => setPreferences({ ...preferences, notifications: { ...preferences.notifications, [key]: event.target.checked } })} className="h-4 w-4" />{key === "new_work_orders" ? "New work orders" : key === "status_changes" ? "Work-order status changes" : "Ticket mentions"}</label>)}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-xl font-bold">Personal AI Connection</h2>
          <p className="mt-2 text-sm text-slate-400">Status: <span className={data.personal_ai.connected ? "text-emerald-300" : "text-slate-300"}>{data.personal_ai.connected ? "Connected" : "Disconnected"}</span></p>
          <p className="mt-2 text-sm text-slate-400">{data.personal_ai.message}</p>
          <p className="mt-3 text-xs text-slate-500">CMPRI does not grant an AI independent authority. Any future connection must use authenticated CMPRI actions, inherit your permissions, and remain attributable to you.</p>
          <div className="mt-4 flex justify-end">
            <button type="button" disabled={aiBusy} onClick={() => void setPersonalAiConnection(data.personal_ai.connected ? "disconnect" : "connect")} className={`rounded-lg border px-4 py-2 text-sm font-bold disabled:opacity-50 ${data.personal_ai.connected ? "border-red-500/50 text-red-200 hover:bg-red-950/30" : "border-sky-500/50 bg-sky-950/30 text-sky-100 hover:bg-sky-900/40"}`}>
              {aiBusy ? "Updating…" : data.personal_ai.connected ? "Disconnect Personal AI" : "Connect Personal AI"}
            </button>
          </div>
        </section>

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          {data.can_manage_users && <Link href="/management/users" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">User Management</Link>}
          <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-blue-700 px-5 py-2 font-bold text-white hover:bg-blue-600 disabled:opacity-50">{busy ? "Saving…" : "Save Profile"}</button>
        </div>
      </div>
    </main>
  );
}
