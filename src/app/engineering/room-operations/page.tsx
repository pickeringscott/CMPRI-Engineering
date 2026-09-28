"use client";

import { useEffect, useMemo, useState } from "react";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import { useRouter } from "next/navigation";
import { authorizationHeaders, hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { HOTEL_TIME_ZONE } from "@/lib/constants";

type RoomOperation = {
  room: string;
  checkout_date: string | null;
  checkout_time: string | null;
  room_status: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  move_from: string | null;
  move_to: string | null;
  guest_name: string | null;
  room_type: string | null;
  guest_code: string | null;
  guest_arrival_date: string | null;
  stay_nights: number | null;
  reserved: boolean | null;
  imported_at: string | null;
};

type Summary = {
  departures: number;
  arrivals: number;
  reserved: number;
  moves: number;
  vacantReady: number;
  vacantDirty: number;
  outOfOrder: number;
};

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

function naturalRoomCompare(a: RoomOperation, b: RoomOperation) {
  return a.room.localeCompare(b.room, undefined, { numeric: true, sensitivity: "base" });
}

function roomStatusClass(status: string | null) {
  const value = String(status || "").trim().toLowerCase();
  if (value.includes("vacant ready") || value === "vr") return "border-green-400/45 bg-green-950/35 text-green-200";
  if (value.includes("vacant dirty") || value === "vd") return "border-amber-400/45 bg-amber-950/35 text-amber-200";
  if (value === "ooo" || value.includes("out of order") || value.includes("out-of-order")) return "border-red-400/45 bg-red-950/35 text-red-200";
  return "border-slate-600 bg-slate-900 text-slate-300";
}

function parseDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateClass(value: string | null, selectedDate: string) {
  const date = parseDate(value);
  const report = parseDate(selectedDate);
  if (!date || !report) return "border-slate-600 bg-slate-900 text-slate-300";
  const diff = Math.round((date.getTime() - report.getTime()) / 86_400_000);
  if (diff < 0) return "border-red-400/45 bg-red-950/35 text-red-200";
  if (diff === 0) return "border-green-400/45 bg-green-950/35 text-green-200";
  if (diff === 1) return "border-yellow-400/45 bg-yellow-950/35 text-yellow-200";
  return "border-blue-400/45 bg-blue-950/35 text-blue-200";
}

function displayDate(value: string | null) {
  const parsed = parseDate(value);
  return parsed ? parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
}

function summaryFor(rows: RoomOperation[]): Summary {
  return rows.reduce<Summary>((summary, row) => {
    if (row.checkout_date) summary.departures += 1;
    if (row.arrival_date) summary.arrivals += 1;
    if (row.reserved) summary.reserved += 1;
    if (row.move_from || row.move_to) summary.moves += 1;
    const status = String(row.room_status || "").trim().toLowerCase();
    if (status.includes("vacant ready") || status === "vr") summary.vacantReady += 1;
    if (status.includes("vacant dirty") || status === "vd") summary.vacantDirty += 1;
    if (status === "ooo" || status.includes("out of order") || status.includes("out-of-order")) summary.outOfOrder += 1;
    return summary;
  }, { departures: 0, arrivals: 0, reserved: 0, moves: 0, vacantReady: 0, vacantDirty: 0, outOfOrder: 0 });
}

export default function RoomOperationsPage() {
  const router = useRouter();
  const [session, setSession] = useState<CmpriClientSession | null>(null);
  const [date, setDate] = useState(hotelDate);
  const [rows, setRows] = useState<RoomOperation[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [activeSummary, setActiveSummary] = useState<keyof Summary | null>(null);

  useEffect(() => {
    let active = true;
    void loadCmpriSession().then((current) => {
      if (!active) return;
      if (!hasCapability(current, "view_dashboard")) {
        router.replace(current.landing);
        return;
      }
      setSession(current);
    }).catch(() => {
      if (active) router.replace("/");
    });
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void (async () => {
      await Promise.resolve();
      setLoading(true);
      setMessage("");
      const headers = await authorizationHeaders();
      const response = await fetch(`/api/room-operations?date=${encodeURIComponent(date)}`, {
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; rows?: RoomOperation[] };
      if (!response.ok) throw new Error(payload.error || "Unable to load daily room operations.");
      if (!controller.signal.aborted) setRows((payload.rows || []).slice().sort(naturalRoomCompare));
    })().catch((error) => {
      if (!controller.signal.aborted) {
        setRows([]);
        setMessage(error instanceof Error ? error.message : "Unable to load daily room operations.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [date, session]);

  const summary = useMemo(() => summaryFor(rows), [rows]);
  const summaryCards: Array<[keyof Summary, string, number]> = [
    ["departures", "Departures", summary.departures],
    ["arrivals", "Incoming", summary.arrivals],
    ["reserved", "Reserved", summary.reserved],
    ["moves", "Moves", summary.moves],
    ["vacantReady", "Vacant Ready", summary.vacantReady],
    ["vacantDirty", "Vacant Dirty", summary.vacantDirty],
    ["outOfOrder", "Out of Order", summary.outOfOrder],
  ];
  const summaryRows = useMemo(() => {
    if (!activeSummary) return [];
    return rows.filter((row) => {
      const status = String(row.room_status || "").trim().toLowerCase();
      if (activeSummary === "departures") return !!row.checkout_date;
      if (activeSummary === "arrivals") return !!row.arrival_date;
      if (activeSummary === "reserved") return row.reserved === true;
      if (activeSummary === "moves") return !!row.move_from || !!row.move_to;
      if (activeSummary === "vacantReady") return status.includes("vacant ready") || status === "vr";
      if (activeSummary === "vacantDirty") return status.includes("vacant dirty") || status === "vd";
      return status === "ooo" || status.includes("out of order") || status.includes("out-of-order");
    });
  }, [activeSummary, rows]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => [
      row.room,
      row.guest_name,
      row.room_status,
      row.room_type,
      row.guest_code,
      row.move_from,
      row.move_to,
    ].some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [query, rows]);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-5 text-slate-100 sm:px-6">
      <div className="mx-auto w-full space-y-4">
        <header className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ModalDashboardLink className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800">← Dashboard</ModalDashboardLink>
              <h1 className="text-xl font-black tracking-tight">Daily Room Operations</h1>
              <span className="rounded-full border border-sky-500/40 bg-sky-950/30 px-2.5 py-0.5 text-xs font-bold text-sky-200">Moves: {summary.moves}</span>
            </div>
            <p className="mt-2 text-sm text-slate-400">Shared CMPRI departure, arrival, guest, room-status, reserved and room-move data.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold text-slate-300">
              Report date
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
            </label>
            {hasCapability(session, "edit_tickets") ? (
              <ModalDashboardLink href="/engineering#room-operations-import" className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-3 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">Import on Dashboard</ModalDashboardLink>
            ) : null}
          </div>
        </header>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {summaryCards.map(([key, label, value]) => (
            <button key={key} type="button" onClick={() => setActiveSummary(key)} className="rounded-xl border border-slate-800 bg-slate-900/65 p-3 text-left hover:border-slate-600">
              <div className="text-2xl font-black text-white">{value}</div>
              <div className="text-xs font-semibold text-slate-400">{label}</div>
            </button>
          ))}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-bold text-slate-200">{loading ? "Loading…" : `${filtered.length} of ${rows.length} rooms`}</div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search room, guest, status, type or code"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 sm:max-w-md"
            />
          </div>

          {message ? <div className="mb-3 rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">{message}</div> : null}
          {!loading && !message && rows.length === 0 ? <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">No room-operations snapshot is saved for {date}.</div> : null}

          <div className="space-y-2">
            {filtered.map((row) => (
              <article key={row.room} className="rounded-xl border border-slate-800 bg-slate-950/55 p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-black text-white">Room {row.room}</span>
                      {row.room_status ? <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${roomStatusClass(row.room_status)}`}>{row.room_status}</span> : null}
                      {row.reserved ? <span className="rounded-full border border-fuchsia-400/45 bg-fuchsia-950/35 px-2 py-0.5 text-xs font-bold text-fuchsia-200">Reserved</span> : null}
                      {row.move_from || row.move_to ? <span className="rounded-full border border-sky-400/45 bg-sky-950/35 px-2 py-0.5 text-xs font-bold text-sky-200">Move {row.move_from ? `${row.move_from} → ` : ""}{row.move_to || row.room}</span> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-300">
                      {row.guest_name ? <span><strong className="text-slate-400">Guest:</strong> {row.guest_name}</span> : null}
                      {row.room_type ? <span><strong className="text-slate-400">Type:</strong> {row.room_type}</span> : null}
                      {row.guest_code ? <span><strong className="text-slate-400">Code:</strong> {row.guest_code}</span> : null}
                      {row.guest_arrival_date ? <span><strong className="text-slate-400">Current arrival:</strong> {displayDate(row.guest_arrival_date)}</span> : null}
                      {row.stay_nights ? <span><strong className="text-slate-400">LOS:</strong> {row.stay_nights} nights</span> : null}
                    </div>
                  </div>
                  <div className="grid min-w-[280px] grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:min-w-[520px]">
                    <div className={`rounded-lg border p-2 ${dateClass(row.checkout_date, date)}`}><div className="font-semibold opacity-75">Checkout</div><div className="mt-0.5 font-bold">{displayDate(row.checkout_date)}</div><div>{row.checkout_time || "—"}</div></div>
                    <div className={`rounded-lg border p-2 ${dateClass(row.arrival_date, date)}`}><div className="font-semibold opacity-75">Incoming</div><div className="mt-0.5 font-bold">{displayDate(row.arrival_date)}</div><div>{row.arrival_time || "—"}</div></div>
                    <div className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300"><div className="font-semibold text-slate-500">Move from</div><div className="mt-0.5 font-bold text-slate-200">{row.move_from || "—"}</div></div>
                    <div className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300"><div className="font-semibold text-slate-500">Move to</div><div className="mt-0.5 font-bold text-slate-200">{row.move_to || "—"}</div></div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        {activeSummary && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-1">
            <section role="dialog" aria-modal="true" aria-labelledby="room-summary-title" className="cmpri-modal-shell cmpri-dashboard-overlay-panel overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-4 shadow-2xl sm:p-5">
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">Daily Room Operations</p>
                  <h2 id="room-summary-title" className="mt-1 text-2xl font-bold">{summaryCards.find(([key]) => key === activeSummary)?.[1]} ({summaryRows.length})</h2>
                </div>
                <button type="button" onClick={() => setActiveSummary(null)} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Close</button>
              </div>
              <div className="mt-4 space-y-2">
                {summaryRows.length ? summaryRows.map((row) => (
                  <article key={row.room} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-black text-white">Room {row.room}</span>
                      {row.room_status ? <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${roomStatusClass(row.room_status)}`}>{row.room_status}</span> : null}
                      {row.reserved ? <span className="rounded-full border border-fuchsia-400/45 bg-fuchsia-950/35 px-2 py-0.5 text-xs font-bold text-fuchsia-200">Reserved</span> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-300">
                      {row.guest_name ? <span><strong className="text-slate-400">Guest:</strong> {row.guest_name}</span> : null}
                      {row.checkout_date ? <span><strong className="text-slate-400">Checkout:</strong> {displayDate(row.checkout_date)} {row.checkout_time || ""}</span> : null}
                      {row.arrival_date ? <span><strong className="text-slate-400">Incoming:</strong> {displayDate(row.arrival_date)} {row.arrival_time || ""}</span> : null}
                      {row.move_from || row.move_to ? <span><strong className="text-slate-400">Move:</strong> {row.move_from || "—"} → {row.move_to || row.room}</span> : null}
                    </div>
                  </article>
                )) : <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">No rooms match this KPI.</p>}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
