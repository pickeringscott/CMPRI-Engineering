"use client";

import { useEffect, useMemo, useState } from "react";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import RoomOperationsImport from "./RoomOperationsImport";
import { useRouter } from "next/navigation";
import { authorizationHeaders, hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { isRailwayCnGuestName } from "@/lib/room-operations";
import Image from "next/image";

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
  reserved: number;
  vacantReady: number;
  vacantDirty: number;
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

function previousHotelDate() {
  return new Date(new Date(`${hotelDate()}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

function naturalRoomCompare(a: RoomOperation, b: RoomOperation) {
  return a.room.localeCompare(b.room, undefined, { numeric: true, sensitivity: "base" });
}

function roomStatusClass(status: string | null) {
  const value = String(status || "").trim().toLowerCase();
  if (value.includes("vacant ready") || value === "vr") return "border-green-400/45 bg-green-950/35 text-green-200";
  if (value.includes("vacant dirty") || value === "vd") return "border-amber-400/45 bg-amber-950/35 text-amber-200";
  return "border-slate-600 bg-slate-900 text-slate-300";
}

function isOutOfOrder(status: string | null) {
  const value = String(status || "").trim().toLowerCase();
  return value === "ooo" || value.includes("out of order") || value.includes("out-of-order");
}

function parseDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function displayDate(value: string | null) {
  const parsed = parseDate(value);
  return parsed ? parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
}

function daysUntilCheckout(value: string | null, today = hotelDate()) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const checkoutDate = new Date(`${value}T00:00:00Z`);
  const todayDate = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(checkoutDate.getTime()) || Number.isNaN(todayDate.getTime())) return null;
  return Math.round((checkoutDate.getTime() - todayDate.getTime()) / 86_400_000);
}

function checkoutLabel(row: Pick<RoomOperation, "checkout_date" | "checkout_time">, today = hotelDate()) {
  if (!row.checkout_date) return "";
  const days = daysUntilCheckout(row.checkout_date, today);
  const time = row.checkout_time || "11:00 AM";
  if (days === 0) return `Checkout today · ${time}`;
  if (days === 1) return `Checkout tomorrow · ${time}`;
  if (days !== null && days < 0) return `Overdue · ${displayDate(row.checkout_date)} · ${time}`;
  return `${displayDate(row.checkout_date)} · ${time}`;
}

function checkoutClass(days: number | null) {
  const pill = "rounded-full border px-2 py-0.5 text-xs font-semibold";
  if (days === 0) return `${pill} border-green-400/45 bg-green-950/35 text-green-200`;
  if (days === 1) return `${pill} border-yellow-400/45 bg-yellow-950/35 text-yellow-200`;
  if (days !== null && days < 0) return `${pill} border-red-400/45 bg-red-950/35 text-red-200`;
  return "text-xs text-slate-400";
}

function summaryFor(rows: RoomOperation[]): Summary {
  return rows.reduce<Summary>((summary, row) => {
    if (row.checkout_date) summary.departures += 1;
    if (row.reserved) summary.reserved += 1;
    const status = String(row.room_status || "").trim().toLowerCase();
    if (status.includes("vacant ready") || status === "vr") summary.vacantReady += 1;
    if (status.includes("vacant dirty") || status === "vd") summary.vacantDirty += 1;
    return summary;
  }, { departures: 0, reserved: 0, vacantReady: 0, vacantDirty: 0 });
}

function RoomIdentity({ row }: { row: RoomOperation }) {
  const railwayGuest = isRailwayCnGuestName(row.guest_name);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-lg font-black text-white">Room {row.room}</span>
      {railwayGuest ? (
        <Image
          src="/railway-cn-logo.png"
          alt=""
          aria-hidden="true"
          width={42}
          height={27}
          className="h-[1.5em] w-auto rounded-[4px] object-contain text-lg"
        />
      ) : null}
    </div>
  );
}

function CheckoutPill({ row }: { row: RoomOperation }) {
  const label = checkoutLabel(row);
  if (!label) return null;
  return <span className={checkoutClass(daysUntilCheckout(row.checkout_date))}>{label}</span>;
}

function MovePill({ row }: { row: RoomOperation }) {
  if (!row.move_from && !row.move_to) return null;
  return (
    <span className="rounded-full border border-red-400/60 bg-red-950/70 px-2 py-0.5 text-xs font-bold text-red-100">
      Move from {row.move_from || "—"}{row.move_to ? ` → ${row.move_to}` : ""}
    </span>
  );
}

function RoomDetails({ row }: { row: RoomOperation }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <RoomIdentity row={row} />
        {row.room_status ? isOutOfOrder(row.room_status)
          ? <span className="rounded-full border border-red-400/45 bg-red-950/35 px-2 py-0.5 text-xs font-semibold text-red-200">Out of Order</span>
          : <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${roomStatusClass(row.room_status)}`}>{row.room_status}</span> : null}
        {row.reserved ? <span className="rounded-full border border-fuchsia-400/45 bg-fuchsia-950/35 px-2 py-0.5 text-xs font-semibold text-fuchsia-200">Reserved</span> : null}
        <CheckoutPill row={row} />
        <MovePill row={row} />
      </div>
      {row.guest_name ? <div className="mt-1 break-words text-lg font-normal text-slate-400">{row.guest_name}</div> : null}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
        {row.stay_nights ? <span>LOS: {row.stay_nights} nights</span> : null}
      </div>
    </div>
  );
}

