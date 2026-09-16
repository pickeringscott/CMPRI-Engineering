"use client";

import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";

type RoomRankerRow = {
  rowNumber: number;
  room: string;
  inspectedBy: string;
  check1: string;
  check2: string;
  check3: string;
  rank: string;
  notes: string;
};

const blank: RoomRankerRow = { rowNumber: 0, room: "", inspectedBy: "", check1: "", check2: "", check3: "", rank: "", notes: "" };

export default function RoomRankerPage() {
  const [rooms, setRooms] = useState<RoomRankerRow[]>([]);
  const [selected, setSelected] = useState<RoomRankerRow>(blank);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState("");

  async function token() {
    const session = await getValidSession();
    return session?.access_token || "";
  }

  async function loadRooms(silent = false) {
    if (!silent) setLoading(true);
    setError(""); setCanEdit(false);
    try {
      const response = await fetch("/api/room-ranker", { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to load Room Ranker.");
      setRooms(result.rooms || []);
      setCanEdit(result.can_edit === true);
      setSafeMode(result.safeMode === true);
      setLastRefresh(new Date(result.fetchedAt || Date.now()).toLocaleTimeString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    (async () => {
      if (!(await enforceSessionPreference())) return window.location.replace("/");
      await loadRooms();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = rooms.filter((row) => `${row.room} ${row.rank} ${row.notes}`.toLowerCase().includes(query.toLowerCase()));

  async function save() {
    if (!canEdit || saving || loading || !selected.rowNumber) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/room-ranker", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ ...selected, expectedRoom: selected.room }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save Room Ranker.");
      setRooms((current) => current.map((row) => row.rowNumber === selected.rowNumber ? selected : row));
      if (result.safeMode && result.blocked) {
        setMessage(`Safe mode is on: room ${selected.room} was captured here but NOT sent to the corporate Room Ranker.`);
      } else {
        setMessage(`Room ${selected.room} saved to the live Room Ranker.`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }

  const field = (key: keyof RoomRankerRow, label: string, multiline = false) => (
    <label className="block"><span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {multiline ? <textarea disabled={!canEdit || saving || loading} value={String(selected[key])} onChange={(e) => setSelected({ ...selected, [key]: e.target.value })} rows={3} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white outline-none focus:border-amber-400" />
        : <input disabled={!canEdit || saving || loading} value={String(selected[key])} onChange={(e) => setSelected({ ...selected, [key]: e.target.value })} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-white outline-none focus:border-amber-400" />}
    </label>
  );

  return <main className="min-h-screen bg-slate-950 text-white">
    <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
      <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">Live Google Sheet</p><h1 className="mt-1 text-3xl font-bold">Room Ranker</h1><p className="mt-2 text-sm text-slate-400">Edit inspected-by, room checks, rank, and notes. Room numbers and summary formulas are protected.</p></div>
        <div className="flex gap-2"><a href="/engineering" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold">Dashboard</a><button onClick={() => loadRooms()} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950">Refresh</button></div>
      </header>
      {error && <div className="mt-4 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-red-200">{error}</div>}
      {safeMode && <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/30 p-4 text-amber-200"><strong>Safe mode is on.</strong> You can view live Room Ranker data and make edits here, but nothing is sent back to corporate. Turn safe mode off in the environment to go live.</div>}
      {message && <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-4 text-emerald-200">{message}</div>}
      <div className="mt-5 grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center justify-between"><h2 className="font-bold">Rooms</h2><span className="text-xs text-slate-500">{lastRefresh && `Updated ${lastRefresh}`}</span></div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search room, rank, or note" className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm outline-none focus:border-amber-400" />
          <div className="mt-3 max-h-[65vh] space-y-2 overflow-y-auto pr-1">{loading ? <p className="p-3 text-slate-400">Loading live rooms…</p> : filtered.map((row) => <button key={row.rowNumber} onClick={() => { setSelected({ ...row }); setMessage(""); }} className={`w-full rounded-xl border p-3 text-left ${selected.rowNumber === row.rowNumber ? "border-amber-400 bg-amber-950/20" : "border-slate-800 bg-slate-950 hover:border-slate-600"}`}><div className="flex justify-between"><strong>Room {row.room}</strong><span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-bold">{row.rank || "Unranked"}</span></div>{row.notes && <p className="mt-2 line-clamp-2 text-xs text-slate-400">{row.notes}</p>}</button>)}</div>
        </section>
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          {!selected.rowNumber ? <div className="grid min-h-80 place-items-center text-center text-slate-400"><p>Select a room to review or update it.</p></div> : <>
            <div className="flex items-center justify-between border-b border-slate-800 pb-4"><div><p className="text-xs uppercase tracking-wide text-slate-500">Protected room number</p><h2 className="text-2xl font-bold">Room {selected.room}</h2></div><span className="rounded-full border border-amber-500/40 px-3 py-1 text-xs text-amber-300">Live record</span></div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">{field("inspectedBy", "Inspected by")}{field("rank", "Room rank")}{field("check1", "Specific room check 1", true)}{field("check2", "Specific room check 2", true)}{field("check3", "Specific room check 3", true)}{field("notes", "Notes / actions needed", true)}</div>
            <div className="mt-5 flex justify-end"><button disabled={!canEdit || saving || loading} onClick={save} className="rounded-lg bg-amber-400 px-5 py-3 font-bold text-slate-950 disabled:opacity-50">{!canEdit ? "View only" : saving ? "Saving…" : "Save to Live Room Ranker"}</button></div>
          </>}
        </section>
      </div>
    </div>
  </main>;
}
