"use client";

import { resourceViewVisible } from "@/lib/events/visibility";
import { subscribeResources } from "@/lib/events/browser";
import { nextGuestDisplayChange } from "@/lib/room-guest-reports";
import { useEffect, useMemo, useRef, useState } from "react";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import RoomOperationsImport from "./RoomOperationsImport";
import GuestReportsImport from "./GuestReportsImport";
import { useRouter } from "next/navigation";
import { authorizationHeaders, hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { isRailwayCnGuestName } from "@/lib/room-operations";
import GuestGroupBadge from "@/components/GuestGroupBadge";
import Image from "next/image";

type RoomOperation = {
  company?: string; group_name?: string; incoming_company?: string;
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
  report_date: string | null;
  source_report_date: string | null;
  source_uploaded_at: string | null;
  checkout_source_report_date: string | null;
  checkout_source_uploaded_at: string | null;
  incoming_name: string | null;
  incoming_type: string | null;
  incoming_code: string | null;
  incoming_block_indicator: string | null;
  incoming_reserved: boolean | null;
};

type Summary = {
  departures: number;
  reserved: number;
  vacantReady: number;
  vacantDirty: number;
};

type SnapshotInfo = {
  requestedDate: string;
  sourceDate: string | null;
  sourceType: string | null;
  carriedOver: boolean;
  provenance: string | null;
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

function displayDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "—";
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { timeZone: HOTEL_TIME_ZONE, month: "short", day: "numeric" }).format(parsed);
}

function displayCheckoutTime(value: string | null) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match) return value || "11:00 AM";
  let hours = Number(match[1]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem) hours = (hours % 12) + (meridiem === "PM" ? 12 : 0);
  return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
}