export default function RoomOperationsPage() {
  const router = useRouter();
  const [session, setSession] = useState<CmpriClientSession | null>(null);
  const [date, setDate] = useState(hotelDate);
  const [rows, setRows] = useState<RoomOperation[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [activeSummary, setActiveSummary] = useState<keyof Summary | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void loadCmpriSession().then((current) => {
      if (!active) return;
      if (!hasCapability(current, "view_engineering_operations")) {
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
  }, [date, refreshVersion, session]);

  function handleImportCommitted(importedDate: string) {
    setDate(importedDate);
    setRefreshVersion((version) => version + 1);
  }

  const summary = useMemo(() => summaryFor(rows), [rows]);
  const summaryCards: Array<[keyof Summary, string, number]> = [
    ["departures", "Departures", summary.departures],
    ["reserved", "Reserved", summary.reserved],
    ["vacantReady", "Vacant Ready", summary.vacantReady],
    ["vacantDirty", "Vacant Dirty", summary.vacantDirty],
  ];
  const summaryRows = useMemo(() => {
    if (!activeSummary) return [];
    return rows.filter((row) => {
      const status = String(row.room_status || "").trim().toLowerCase();
      if (activeSummary === "departures") return !!row.checkout_date;
      if (activeSummary === "reserved") return row.reserved === true;
      if (activeSummary === "vacantReady") return status.includes("vacant ready") || status === "vr";
      if (activeSummary === "vacantDirty") return status.includes("vacant dirty") || status === "vd";
      return false;
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
              <ModalDashboardLink className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800">Dashboard</ModalDashboardLink>
              <h1 className="text-xl font-black tracking-tight">Daily Room Operations</h1>
            </div>
            <p className="mt-2 text-sm text-slate-400">Manual room-status and expected-departure uploads create daily snapshots; room moves are detected by comparing today with yesterday.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold text-slate-300">
              Report date
              <input type="date" min={previousHotelDate()} max={hotelDate()} value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
            </label>
            {hasCapability(session, "edit_tickets") ? (
              <button type="button" onClick={() => setImportOpen((open) => !open)} className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-3 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">{importOpen ? "Hide Upload Form" : "Upload Room Ops"}</button>
            ) : null}
          </div>
        </header>

        {importOpen && hasCapability(session, "edit_tickets") ? (
          <RoomOperationsImport date={date} onDateChange={setDate} onCommitted={handleImportCommitted} />
        ) : null}

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {summaryCards.map(([key, label, value]) => (
            <button key={key} type="button" onClick={() => setActiveSummary(key)} className="rounded-xl border border-slate-800 bg-slate-900/65 p-3 text-left hover:border-slate-600">
              <div className="cmpri-modal-kpi-value text-2xl font-black text-white">{value}</div>
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
                <RoomDetails row={row} />
              </article>
            ))}
          </div>
        </section>

        {activeSummary && (
          <div className="cmpri-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
            <section role="dialog" aria-modal="true" aria-labelledby="room-summary-title" className="cmpri-modal-shell overflow-y-auto border border-slate-700 bg-slate-950 shadow-2xl">
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
                    <RoomDetails row={row} />
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
