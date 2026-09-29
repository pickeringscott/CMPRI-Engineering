"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidSession, signOutDevice } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import AccountSummary from "@/components/AccountSummary";
import { dashboardTitleForRole, roleDisplayName } from "@/lib/account-display";
import { BUILD_VERSION } from "@/lib/constants";
import { filterKpiWorkOrders, isKpiOverdue, isOpenKpiStatus, normalizeKpiStatus } from "@/lib/dashboard/kpi-filters";
import {
  fetchWorkOrderNotifications,
  mergeWorkOrderNotifications,
  readWorkOrderNotificationCursor,
  saveWorkOrderNotificationCursor,
  unseenWorkOrderNotifications,
  type WorkOrderNotification,
} from "@/lib/dashboard/work-order-notifications";
import WorkOrderNotificationBanner from "@/components/WorkOrderNotificationBanner";
import { roleKey } from "@/lib/server/roles";

const REFRESH_MS = 30_000;
const NEW_ORDER_LAST_SEEN_PREFIX = "cmpri:new-order-last-seen:v1:";
const NEW_ORDER_SOUND_PREF_KEY = "cmpri:new-order-sound:v1";

type WorkOrder = Record<string, unknown> & {
  id: string;
  display_id?: string | null;
  room?: string | null;
  asset_name?: string | null;
  category?: string | null;
  issue?: string | null;
  priority?: string | null;
  technician_name?: string | null;
  status?: string | null;
  due_by?: string | null;
  created_at?: string | null;
};

type DashboardFilter = "pending" | "open" | "progress" | "completed" | "priority" | "overdue" | "closed" | "all";
type RoomOperation = {
  room: string;
  checkoutDate: string;
  checkoutTime: string;
  roomStatus: string;
  arrivalDate: string;
  arrivalTime: string;
  moveFrom: string;
  moveTo: string;
  guestName: string;
  roomType: string;
  guestCode: string;
  guestArrivalDate: string;
  stayNights: number;
  reserved: boolean;
  importedAt: string;
};
type RoomOperationImportSource = "paste" | "file" | "photo";
type ValidatedRoomOperation = {
  room: string;
  checkout_date: string;
  checkout_time: string;
  room_status: string;
  arrival_date: string;
  arrival_time: string;
  move_from: string;
  move_to: string;
  guest_name: string;
  room_type: string;
  guest_code: string;
  guest_arrival_date: string;
  stay_nights: number;
  reserved: boolean;
};
type RoomOperationPreview = { date: string; source: RoomOperationImportSource; rows: ValidatedRoomOperation[] };

function normalizeStatus(value?: string | null) {
  return normalizeKpiStatus(value);
}

function isOpenStatus(value?: string | null) {
  return isOpenKpiStatus(value);
}

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isOverdue(value?: string | null) {
  return isKpiOverdue(value);
}

function formatDue(value?: string | null) {
  const date = parseDate(value);
  return date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "No due date";
}

function priorityClass(priority?: string | null) {
  const value = String(priority || "").toLowerCase();
  if (value === "urgent") return "border-purple-400/40 bg-purple-950/45 text-purple-200";
  if (value === "high") return "border-red-400/40 bg-red-950/40 text-red-200";
  if (value === "medium") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  if (value === "low") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  return "border-slate-700 bg-slate-900 text-slate-300";
}

function statusClass(status?: string | null) {
  const value = normalizeStatus(status).toLowerCase();
  if (value === "pending verification") return "border-purple-400/50 bg-purple-950/45 text-purple-200";
  if (value === "open") return "border-green-400/40 bg-green-950/35 text-green-200";
  if (value === "in progress") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  if (value === "completed") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  if (value === "duplicate") return "border-orange-400/40 bg-orange-950/35 text-orange-200";
  if (value === "closed") return "border-red-400/40 bg-red-950/35 text-red-200";
  return "border-slate-600 bg-slate-800 text-slate-200";
}

function roomStatusClass(status?: string | null) {
  const value = String(status || "").trim().toLowerCase();
  if (value.includes("vacant ready")) return "border-green-400/45 bg-green-950/35 text-green-200";
  if (value.includes("vacant dirty")) return "border-amber-400/45 bg-amber-950/35 text-amber-200";
  if (value === "ooo" || value.includes("out of order") || value.includes("out-of-order")) return "border-red-400/45 bg-red-950/35 text-red-200";
  return "border-slate-600 bg-slate-900 text-slate-300";
}

function mapRoomOperation(row: Record<string, unknown>): RoomOperation {
  return {
    room: String(row.room || ""),
    checkoutDate: String(row.checkout_date || ""),
    checkoutTime: String(row.checkout_time || ""),
    roomStatus: String(row.room_status || ""),
    arrivalDate: String(row.arrival_date || ""),
    arrivalTime: String(row.arrival_time || ""),
    moveFrom: String(row.move_from || ""),
    moveTo: String(row.move_to || ""),
    guestName: String(row.guest_name || ""),
    roomType: String(row.room_type || ""),
    guestCode: String(row.guest_code || ""),
    guestArrivalDate: String(row.guest_arrival_date || ""),
    stayNights: Number(row.stay_nights || 0),
    reserved: row.reserved === true,
    importedAt: String(row.imported_at || ""),
  };
}