function displayHotelTimestamp(value: string | null) {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unavailable"
    : new Intl.DateTimeFormat(undefined, {
      timeZone: HOTEL_TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(parsed);
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
  const time = displayCheckoutTime(row.checkout_time);
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
  const railwayGuest = isRailwayCnGuestName(row.guest_name) || isRailwayCnGuestName(row.company);
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

function CheckoutPill({ row, today }: { row: RoomOperation; today: string }) {
  const label = checkoutLabel(row, today);
  if (!label) return null;
  const carriedOver = Boolean(row.checkout_source_report_date && row.checkout_source_report_date < today);
  const provenance = [
    `Source report date: ${row.checkout_source_report_date || "Unavailable"}.`,
    `Uploaded: ${displayHotelTimestamp(row.checkout_source_uploaded_at)} (America/Chicago).`,
    ...(carriedOver ? ["Carried-over data."] : []),
  ].join(" ");
  return (
    <details className="group relative">
      <summary
        className={`${checkoutClass(daysUntilCheckout(row.checkout_date, today))} cursor-help list-none`}
        aria-label={`${label}. ${provenance} Activate for details.`}
        title={provenance}
      >
        {label}{carriedOver ? " · Carried-over data" : ""}
      </summary>
      <div
        role="tooltip"
        className="absolute left-0 top-full z-20 mt-1 hidden w-64 rounded-lg border border-slate-600 bg-slate-900 p-2 text-xs font-normal text-slate-200 shadow-xl group-hover:block group-focus-within:block group-open:block"
      >
        <div>Source report date: {row.checkout_source_report_date || "Unavailable"}</div>
        <div>Uploaded: {displayHotelTimestamp(row.checkout_source_uploaded_at)} (America/Chicago)</div>
        {carriedOver ? <div className="mt-1 font-semibold text-amber-200">Carried-over data</div> : null}
      </div>
    </details>
  );
}

function MovePill({ row }: { row: RoomOperation }) {
  if (!row.move_from && !row.move_to) return null;
  return (
    <span className="rounded-full border border-red-400/60 bg-red-950/70 px-2 py-0.5 text-xs font-bold text-red-100">
      Move from {row.move_from || "—"}{row.move_to ? ` → ${row.move_to}` : ""}
    </span>
  );
}

function RoomDetails({ row, today }: { row: RoomOperation; today: string }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <RoomIdentity row={row} />
        {row.room_status ? isOutOfOrder(row.room_status)
          ? <span className="rounded-full border border-red-400/45 bg-red-950/35 px-2 py-0.5 text-xs font-semibold text-red-200">{row.room_status}</span>
          : <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${roomStatusClass(row.room_status)}`}>{row.room_status}</span> : null}
        {row.reserved ? <span className="rounded-full border border-fuchsia-400/45 bg-fuchsia-950/35 px-2 py-0.5 text-xs font-semibold text-fuchsia-200">Reserved</span> : null}
        <CheckoutPill row={row} today={today} />
        <MovePill row={row} />
      </div>
      {row.guest_name ? <div className="mt-1 break-words text-lg font-normal text-slate-400">{row.guest_name} <GuestGroupBadge group={row.group_name || row.company}/></div> : null}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-400">
        {row.stay_nights ? <span>LOS: {row.stay_nights} nights</span> : null}
      </div>
      {row.incoming_name || row.incoming_type || row.incoming_code || row.arrival_date || row.arrival_time || row.incoming_block_indicator ? (
        <div className="mt-1 text-sm text-sky-200">
          Incoming: {row.incoming_name || "Name unavailable"} <GuestGroupBadge group={row.incoming_company}/>
          {row.incoming_type ? ` · ${row.incoming_type}` : ""}
          {row.incoming_code ? ` · ${row.incoming_code}` : ""}
          {row.arrival_date ? ` · ${displayDate(row.arrival_date)}` : ""}
          {row.arrival_time ? ` ${displayCheckoutTime(row.arrival_time)}` : ""}
          {row.incoming_block_indicator ? ` · ${row.incoming_block_indicator}` : ""}
        </div>
      ) : null}
    </div>
  );
}

export default function RoomOperationsPage() {
  const router = useRouter();
  const [session, setSession] = useState<CmpriClientSession | null>(null);
  const [date, setDate] = useState(hotelDate);
  const [today, setToday] = useState(hotelDate);
  const hotelTodayRef = useRef(today);
  const [rows, setRows] = useState<RoomOperation[]>([]);
  const [snapshotInfo, setSnapshotInfo] = useState<SnapshotInfo | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [activeSummary, setActiveSummary] = useState<keyof Summary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [guestReportImport, setGuestReportImport] = useState(true);
  const [guestImportBusy, setGuestImportBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = hotelDate();
      const previous = hotelTodayRef.current;
      if (current !== previous) {
        hotelTodayRef.current = current;
        setToday(current);
        setDate((selected) => selected === previous ? current : selected);
      }
      if (resourceViewVisible(window)) setRefreshVersion((version) => version + 1);
    }, Math.max(1, nextGuestDisplayChange(rows.map(row => ({...row,guest_name:row.guest_name || "",room_status:row.room_status || ""})), new Date(), HOTEL_TIME_ZONE) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [rows, refreshVersion]);

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
    const stop = subscribeResources(["rooms", "orders"], async () => {
      try {
        const currentDay = hotelDate();
        const previousDay = hotelTodayRef.current;
        if (currentDay !== previousDay) {
          hotelTodayRef.current = currentDay;
          setToday(currentDay);
          setDate(selected => selected === previousDay ? currentDay : selected);
        }
        await Promise.resolve();
        setLoading(true);
        setMessage("");
        const headers = await authorizationHeaders();
        const response = await fetch(`/api/room-operations?date=${encodeURIComponent(date)}`, {
          headers, cache: "no-store", signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as {
          error?: string; rows?: RoomOperation[]; date?: string; source_date?: string | null;
          source_type?: string | null; carried_over?: boolean; provenance?: string | null;
        };
        if (!response.ok) throw new Error(payload.error || "Unable to load daily room operations.");
        if (!controller.signal.aborted) {
          setRows((payload.rows || []).slice().sort(naturalRoomCompare));
          setSnapshotInfo({
            requestedDate: payload.date || date, sourceDate: payload.source_date || null,
            sourceType: payload.source_type || null, carriedOver: payload.carried_over === true,
            provenance: payload.provenance || null,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRows([]); setSnapshotInfo(null);
          setMessage(error instanceof Error ? error.message : "Unable to load daily room operations.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    });
    return () => { stop(); controller.abort(); };
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
            <p className="mt-2 text-sm text-slate-400">The latest accepted room report remains current until a newer verified report replaces it. Scheduled checkout times update the room to vacant dirty; this is not physical checkout confirmation.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold text-slate-300">
              Report date
              <input type="date" min={previousHotelDate()} max={today} value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
            </label>
            {hasCapability(session, "edit_tickets") ? (
              <button type="button" disabled={guestImportBusy} onClick={() => setImportOpen((open) => !open)} className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-3 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">{importOpen ? "Hide Upload Form" : "Upload Room Ops"}</button>
            ) : null}
          </div>
        </header>

        {importOpen && hasCapability(session, "edit_tickets") ? (
          <div className="space-y-3">
            <label className="block text-sm text-slate-300">Report format
              <select disabled={guestImportBusy} value={guestReportImport ? "guests" : "legacy"} onChange={event => setGuestReportImport(event.target.value === "guests")} className="ml-2 rounded bg-slate-900 p-2">
                <option value="guests">In House Guest List / Housekeeping</option>
                <option value="legacy">Room Status / Expected Departures</option>
              </select>
            </label>
            {guestReportImport
              ? <GuestReportsImport date={date} onDateChange={setDate} onCommitted={handleImportCommitted} onBusyChange={setGuestImportBusy}/>
              : <RoomOperationsImport date={date} onDateChange={setDate} onCommitted={handleImportCommitted}/>}
          </div>
        ) : null}

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {summaryCards.map(([key, label, value]) => (
            <button key={key} type="button" onClick={() => setActiveSummary(key)} className="rounded-xl border border-slate-800 bg-slate-900/65 p-3 text-left hover:border-slate-600">
              <div className="cmpri-modal-kpi-value text-2xl font-black text-white">{value}</div>
              <div className="text-xs font-semibold text-slate-400">{label}</div>
            </button>
          ))}
        </section>

        {snapshotInfo?.sourceDate ? (
          <p role="status" className="rounded-xl border border-amber-400/35 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">
            Showing {snapshotInfo.sourceType === "legacy" ? "legacy room data" : "room data"} from {displayDate(snapshotInfo.sourceDate)}
            {snapshotInfo.carriedOver ? ` for selected date ${displayDate(snapshotInfo.requestedDate)} (carried over)` : ""}
            {snapshotInfo.provenance ? `. ${snapshotInfo.provenance}` : ""}
          </p>
        ) : snapshotInfo ? (
          <p role="status" className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
            No accepted or preserved room snapshot is available on or before {displayDate(snapshotInfo.requestedDate)}.
          </p>
        ) : null}

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
                <RoomDetails row={row} today={today} />
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
                    <RoomDetails row={row} today={today} />
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