function parseRoomOpsDate(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return null;
  const us = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if (us) {
    const year = Number(us[3].length === 2 ? `20${us[3]}` : us[3]);
    const date = new Date(year, Number(us[1]) - 1, Number(us[2]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function roomOpsDateClass(value?: string | null) {
  const date = parseRoomOpsDate(value);
  if (!date) return "border-slate-600 bg-slate-900 text-slate-300";
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((target - today) / 86_400_000);
  if (days < 0) return "border-red-400/45 bg-red-950/35 text-red-200";
  if (days === 0) return "border-green-400/45 bg-green-950/35 text-green-200";
  if (days === 1) return "border-amber-400/45 bg-amber-950/35 text-amber-200";
  return "border-blue-400/45 bg-blue-950/35 text-blue-200";
}

function CmpriMark() {
  // Do not fabricate the approved Hawk/feather logo. Replace this neutral mark
  // only when the exact approved artwork is supplied to the project.
  return (
    <div aria-label="CMPRI" className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-amber-400/50 bg-slate-900 text-sm font-black tracking-tight text-amber-300 shadow-lg shadow-black/20">
      CMPRI
    </div>
  );
}
function normalizeHeader(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function parseDelimitedLine(line: string, delimiter: string) {
  if (delimiter === "\t") return line.split("\t").map((cell) => cell.trim());
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseRoomOperationsText(raw: string): RoomOperation[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const rows = lines.map((line) => parseDelimitedLine(line, delimiter));
  const headers = rows[0].map(normalizeHeader);
  const findIndex = (...names: string[]) => {
    const normalized = names.map(normalizeHeader);
    const exact = headers.findIndex((header) => normalized.includes(header));
    if (exact >= 0) return exact;
    return headers.findIndex((header) => normalized.some((name) => name.length >= 4 && header.includes(name)));
  };
  const roomIndex = findIndex("ROOM", "ROOM #", "ROOM NUMBER", "RM");
  const checkoutDateIndex = findIndex("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE");
  const checkoutTimeIndex = findIndex("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME");
  const roomStatusIndex = findIndex("ROOM STATUS", "HOUSEKEEPING STATUS", "HK STATUS", "STATUS");
  const arrivalDateIndex = findIndex("INCOMING ARRIVAL DATE", "CHECKIN DATE", "CHECK-IN DATE", "CHECK IN DATE");
  const arrivalTimeIndex = findIndex("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "CHECK IN TIME");
  const moveFromIndex = findIndex("MOVE FROM", "MOVED FROM", "ROOM MOVE FROM", "FROM ROOM", "PREVIOUS ROOM");
  const moveToIndex = findIndex("MOVE TO", "MOVED TO", "ROOM MOVE TO", "TO ROOM", "NEW ROOM");
  const guestNameIndex = findIndex("GUEST NAME", "GUEST / NAME", "GUEST", "NAME");
  const roomTypeIndex = findIndex("ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE");
  const guestCodeIndex = findIndex("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const guestArrivalIndex = findIndex("GUEST ARRIVAL", "ARV", "ARV DATE");
  const stayNightsIndex = findIndex("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIndex = findIndex("RESERVED", "BLOCKED", "BLK");
  if (stayNightsIndex < 0) throw new Error("The extracted table is missing a Length of Stay (LOS) column. No rows were imported.");
  if (reservedIndex < 0) throw new Error("The extracted table is missing a Reserved column. No rows were imported.");
  const start = roomIndex >= 0 ? 1 : 0;
  const parsedRows = rows.slice(start).map((row, index): RoomOperation => {
    const sourceLine = start + index + 1;
    const stayText = stayNightsIndex >= 0 ? String(row[stayNightsIndex] || "").trim() : "";
    if (!stayText) throw new Error(`Line ${sourceLine}: length of stay is blank. No rows were imported.`);
    const stayNights = stayText ? Number(stayText) : 0;
    if (!Number.isInteger(stayNights) || stayNights < 0 || stayNights > 3650) {
      throw new Error(`Line ${sourceLine}: length of stay must be a whole number from 0 to 3650; found '${stayText}'.`);
    }
    const reservedText = reservedIndex >= 0 ? String(row[reservedIndex] || "").trim().toLowerCase() : "";
    const trueValues = ["true", "yes", "y", "1", "reserved", "blk"];
    const falseValues = ["false", "no", "n", "0", "not reserved"];
    if (!reservedText) throw new Error(`Line ${sourceLine}: reserved value is blank. No rows were imported.`);
    if (reservedIndex >= 0 && !trueValues.includes(reservedText) && !falseValues.includes(reservedText)) {
      throw new Error(`Line ${sourceLine}: reserved value '${reservedText}' is not recognized.`);
    }
    return {
    room: String(row[roomIndex >= 0 ? roomIndex : 0] || "").match(/\b\d{2,4}\b/)?.[0] || "",
    checkoutDate: checkoutDateIndex >= 0 ? String(row[checkoutDateIndex] || "") : "",
    checkoutTime: checkoutTimeIndex >= 0 ? String(row[checkoutTimeIndex] || "") : "",
    roomStatus: roomStatusIndex >= 0 ? String(row[roomStatusIndex] || "") : "",
    arrivalDate: arrivalDateIndex >= 0 ? String(row[arrivalDateIndex] || "") : "",
    arrivalTime: arrivalTimeIndex >= 0 ? String(row[arrivalTimeIndex] || "") : "",
    moveFrom: moveFromIndex >= 0 ? String(row[moveFromIndex] || "").match(/\b\d{2,4}\b/)?.[0] || "" : "",
    moveTo: moveToIndex >= 0 ? String(row[moveToIndex] || "").match(/\b\d{2,4}\b/)?.[0] || "" : "",
    guestName: guestNameIndex >= 0 ? String(row[guestNameIndex] || "").trim() : "",
    roomType: roomTypeIndex >= 0 ? String(row[roomTypeIndex] || "").trim() : "",
    guestCode: guestCodeIndex >= 0 ? String(row[guestCodeIndex] || "").trim() : "",
    guestArrivalDate: guestArrivalIndex >= 0 ? String(row[guestArrivalIndex] || "").trim() : "",
    stayNights,
    reserved: reservedIndex >= 0
      ? trueValues.includes(reservedText)
      : row.some((cell) => ["reserved", "blk"].includes(String(cell || "").trim().toLowerCase())),
    importedAt: "",
  };
  });
  const missingRoomIndex = parsedRows.findIndex((row) => !row.room);
  if (missingRoomIndex >= 0) {
    throw new Error(`Line ${start + missingRoomIndex + 1}: room number was not recognized. No rows were discarded.`);
  }
  return parsedRows;
}

function roomNumberFromLabel(value?: string | null) {
  return String(value || "").match(/\b\d{2,4}\b/)?.[0] || "";
}

function readLastSeenTimestamp(userId: string): number {
  try {
    const raw = window.localStorage.getItem(`${NEW_ORDER_LAST_SEEN_PREFIX}${userId}`);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeLastSeenTimestamp(userId: string, value: number) {
  try {
    window.localStorage.setItem(`${NEW_ORDER_LAST_SEEN_PREFIX}${userId}`, String(value));
  } catch {}
}

function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(NEW_ORDER_SOUND_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSoundPreference(enabled: boolean) {
  try {
    window.localStorage.setItem(NEW_ORDER_SOUND_PREF_KEY, enabled ? "on" : "off");
  } catch {}
}

function orderCreatedMs(order: WorkOrder): number {
  const value = order.created_at ? new Date(order.created_at).getTime() : NaN;
  return Number.isFinite(value) ? value : 0;
}

export default function EngineeringDashboardPage() {
  const router = useRouter();
  const refreshInFlightRef = useRef(false);
  const roomOpsInFlightRef = useRef(false);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [cmpriSession, setCmpriSession] = useState<CmpriClientSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<DashboardFilter>("open");
  const [showWorkOrderList, setShowWorkOrderList] = useState(false);
  const [listSearchQuery, setListSearchQuery] = useState("");
  const [activeWorkOrderId, setActiveWorkOrderId] = useState("");
  const [workOrderModalToken, setWorkOrderModalToken] = useState("");
  const workOrderModalFrameRef = useRef<HTMLIFrameElement | null>(null);
  const workOrderFrameCleanupRef = useRef<(() => void) | null>(null);
  const dashboardDialogRef = useRef<HTMLElement | null>(null);
  function setDashboardDialogElement(element: HTMLElement | null) {
    dashboardDialogRef.current = element;
  }
  const [chatgptConnected, setChatgptConnected] = useState(false);
  const [newFeedbackCount, setNewFeedbackCount] = useState(0);
  const [roomOperations, setRoomOperations] = useState<RoomOperation[]>([]);
  const [roomOpsInput, setRoomOpsInput] = useState("");
  const [showRoomOpsImport, setShowRoomOpsImport] = useState(false);
  const [roomOpsReportDate, setRoomOpsReportDate] = useState("");
  const [roomOpsPreview, setRoomOpsPreview] = useState<RoomOperationPreview | null>(null);
  const [roomOpsImportBusy, setRoomOpsImportBusy] = useState(false);
  const [newOrderQueue, setNewOrderQueue] = useState<WorkOrder[]>([]);
  const [workOrderNotifications, setWorkOrderNotifications] = useState<WorkOrderNotification[]>([]);
  const [notificationError, setNotificationError] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(true);
  const notificationCursorRef = useRef<string | null>(null);
  const notificationPollInFlightRef = useRef(false);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
  const pendingNotificationIdsRef = useRef<Set<string>>(new Set());
  const knownOrderIdsRef = useRef<Set<string> | null>(null);
  const lastSeenMsRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousTitleRef = useRef<string>("");

  async function loadDashboard(silent = false) {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again to load the dashboard.");
      const response = await fetch("/api/work-orders", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.work_orders)) throw new Error(payload.error || "Dashboard work orders could not be loaded.");
      const fetched = payload.work_orders as WorkOrder[];
      setOrders(fetched);
      detectNewOrders(fetched);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? `Dashboard error: ${error.message}` : "Dashboard error.");
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
    }
  }

  function openCreateWorkOrder() {
    window.dispatchEvent(new CustomEvent("cmpri-open-modal", {
      detail: { href: "/work-orders", title: "Create Work Order" },
    }));
  }

  function playAlertTone() {
    if (!soundEnabledRef.current) return;
    try {
      const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      audioContextRef.current ??= new AudioCtor();
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.55);
      gain.connect(ctx.destination);
      const tones = [880, 1320];
      tones.forEach((frequency, index) => {
        const oscillator = ctx.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, now + index * 0.22);
        oscillator.connect(gain);
        oscillator.start(now + index * 0.22);
        oscillator.stop(now + index * 0.22 + 0.2);
      });
    } catch {}
  }

  function detectNewOrders(fetched: WorkOrder[]) {
    const previous = knownOrderIdsRef.current;
    const currentIds = new Set(fetched.map((order) => order.id));
    if (previous === null) {
      knownOrderIdsRef.current = currentIds;
      return;
    }
    const lastSeenMs = lastSeenMsRef.current;
    const arrivals = fetched.filter((order) => {
      if (previous.has(order.id)) return false;
      const created = orderCreatedMs(order);
      if (created && lastSeenMs && created <= lastSeenMs) return false;
      return true;
    });
    knownOrderIdsRef.current = currentIds;
    if (arrivals.length === 0) return;
    setNewOrderQueue((existing) => {
      const combined = new Map<string, WorkOrder>();
      [...existing, ...arrivals].forEach((order) => combined.set(order.id, order));
      return Array.from(combined.values()).sort((a, b) => orderCreatedMs(b) - orderCreatedMs(a));
    });
    playAlertTone();
  }

  function dismissNewOrders() {
    setNewOrderQueue((existing) => {
      const highest = existing.reduce((max, order) => Math.max(max, orderCreatedMs(order)), lastSeenMsRef.current);
      lastSeenMsRef.current = highest;
      if (cmpriSession?.user.id) writeLastSeenTimestamp(cmpriSession.user.id, highest);
      return [];
    });
  }

  function openNewOrder(order: WorkOrder) {
    const highest = Math.max(lastSeenMsRef.current, orderCreatedMs(order));
    lastSeenMsRef.current = highest;
    if (cmpriSession?.user.id) writeLastSeenTimestamp(cmpriSession.user.id, highest);
    setNewOrderQueue((existing) => existing.filter((entry) => entry.id !== order.id));
    openWorkOrder(order.id);
  }

  function toggleSound() {
    setSoundEnabled((current) => {
      const next = !current;
      soundEnabledRef.current = next;
      writeSoundPreference(next);
      if (next) playAlertTone();
      return next;
    });
  }

  function dismissWorkOrderNotifications() {
    setWorkOrderNotifications([]);
    pendingNotificationIdsRef.current.clear();
    if (cmpriSession?.user.id && notificationCursorRef.current) {
      saveWorkOrderNotificationCursor(cmpriSession.user.id, notificationCursorRef.current);
    }
  }

  function openWorkOrder(workOrderId: string) {
    const preview = orders.find((order) => order.id === workOrderId);
    if (preview) {
      try { window.sessionStorage.setItem(`cmpri:work-order-preview:${workOrderId}`, JSON.stringify(preview)); } catch {}
    }
    setWorkOrderModalToken(crypto.randomUUID());
    setActiveWorkOrderId(workOrderId);
  }

  async function fetchRoomOperations(reportDate?: string) {
    const session = await getValidSession();
    const token = session?.access_token;
    if (!token) throw new Error("Sign in again to load room operations.");
    const query = reportDate ? `?date=${encodeURIComponent(reportDate)}` : "";
    const response = await fetch(`/api/room-operations${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as { date?: string; rows?: Record<string, unknown>[]; error?: string };
    if (!response.ok || !Array.isArray(payload.rows) || typeof payload.date !== "string") throw new Error(payload.error || "Room operations could not be loaded.");
    return { date: payload.date, rows: payload.rows.map(mapRoomOperation).sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true, sensitivity: "base" })) };
  }

  async function loadRoomOperations(silent = false) {
    if (roomOpsInFlightRef.current) return;
    roomOpsInFlightRef.current = true;
    try {
      const result = await fetchRoomOperations();
      setRoomOperations(result.rows);
      setRoomOpsReportDate(result.date);
      if (!silent) setMessage("");
    } catch (error) {
      if (!silent) setMessage(error instanceof Error ? `Room operations error: ${error.message}` : "Room operations error.");
    } finally {
      roomOpsInFlightRef.current = false;
    }
  }

  async function prepareRoomOperationsImport(rows: RoomOperation[], source: RoomOperationImportSource) {
    setRoomOpsPreview(null);
    setMessage("");
    if (!rows.length) {
      setMessage("No room checkout rows were found. Paste a spreadsheet table with a Room column.");
      return;
    }
    if (!roomOpsReportDate) {
      setMessage("Choose the report date before preparing an import.");
      return;
    }
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again before validating room operations.");
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, report_date: roomOpsReportDate, rows, validate_only: true }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; date?: string; count?: number; rows?: ValidatedRoomOperation[]; error?: string };
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.rows) || typeof payload.date !== "string") throw new Error(payload.error || "Room-operations rows could not be validated.");
      setRoomOpsPreview({ date: payload.date, source, rows: payload.rows });
      setMessage(`${payload.count || payload.rows.length} rows validated. Review the preview, then commit to replace this date's snapshot.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations validation error: ${error.message}` : "Room operations validation error.");
    }
  }

  async function commitRoomOperationsImport() {
    if (!roomOpsPreview || roomOpsImportBusy) return;
    setRoomOpsImportBusy(true);
    setMessage("");
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again before importing room operations.");
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source: roomOpsPreview.source, report_date: roomOpsPreview.date, rows: roomOpsPreview.rows }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; import_id?: string; date?: string; count?: number; error?: string };
      if (!response.ok || payload.ok !== true || !payload.import_id) throw new Error(payload.error || "Room operations were not saved.");

      let saved: Awaited<ReturnType<typeof fetchRoomOperations>>;
      try {
        saved = await fetchRoomOperations(roomOpsPreview.date);
      } catch (error) {
        throw new Error(`RPC ${payload.import_id} succeeded, but read-back verification failed: ${error instanceof Error ? error.message : "Room operations could not be reloaded."}`);
      }
      const savedByRoom = new Map(saved.rows.map((row) => [row.room, row]));
      const snapshotMatches = saved.date === roomOpsPreview.date
        && saved.rows.length === roomOpsPreview.rows.length
        && roomOpsPreview.rows.every((expected) => {
          const actual = savedByRoom.get(expected.room);
          return !!actual
            && actual.checkoutDate === expected.checkout_date
            && actual.checkoutTime === expected.checkout_time
            && actual.roomStatus === expected.room_status
            && actual.arrivalDate === expected.arrival_date
            && actual.arrivalTime === expected.arrival_time
            && actual.moveFrom === expected.move_from
            && actual.moveTo === expected.move_to
            && actual.guestName === expected.guest_name
            && actual.roomType === expected.room_type
            && actual.guestCode === expected.guest_code
            && actual.guestArrivalDate === expected.guest_arrival_date
            && actual.stayNights === expected.stay_nights
            && actual.reserved === expected.reserved;
        });
      if (!snapshotMatches) {
        throw new Error(`RPC ${payload.import_id} succeeded, but the saved snapshot did not match the validated preview. Reload Room Operations and verify report date ${roomOpsPreview.date}.`);
      }

      setRoomOperations(saved.rows);
      setRoomOpsReportDate(saved.date);
      setRoomOpsPreview(null);
      setRoomOpsInput("");
      setShowRoomOpsImport(false);
      setMessage(`${saved.rows.length} room-operation rows were saved and verified for ${saved.date} (import ${payload.import_id}).`);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations commit error: ${error.message}` : "Room operations commit error: import status could not be verified.");
    } finally {
      setRoomOpsImportBusy(false);
    }
  }

  function previewRoomOperationsText(raw: string, source: RoomOperationImportSource) {
    try {
      void prepareRoomOperationsImport(parseRoomOperationsText(raw), source);
    } catch (error) {
      setRoomOpsPreview(null);
      setMessage(error instanceof Error ? `Room operations validation error: ${error.message}` : "Room operations validation error.");
    }
  }

  async function handleRoomOpsFile(file?: File | null) {
    if (!file) return;
    setRoomOpsPreview(null);
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setMessage("Export the checkout sheet as CSV/TSV/TXT, or paste the spreadsheet rows.");
      return;
    }
    previewRoomOperationsText(await file.text(), "file");
  }


  async function handleRoomOpsImage(file?: File | null) {
    if (!file) return;
    setRoomOpsPreview(null);
    if (!file.type.startsWith("image/")) {
      setMessage("Choose a checkout/arrival report photo or screenshot.");
      return;
    }
    const Detector = (window as unknown as {
      TextDetector?: new () => { detect(input: ImageBitmap): Promise<Array<{ rawValue?: string; boundingBox?: { x: number; y: number; width: number; height: number } }>> };
    }).TextDetector;
    if (!Detector) {
      setMessage("This browser does not expose local image text recognition. Use pasted rows or CSV/TSV/TXT on this device; the photo itself was not uploaded to an AI provider.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const items = (await new Detector().detect(bitmap))
        .filter((item) => String(item.rawValue || "").trim())
        .sort((a, b) => {
          const ay = a.boundingBox?.y ?? 0;
          const by = b.boundingBox?.y ?? 0;
          if (Math.abs(ay - by) > 8) return ay - by;
          return (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0);
        });
      bitmap.close();
      const rows: Array<{ y: number; h: number; cells: typeof items }> = [];
      for (const item of items) {
        const box = item.boundingBox;
        const centerY = box ? box.y + box.height / 2 : rows.length * 20;
        const existing = rows.find((row) => Math.abs(row.y - centerY) <= Math.max(8, row.h * 0.65));
        if (existing) {
          existing.cells.push(item);
          existing.y = (existing.y + centerY) / 2;
          existing.h = Math.max(existing.h, box?.height ?? 12);
        } else {
          rows.push({ y: centerY, h: box?.height ?? 12, cells: [item] });
        }
      }
      const extracted = rows
        .sort((a, b) => a.y - b.y)
        .map((row) => row.cells
          .sort((a, b) => (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0))
          .map((item) => String(item.rawValue || "").trim())
          .join("\t"))
        .join("\n");
      setRoomOpsInput(extracted);
      previewRoomOperationsText(extracted, "photo");
    } catch (error) {
      setMessage(`Photo import error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  useEffect(() => {
    (async () => {
      const allowed = await enforceSessionPreference();
      if (!allowed) {
        window.location.replace("/");
        return;
      }
      try {
        const session = await loadCmpriSession();
        if (!hasCapability(session, "view_dashboard")) {
          window.location.replace(session.landing);
          return;
        }
        setCmpriSession(session);
        lastSeenMsRef.current = readLastSeenTimestamp(session.user.id);
        const soundPreference = readSoundPreference();
        soundEnabledRef.current = soundPreference;
        setSoundEnabled(soundPreference);
      } catch {
        window.location.replace("/");
        return;
      }
      await Promise.all([loadDashboard(), loadRoomOperations()]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => { void loadDashboard(true); void loadRoomOperations(true); }, REFRESH_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!cmpriSession || roleKey(cmpriSession.user.role) !== "engineer") return;
    const userId = cmpriSession.user.id;
    notificationCursorRef.current = readWorkOrderNotificationCursor(userId);
    let current = true;
    const pollNotifications = async () => {
      if (notificationPollInFlightRef.current) return;
      notificationPollInFlightRef.current = true;
      try {
        const session = await getValidSession();
        if (!session?.access_token) throw new Error("Sign in again to load work-order notifications.");
        const cursor = notificationCursorRef.current || readWorkOrderNotificationCursor(userId);
        const result = await fetchWorkOrderNotifications(session.access_token, cursor);
        if (!current) return;
        notificationCursorRef.current = result.checked_at;
        const unseen = unseenWorkOrderNotifications(seenNotificationIdsRef.current, result.notifications);
        if (unseen.length) {
          unseen.forEach((notification) => pendingNotificationIdsRef.current.add(notification.id));
          setWorkOrderNotifications((existing) => mergeWorkOrderNotifications(existing, unseen));
          playAlertTone();
        }
        if (!result.notifications.length && pendingNotificationIdsRef.current.size === 0) {
          saveWorkOrderNotificationCursor(userId, result.checked_at);
        }
        setNotificationError("");
      } catch (error) {
        if (current) setNotificationError(error instanceof Error ? error.message : "Work-order notifications could not be loaded.");
      } finally {
        notificationPollInFlightRef.current = false;
      }
    };
    void pollNotifications();
    const interval = window.setInterval(() => { void pollNotifications(); }, REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(interval);
    };
    // The effect intentionally polls for the active engineer and uses refs for cursor/sound state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpriSession]);

  useEffect(() => {
    if (!cmpriSession) return;
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) return;
        const response = await fetch("/api/profile", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        setChatgptConnected(payload.chatgpt_connection?.connected === true);
      } catch {}
    })();
  }, [cmpriSession]);

  useEffect(() => {
    if (!cmpriSession || !hasCapability(cmpriSession, "review_feedback")) return;
    let current = true;
    const refreshFeedbackCount = async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) return;
        const response = await fetch("/api/feedback?mode=count", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({}));
        if (current && response.ok && Number.isInteger(payload.count) && payload.count >= 0) setNewFeedbackCount(payload.count);
      } catch {}
    };
    void refreshFeedbackCount();
    const interval = window.setInterval(() => void refreshFeedbackCount(), 60_000);
    return () => { current = false; window.clearInterval(interval); };
  }, [cmpriSession]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!previousTitleRef.current) previousTitleRef.current = document.title;
    const baseTitle = previousTitleRef.current;
    document.title = newOrderQueue.length > 0 ? `(${newOrderQueue.length} new) ${baseTitle}` : baseTitle;
    return () => {
      document.title = baseTitle;
    };
  }, [newOrderQueue.length]);

  const closeTopOverlay = useCallback(() => {
    if (activeWorkOrderId) {
      setActiveWorkOrderId("");
      setWorkOrderModalToken("");
      return;
    }
    if (showRoomOpsImport) {
      setShowRoomOpsImport(false);
      return;
    }
    if (showWorkOrderList) {
      setShowWorkOrderList(false);
    }
  }, [activeWorkOrderId, showRoomOpsImport, showWorkOrderList]);

  function handleWorkOrderModalFrameLoad(event: React.SyntheticEvent<HTMLIFrameElement>) {
    workOrderFrameCleanupRef.current?.();
    const frameDocument = event.currentTarget.contentDocument;
    if (!frameDocument) return;
    const handleFrameEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        if (keyEvent.defaultPrevented) return;
        if (frameDocument.querySelector('[role="listbox"], [role="dialog"][aria-modal="true"]')) return;
        const cancelRequest = new Event("cmpri-modal-cancel-request", { cancelable: true });
        const handledByFrame = !frameDocument.dispatchEvent(cancelRequest);
        keyEvent.preventDefault();
        if (!handledByFrame) closeTopOverlay();
        return;
      }
      if (keyEvent.key !== "Tab") return;
      const content = frameDocument.querySelector("main") || frameDocument.body;
      const focusable = Array.from(content.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        keyEvent.preventDefault();
        event.currentTarget.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyEvent.shiftKey && (frameDocument.activeElement === first || frameDocument.activeElement === frameDocument.body || !content.contains(frameDocument.activeElement))) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && (frameDocument.activeElement === last || frameDocument.activeElement === frameDocument.body || !content.contains(frameDocument.activeElement))) {
        keyEvent.preventDefault();
        first.focus();
      }
    };
    frameDocument.addEventListener("keydown", handleFrameEscape);
    workOrderFrameCleanupRef.current = () => frameDocument.removeEventListener("keydown", handleFrameEscape);
    event.currentTarget.focus();
  }

  useEffect(() => {
    if (!showWorkOrderList && !showRoomOpsImport && !activeWorkOrderId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [activeWorkOrderId, showRoomOpsImport, showWorkOrderList]);

  useEffect(() => {
    const overlayOpen = showWorkOrderList || showRoomOpsImport || Boolean(activeWorkOrderId);
    if (!overlayOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (activeWorkOrderId) {
      workOrderModalFrameRef.current?.focus();
    } else {
      dashboardDialogRef.current?.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]",
      )?.focus();
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTopOverlay();
        return;
      }
      if (event.key !== "Tab" || activeWorkOrderId) return;
      const focusable = Array.from(dashboardDialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dashboardDialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dashboardDialogRef.current)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      workOrderFrameCleanupRef.current?.();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [activeWorkOrderId, closeTopOverlay, showRoomOpsImport, showWorkOrderList]);

  useEffect(() => {
    function handleWorkOrderMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || !event.data || event.data.modalToken !== workOrderModalToken) return;
      if (event.data.type === "cmpri-open-related-work-order" && typeof event.data.targetWorkOrderId === "string") {
        openWorkOrder(event.data.targetWorkOrderId);
        return;
      }
      if (event.data.type === "cmpri-work-order-cancelled" || event.data.type === "cmpri-work-order-saved") {
        setActiveWorkOrderId("");
        setWorkOrderModalToken("");
      }
    }
    window.addEventListener("message", handleWorkOrderMessage);
    return () => window.removeEventListener("message", handleWorkOrderMessage);
  }, [workOrderModalToken]);

  const pendingVerification = orders.filter((order) => normalizeStatus(order.status).toLowerCase() === "pending verification");
  const openOrders = filterKpiWorkOrders(orders, "open");
  const inProgress = filterKpiWorkOrders(orders, "progress");
  const urgentHigh = filterKpiWorkOrders(orders, "priority");
  const overdue = filterKpiWorkOrders(orders, "overdue");
  const completed = orders.filter((order) => normalizeStatus(order.status).toLowerCase() === "completed");
  const closed = orders.filter((order) => ["closed", "duplicate", "will not do"].includes(normalizeStatus(order.status).toLowerCase()));
  const moveCount = roomOperations.filter((operation) => operation.moveFrom || operation.moveTo).length;

  const groups: Record<DashboardFilter, WorkOrder[]> = {
    pending: pendingVerification,
    open: openOrders,
    progress: inProgress,
    completed,
    priority: urgentHigh,
    overdue,
    closed,
    all: orders,
  };

  const listFilters = [
    ["open", "Open", openOrders.length],
    ["progress", "In Progress", inProgress.length],
    ["priority", "Urgent / High", urgentHigh.length],
    ["overdue", "Overdue", overdue.length],
  ] as const;

  const normalizedListSearch = listSearchQuery.trim().toLowerCase();
  const filteredListOrders = normalizedListSearch
    ? orders.filter((order) => Object.values(order).some((value) => String(value ?? "").toLowerCase().includes(normalizedListSearch)))
    : groups[filter];

  if (!cmpriSession) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-4 text-white" aria-busy="true">
        <p role="status" className="text-sm text-slate-300">Loading your authorized dashboard…</p>
      </main>
    );
  }

  const isHousekeepingDashboard = roleDisplayName(cmpriSession.user.role) === "Lead Housekeeper";
  const isFullWidthDashboard = ["Front Desk", "Lead Housekeeper"].includes(roleDisplayName(cmpriSession.user.role));

  async function signOut() {
    await signOutDevice();
    router.replace("/");
  }


  return (
    <main className="min-h-screen w-full min-w-0 bg-slate-950 text-white">
      <div className={`mx-auto w-full max-w-none min-w-0 px-3 py-4 sm:px-4 lg:px-6 ${isFullWidthDashboard ? "" : "lg:w-[66vw]"}`}>
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-4">
            <CmpriMark />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">{isHousekeepingDashboard ? "CMPRI Housekeeping" : "CMPRI Engineering"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold tracking-tight">{dashboardTitleForRole(cmpriSession?.user.role || "Engineer")}</h1>
                <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold text-slate-300">Version {BUILD_VERSION}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
                <span className="rounded-full border border-sky-500/40 bg-sky-950/30 px-2.5 py-0.5 font-bold text-sky-200">Moves: {moveCount}</span>
              </div>
              {cmpriSession && <div className="mt-3"><AccountSummary user={cmpriSession.user} /></div>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/room-ranker" className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">Room Ranker</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/preventive-maintenance" className="rounded-lg border border-emerald-400/50 bg-emerald-950/30 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-900/40">Preventive Maintenance</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/purchasing" className="rounded-lg border border-orange-400/50 bg-orange-950/30 px-4 py-2 text-sm font-bold text-orange-100 hover:bg-orange-900/40">Purchasing & Email</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/gss" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">GSS Reports</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/pool-log" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-900/40">Pool Log</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/room-operations" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Daily Room Ops</button>
            <button type="button" onClick={() => setShowRoomOpsImport(true)} className="rounded-lg border border-emerald-400/50 bg-emerald-950/30 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-900/40">Import Room Ops</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/management/equipment" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-900/40">Manage Equipment</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/enseo-assignments" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Enseo Assignments</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/parts" className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">Parts & Vendors</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/import-work-orders" className="rounded-lg border border-fuchsia-400/50 bg-fuchsia-950/30 px-4 py-2 text-sm font-bold text-fuchsia-100 hover:bg-fuchsia-900/40">Import Existing WOs</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/management/rooms" className="rounded-lg border border-indigo-400/50 bg-indigo-950/30 px-4 py-2 text-sm font-bold text-indigo-100 hover:bg-indigo-900/40">Manage Rooms</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/management/users" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Manage Users</button>
            {hasCapability(cmpriSession, "review_feedback") && <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("cmpri-open-modal", { detail: { href: `/feedback?route=${encodeURIComponent(window.location.pathname)}`, title: "Feedback" } }))} className="rounded-lg border border-amber-500/50 bg-amber-950/20 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/30">Feedback{newFeedbackCount > 0 ? ` (${newFeedbackCount})` : ""}</button>}
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/profile" className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700">Manage Profile</button>
            {!chatgptConnected && <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/profile" className="rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Connect ChatGPT</button>}
            <button type="button" onClick={() => { setFilter("all"); setShowWorkOrderList(true); }} className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700">Work Order List</button>
            <button type="button" onClick={openCreateWorkOrder} className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-bold text-slate-100 hover:bg-slate-700">+ Create Work Order</button>
            <button type="button" onClick={() => void signOut()} className="rounded-lg border border-red-400/50 bg-red-950/30 px-4 py-2 text-sm font-bold text-red-100 hover:bg-red-900/40">Sign Out</button>
          </div>
        </header>

        {newOrderQueue.length > 0 && (
          <section role="alert" aria-live="assertive" className="mt-5 rounded-xl border border-emerald-400/50 bg-emerald-950/25 p-4 shadow-lg shadow-emerald-950/20">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400"></span>
                </span>
                <p className="text-sm font-bold text-emerald-100">
                  {newOrderQueue.length} new work order{newOrderQueue.length === 1 ? "" : "s"} arrived
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={toggleSound} aria-pressed={soundEnabled} className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${soundEnabled ? "border-emerald-400/50 bg-emerald-950/40 text-emerald-100 hover:bg-emerald-900/60" : "border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-800"}`}>
                  {soundEnabled ? "Sound on" : "Sound off"}
                </button>
                <button type="button" onClick={dismissNewOrders} className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800">
                  Dismiss all
                </button>
              </div>
            </div>
            <ul className="mt-3 divide-y divide-emerald-500/20 overflow-hidden rounded-lg border border-emerald-500/25 bg-slate-950/60">
              {newOrderQueue.slice(0, 6).map((order) => (
                <li key={order.id}>
                  <button type="button" onClick={() => openNewOrder(order)} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-emerald-950/40">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white">
                        {order.room || "No location"}
                        {order.category ? <span className="ml-2 rounded-full border border-slate-700 px-2 py-0.5 text-[11px] font-medium text-slate-300">{order.category}</span> : null}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-300">{order.issue || "No issue description"}</p>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      {order.priority && <span className={`rounded-full border px-2 py-0.5 font-semibold ${priorityClass(order.priority)}`}>{order.priority}</span>}
                      <span className="rounded-full border border-emerald-400/60 bg-emerald-950/50 px-2 py-0.5 font-semibold text-emerald-100">Open</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {newOrderQueue.length > 6 && (
              <p className="mt-2 text-xs text-emerald-200/80">Showing 6 of {newOrderQueue.length} new. Dismiss to clear the alert.</p>
            )}
          </section>
        )}

        {notificationError && <p role="status" className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/25 p-2.5 text-sm text-amber-100">{notificationError}</p>}
        <WorkOrderNotificationBanner notifications={workOrderNotifications} onDismiss={dismissWorkOrderNotifications} />
        {message && <div className="mt-5 rounded-xl border border-red-400/30 bg-red-950/20 p-4 text-sm text-red-200">{message}</div>}

      </div>

      {showWorkOrderList && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-1">
          <section ref={setDashboardDialogElement} role="dialog" aria-modal="true" aria-labelledby="work-order-list-title" className="cmpri-modal-shell cmpri-dashboard-overlay-panel flex flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:p-5">
              <button type="button" onClick={closeTopOverlay} className="self-start rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">← Dashboard</button>
              <div className="relative">
                <input type="search" value={listSearchQuery} onChange={(event) => setListSearchQuery(event.target.value)} placeholder="Search work orders…" className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 pr-11 text-base text-white outline-none placeholder:text-slate-400 focus:border-amber-400" />
                {listSearchQuery && <button type="button" onClick={() => setListSearchQuery("")} aria-label="Clear work-order search" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white">×</button>}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {listFilters.map(([key, label, value]) => (
                  <button key={key} type="button" onClick={() => setFilter(key)} className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-semibold transition ${filter === key ? "border-amber-400 bg-slate-900 text-amber-300" : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-600"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{label}</span>
                      <span className="text-sm text-white">{loading ? "—" : value}</span>
                    </div>
                  </button>
                ))}
              </div>

              <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
                <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 sm:px-5">
                  {normalizedListSearch && <h3 className="text-xl font-bold">Search Results</h3>}
                  <span className="text-sm text-slate-400">{loading ? "Loading…" : `${filteredListOrders.length} shown`}</span>
                </div>
                <div className="min-h-0 flex-1 divide-y divide-slate-800 overflow-y-auto">
                  {!loading && filteredListOrders.length === 0 && <p className="p-5 text-sm text-slate-400">{normalizedListSearch ? "No work orders match your search." : "No work orders match this filter."}</p>}
                  {filteredListOrders.slice(0, 75).map((order) => (
                    <button type="button" key={order.id} onClick={() => openWorkOrder(order.id)} className="block w-full px-3 py-2.5 text-left hover:bg-slate-800/60 sm:px-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-lg font-bold leading-none text-white">{order.room || "No location"}</span>
                            {order.category && <span className="rounded-full border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">{order.category}</span>}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs font-medium text-slate-200">{order.issue || "No issue description"}</p>
                          {order.asset_name && <p className="mt-0.5 text-[10px] text-slate-500">{order.asset_name}</p>}
                        </div>
                        <div className="shrink-0 text-right text-[10px] text-slate-400">
                          <span className={`inline-flex rounded-full border px-1.5 py-0.5 font-semibold ${statusClass(order.status)}`}>{normalizeStatus(order.status)}</span>
                          <div className="mt-1">{order.technician_name || "Unassigned"}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </section>
        </div>
      )}

      {activeWorkOrderId && workOrderModalToken && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90 p-1">
          <div role="dialog" aria-modal="true" aria-label="Work order detail" className="cmpri-modal-shell cmpri-dashboard-overlay-panel flex overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <iframe
              ref={workOrderModalFrameRef}
              title="Work order detail"
              src={`/work-orders/${encodeURIComponent(activeWorkOrderId)}?embedded=1&modalToken=${encodeURIComponent(workOrderModalToken)}`}
              onLoad={handleWorkOrderModalFrameLoad}
              className="h-full w-full min-w-0 border-0"
              style={{ minHeight: "min(88vh, 60rem)" }}
            />
          </div>
        </div>
      )}

      {showRoomOpsImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-1">
          <div ref={setDashboardDialogElement} role="dialog" aria-modal="true" aria-label="Import Daily Room Operations" className="cmpri-modal-shell cmpri-dashboard-overlay-panel overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="space-y-4 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Room Operations</p><h2 className="mt-1 text-xl font-semibold">Import Daily Room Operations</h2><p className="mt-1 text-sm text-slate-400">Paste spreadsheet rows, import CSV/TSV/TXT, or use a report photo/screenshot when this browser supports local text recognition. Photos are processed on-device, not sent to an AI provider.</p></div>
                <button type="button" onClick={closeTopOverlay} className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">← Dashboard</button>
              </div>
              <label className="block max-w-xs text-xs font-semibold text-slate-300">
                Report date
                <input type="date" required value={roomOpsReportDate} onChange={(event) => { setRoomOpsReportDate(event.target.value); setRoomOpsPreview(null); }} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" />
              </label>
              <textarea value={roomOpsInput} onChange={(event) => { setRoomOpsInput(event.target.value); setRoomOpsPreview(null); }} rows={8} placeholder={"Room\tCheckout Date\tCheckout Time\tRoom Status\tCheck-in Date\tCheck-in Time\tMove From\tMove To\tGuest Name\tRoom Type\tGuest Code\tARV\tLOS\tReserved\n316\t9/15/2026\t11:00 AM\tVacant Dirty\t9/15/2026\t4:00 PM\t316\t412\tGuest Name\tKING\tCODE\t9/12/2026\t3\tYes"} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm text-white outline-none focus:border-amber-400" />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => previewRoomOperationsText(roomOpsInput, "paste")} disabled={roomOpsImportBusy || !roomOpsReportDate} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Preview Pasted Rows</button>
                <label className="cursor-pointer rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Import CSV / TSV / TXT<input type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={(event) => void handleRoomOpsFile(event.target.files?.[0])} /></label>
                <label className="cursor-pointer rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-900/40">Import Photo / Screenshot<input type="file" accept="image/*" className="hidden" onChange={(event) => void handleRoomOpsImage(event.target.files?.[0])} /></label>
              </div>
              {roomOpsPreview && (
                <section aria-label="Validated room-operations preview" className="space-y-3 rounded-xl border border-amber-500/50 bg-amber-950/15 p-3">
                  <div>
                    <h3 className="font-bold text-amber-100">Validated preview · {roomOpsPreview.date} · {roomOpsPreview.rows.length} rows</h3>
                    <p className="mt-1 text-xs text-amber-100">Commit replaces the entire saved snapshot for this report date.</p>
                  </div>
                  <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-700">
                    <table className="w-full min-w-[72rem] text-left text-xs">
                      <thead className="sticky top-0 bg-slate-900 text-slate-300"><tr><th className="p-2">Room</th><th className="p-2">Checkout date</th><th className="p-2">Checkout time</th><th className="p-2">Status</th><th className="p-2">Arrival date</th><th className="p-2">Arrival time</th><th className="p-2">Move from</th><th className="p-2">Move to</th><th className="p-2">Guest</th><th className="p-2">Room type</th><th className="p-2">Guest code</th><th className="p-2">Guest arrival</th><th className="p-2">Nights</th><th className="p-2">Reserved</th></tr></thead>
                      <tbody className="divide-y divide-slate-800">
                        {roomOpsPreview.rows.map((row, index) => <tr key={`${row.room}-${index}`}><td className="p-2">{row.room}</td><td className="p-2">{row.checkout_date || "—"}</td><td className="p-2">{row.checkout_time || "—"}</td><td className="p-2">{row.room_status || "—"}</td><td className="p-2">{row.arrival_date || "—"}</td><td className="p-2">{row.arrival_time || "—"}</td><td className="p-2">{row.move_from || "—"}</td><td className="p-2">{row.move_to || "—"}</td><td className="p-2">{row.guest_name || "—"}</td><td className="p-2">{row.room_type || "—"}</td><td className="p-2">{row.guest_code || "—"}</td><td className="p-2">{row.guest_arrival_date || "—"}</td><td className="p-2">{row.stay_nights}</td><td className="p-2">{row.reserved ? "Yes" : "No"}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" disabled={roomOpsImportBusy} onClick={() => setRoomOpsPreview(null)} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-50">Discard preview</button>
                    <button type="button" disabled={roomOpsImportBusy} onClick={() => void commitRoomOperationsImport()} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">{roomOpsImportBusy ? "Committing…" : "Commit import"}</button>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
