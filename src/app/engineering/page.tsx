"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { DASHBOARD_AI_ACTION, type DashboardAISummary } from "@/lib/ai/dashboard-analysis";
import { BUILD_VERSION } from "@/lib/constants";
import CopyButton from "@/components/CopyButton";

const REFRESH_MS = 30_000;
const AI_DEVICE_ID_STORAGE_KEY = "cmpri:ai-device-id:v1";
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

function normalizeStatus(value?: string | null) {
  return (value || "Open").trim();
}

function isOpenStatus(value?: string | null) {
  const status = normalizeStatus(value).toLowerCase();
  return !["pending verification", "completed", "will not do", "duplicate", "closed", "cancelled", "canceled"].includes(status);
}

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isOverdue(value?: string | null) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date < today;
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
  const start = roomIndex >= 0 ? 1 : 0;
  return rows.slice(start).map((row) => ({
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
    stayNights: stayNightsIndex >= 0 ? Math.max(0, Math.round(Number(String(row[stayNightsIndex] || "").replace(/[^0-9.]/g, "")) || 0)) : 0,
    reserved: reservedIndex >= 0
      ? ["true", "yes", "y", "1", "reserved", "blk"].includes(String(row[reservedIndex] || "").trim().toLowerCase())
      : row.some((cell) => ["reserved", "blk"].includes(String(cell || "").trim().toLowerCase())),
    importedAt: "",
  })).filter((row) => row.room);
}

function roomNumberFromLabel(value?: string | null) {
  return String(value || "").match(/\b\d{2,4}\b/)?.[0] || "";
}

function getOrCreateAiDeviceId() {
  const existing = window.localStorage.getItem(AI_DEVICE_ID_STORAGE_KEY)?.trim() || "";
  if (/^[A-Za-z0-9_-]{16,100}$/.test(existing)) return existing;
  const generated = crypto.randomUUID().replace(/-/g, "_");
  window.localStorage.setItem(AI_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
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
  const [searchQuery, setSearchQuery] = useState("");
  const [aiRefreshMessage, setAiRefreshMessage] = useState("");
  const [aiRefreshing, setAiRefreshing] = useState(false);
  const aiInFlightRef = useRef(false);
  const [aiSummaries, setAiSummaries] = useState<DashboardAISummary[]>([]);
  const [roomOperations, setRoomOperations] = useState<RoomOperation[]>([]);
  const [roomOpsInput, setRoomOpsInput] = useState("");
  const [showRoomOpsImport, setShowRoomOpsImport] = useState(false);
  const [newOrderQueue, setNewOrderQueue] = useState<WorkOrder[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
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
    router.push("/work-orders");
  }

  function playAlertTone() {
    if (!soundEnabled) return;
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
      writeSoundPreference(next);
      if (next) playAlertTone();
      return next;
    });
  }

  function openWorkOrder(workOrderId: string) {
    const preview = orders.find((order) => order.id === workOrderId);
    if (preview) {
      try { window.sessionStorage.setItem(`cmpri:work-order-preview:${workOrderId}`, JSON.stringify(preview)); } catch {}
    }
    router.push(`/work-orders/${encodeURIComponent(workOrderId)}`);
  }

  async function requestAIRefresh() {
    if (aiInFlightRef.current) return;
    aiInFlightRef.current = true;
    setAiRefreshing(true);
    setAiSummaries([]);
    setAiRefreshMessage("Analyzing saved active work orders…");
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in to refresh AI.");
      const response = await fetch("/api/maintenance-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: DASHBOARD_AI_ACTION, device_id: getOrCreateAiDeviceId() }),
      });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.summaries)) throw new Error(payload.error || "AI refresh failed.");
      setAiSummaries(payload.summaries);
      setAiRefreshMessage(payload.summaries.length
        ? `AI-imported summaries refreshed at ${new Date(payload.generated_at).toLocaleTimeString()} for ${payload.summaries.length} saved active work orders.${payload.limited ? " Limited to the 20 most recent eligible records in this batch." : ""} The refresh is audit-recorded by user, device, and timestamp. Review summaries against the work-order records.`
        : "No saved active work orders with issue or note text were found in the latest batch. No AI request was made.");
    } catch (error) {
      setAiRefreshMessage(error instanceof Error ? error.message : "AI refresh failed.");
    } finally {
      aiInFlightRef.current = false;
      setAiRefreshing(false);
    }
  }

  async function loadRoomOperations(silent = false) {
    if (roomOpsInFlightRef.current) return;
    roomOpsInFlightRef.current = true;
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again to load room operations.");
      const response = await fetch("/api/room-operations", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.rows)) throw new Error(payload.error || "Room operations could not be loaded.");
      setRoomOperations(payload.rows.map((row: Record<string, unknown>) => ({
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
      })) as RoomOperation[]);
      if (!silent) setMessage("");
    } catch (error) {
      if (!silent) setMessage(error instanceof Error ? `Room operations error: ${error.message}` : "Room operations error.");
    } finally {
      roomOpsInFlightRef.current = false;
    }
  }

  async function importRoomOperations(rows: RoomOperation[], source: "paste" | "file" | "photo") {
    if (!rows.length) {
      setMessage("No room checkout rows were found. Paste a spreadsheet table with a Room column.");
      return;
    }
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again before importing room operations.");
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, rows }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || "Room operations were not saved.");
      await loadRoomOperations(true);
      setShowRoomOpsImport(false);
      setRoomOpsInput("");
      setMessage(`${payload.count || rows.length} room-operation rows saved to the shared CMPRI daily snapshot.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations import error: ${error.message}` : "Room operations import error.");
    }
  }

  async function handleRoomOpsFile(file?: File | null) {
    if (!file) return;
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setMessage("Export the checkout sheet as CSV/TSV/TXT, or paste the spreadsheet rows.");
      return;
    }
    await importRoomOperations(parseRoomOperationsText(await file.text()), "file");
  }


  async function handleRoomOpsImage(file?: File | null) {
    if (!file) return;
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
      const parsed = parseRoomOperationsText(extracted);
      if (!parsed.length) {
        setMessage("Text was read from the image locally, but no room table could be identified. Review the extracted text in the import box before importing.");
        return;
      }
      await importRoomOperations(parsed, "photo");
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
        setSoundEnabled(readSoundPreference());
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
    if (typeof document === "undefined") return;
    if (!previousTitleRef.current) previousTitleRef.current = document.title;
    const baseTitle = previousTitleRef.current;
    document.title = newOrderQueue.length > 0 ? `(${newOrderQueue.length} new) ${baseTitle}` : baseTitle;
    return () => {
      document.title = baseTitle;
    };
  }, [newOrderQueue.length]);

  const pendingVerification = orders.filter((order) => normalizeStatus(order.status).toLowerCase() === "pending verification");
  const openOrders = orders.filter((order) => isOpenStatus(order.status));
  const inProgress = openOrders.filter((order) => normalizeStatus(order.status).toLowerCase() === "in progress");
  const urgentHigh = openOrders.filter((order) => ["urgent", "high"].includes(String(order.priority || "").toLowerCase()));
  const overdue = openOrders.filter((order) => isOverdue(order.due_by));
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

  const cards = [
    ["pending", "Pending Verification", pendingVerification.length],
    ["open", "Open Work Orders", openOrders.length],
    ["progress", "In Progress", inProgress.length],
    ["completed", "Completed / Awaiting Review", completed.length],
    ["priority", "Urgent / High", urgentHigh.length],
    ["overdue", "Overdue", overdue.length],
    ["closed", "Closed", closed.length],
    ["all", "All Work Orders", orders.length],
  ] as const;

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredOrders = normalizedSearch
    ? orders.filter((order) => Object.values(order).some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch)))
    : groups[filter];



  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-4">
            <CmpriMark />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">CMPRI Engineering</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold tracking-tight">Engineering Dashboard</h1>
                <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold text-slate-300">Version {BUILD_VERSION}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
                <span>Work orders, priorities, assignments, and due work at a glance.</span>
                <span className="rounded-full border border-sky-500/40 bg-sky-950/30 px-2.5 py-0.5 font-bold text-sky-200">Moves: {moveCount}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="/engineering/room-ranker" className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">Room Ranker</a>
            <a href="/engineering/preventive-maintenance" className="rounded-lg border border-emerald-400/50 bg-emerald-950/30 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-900/40">Preventive Maintenance</a>
            {hasCapability(cmpriSession, "operate_integrations") && <a href="/engineering/purchasing" className="rounded-lg border border-orange-400/50 bg-orange-950/30 px-4 py-2 text-sm font-bold text-orange-100 hover:bg-orange-900/40">Purchasing & Email</a>}
            <a href="/engineering/gss" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">GSS Reports</a>
            <a href="/engineering/pool-log" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-900/40">Pool Log</a>
            <a href="/engineering/room-operations" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Daily Room Ops</a>
            {hasCapability(cmpriSession, "edit_tickets") && <button type="button" onClick={() => setShowRoomOpsImport(true)} className="rounded-lg border border-emerald-400/50 bg-emerald-950/30 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-900/40">Import Room Ops</button>}
            {hasCapability(cmpriSession, "manage_assets") && <a href="/management/equipment" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-900/40">Manage Equipment</a>}
            {hasCapability(cmpriSession, "manage_assets") && <a href="/engineering/enseo-assignments" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Enseo Assignments</a>}
            {hasCapability(cmpriSession, "manage_assets") && <a href="/engineering/parts" className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-900/40">Parts & Vendors</a>}
            {hasCapability(cmpriSession, "edit_tickets") && <a href="/engineering/import-work-orders" className="rounded-lg border border-fuchsia-400/50 bg-fuchsia-950/30 px-4 py-2 text-sm font-bold text-fuchsia-100 hover:bg-fuchsia-900/40">Import Existing WOs</a>}
            {hasCapability(cmpriSession, "manage_rooms") && <a href="/management/rooms" className="rounded-lg border border-indigo-400/50 bg-indigo-950/30 px-4 py-2 text-sm font-bold text-indigo-100 hover:bg-indigo-900/40">Manage Rooms</a>}
            {hasCapability(cmpriSession, "manage_users") && <a href="/management/users" className="rounded-lg border border-sky-400/50 bg-sky-950/30 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-900/40">Manage Users</a>}
            <button type="button" onClick={requestAIRefresh} disabled={aiRefreshing} className="rounded-lg border border-purple-400/50 bg-purple-950/30 px-4 py-2 text-sm font-bold text-purple-100 hover:bg-purple-900/40 disabled:opacity-50">{aiRefreshing ? "Refreshing AI…" : "Refresh AI"}</button>
            {hasCapability(cmpriSession, "submit") && <button type="button" onClick={openCreateWorkOrder} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950">+ Create Work Order</button>}
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

        {message && <div className="mt-5 rounded-xl border border-red-400/30 bg-red-950/20 p-4 text-sm text-red-200">{message}</div>}
        {aiRefreshMessage && <div role="status" aria-live="polite" className="mt-5 rounded-xl border border-purple-400/30 bg-purple-950/20 p-4 text-sm text-purple-100">{aiRefreshMessage}</div>}

        {aiSummaries.length > 0 && <section aria-label="AI work-order summaries" className="mt-4 rounded-xl border border-purple-400/30 bg-purple-950/10 p-4">
          <h2 className="font-bold text-purple-100">AI work-order summaries</h2>
          <p className="mt-1 text-xs text-slate-400">AI-imported snapshot from the last manual Refresh AI click. Work-order records are unchanged; the refresh is audit-recorded with user, device, and timestamp.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {aiSummaries.map((item) => <article key={item.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3">
              <div className="flex items-center justify-between gap-2">
                <a className="text-sm font-bold text-purple-200 underline" href={`/work-orders/${encodeURIComponent(item.id)}`}>{item.display_id || item.id}{item.room ? ` · ${item.room}` : ""}</a>
                <CopyButton text={item.summary} label="Copy summary" />
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">{item.summary}</p>
            </article>)}
          </div>
        </section>}

        <section className="mt-5 grid gap-2 sm:grid-cols-4 xl:grid-cols-8">
          {cards.map(([key, label, value]) => {
            const active = filter === key;
            const pending = key === "pending";
            return (
              <button key={key} type="button" onClick={() => setFilter(key)} className={`rounded-xl border px-3 py-3 text-left transition ${pending ? active ? "border-purple-300 bg-purple-950/45 ring-1 ring-purple-400/40" : "border-purple-500/35 bg-purple-950/20 hover:border-purple-400/60" : active ? "border-amber-400 bg-slate-900 ring-1 ring-amber-400/30" : "border-slate-800 bg-slate-900 hover:border-slate-600"}`}>
                <p className={pending ? "text-purple-200" : active ? "text-amber-300" : "text-slate-400"}>{label}</p>
                <p className="mt-1 text-2xl font-bold leading-none">{loading ? "—" : value}</p>
              </button>
            );
          })}
        </section>

        <div className="mt-6 space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-slate-500">Quick View</span>
            <span className="rounded-full border border-slate-700 px-2 py-1 text-slate-300">Unassigned <b className="text-white">{openOrders.filter((order) => !String(order.technician_name || "").trim()).length}</b></span>
            <span className="rounded-full border border-slate-700 px-2 py-1 text-slate-300">Due date set <b className="text-white">{openOrders.filter((order) => !!order.due_by).length}</b></span>
            <span className="rounded-full border border-slate-700 px-2 py-1 text-slate-300">HVAC <b className="text-white">{openOrders.filter((order) => String(order.category || "").toLowerCase() === "hvac").length}</b></span>
          </div>
          <div className="space-y-3">
            <div className="relative">
              <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search…" className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 pr-11 text-base text-white outline-none placeholder:text-slate-400 focus:border-amber-400" />
              {searchQuery && <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white">×</button>}
            </div>

            <section className="rounded-2xl border border-slate-800 bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                <h2 className="text-2xl font-bold">{normalizedSearch ? "Search Results" : cards.find(([key]) => key === filter)?.[1]}</h2>
                <span className="text-sm text-slate-400">{loading ? "Loading…" : `${filteredOrders.length} shown`}</span>
              </div>
              <div className="max-h-[62vh] divide-y divide-slate-800 overflow-y-auto">
                {!loading && filteredOrders.length === 0 && <p className="p-5 text-sm text-slate-400">{normalizedSearch ? "No work orders match your search." : "No work orders match this dashboard filter."}</p>}
                {filteredOrders.slice(0, 75).map((order) => (
                  <button type="button" key={order.id} onClick={() => openWorkOrder(order.id)} className="block w-full px-5 py-4 text-left hover:bg-slate-800/60">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-2xl font-bold leading-none text-white">{order.room || "No location"}</span>
                          {order.category && <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{order.category}</span>}
                        </div>
                        <p className="mt-1 text-sm font-medium text-slate-200">{order.issue || "No issue description"}</p>
                        {(() => {
                          const roomNo = roomNumberFromLabel(order.room);
                          const op = roomOperations.find((item) => item.room === roomNo);
                          return <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                            {op && (op.checkoutDate || op.checkoutTime) && <span className={`rounded-full border px-2 py-0.5 font-semibold ${roomOpsDateClass(op.checkoutDate)}`}>Checkout {op.checkoutTime || op.checkoutDate || "scheduled"}</span>}
                            {op?.roomStatus && <span className={`rounded-full border px-2 py-0.5 font-semibold ${roomStatusClass(op.roomStatus)}`}>{op.roomStatus}</span>}
                            {op?.reserved && <span className="rounded-full border border-indigo-400/45 bg-indigo-950/35 px-2 py-0.5 font-semibold text-indigo-200">Reserved</span>}
                            {op?.guestName && <span className="rounded-full border border-slate-600 bg-slate-950 px-2 py-0.5 font-semibold text-slate-300">Guest: {op.guestName}</span>}
                            {op && (op.roomType || op.guestCode) && <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 font-semibold text-slate-400">{[op.roomType, op.guestCode].filter(Boolean).join(" · ")}</span>}
                            {(op?.arrivalDate || op?.arrivalTime) && <span className={`rounded-full border px-2 py-0.5 font-semibold ${roomOpsDateClass(op.arrivalDate)}`}>Incoming {op.arrivalTime || op.arrivalDate}</span>}
                            {(op?.moveFrom || op?.moveTo) && <span className="rounded-full border border-sky-400/45 bg-sky-950/35 px-2 py-0.5 font-semibold text-sky-200">Move {op.moveFrom || roomNo} → {op.moveTo || "TBD"}</span>}
                            {order.priority && <span className={`rounded-full border px-2 py-0.5 font-semibold ${priorityClass(order.priority)}`}>{order.priority}</span>}
                          </div>;
                        })()}
                        {order.asset_name && <p className="mt-1 text-xs text-slate-500">{order.asset_name}</p>}
                      </div>
                      <div className="shrink-0 text-left text-xs text-slate-400 lg:text-right">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClass(order.status)}`}>{normalizeStatus(order.status)}</span>
                        <div className="mt-1">{order.technician_name || "Unassigned"}</div>
                        <div className={`mt-1 inline-flex rounded-full border px-2 py-0.5 ${isOverdue(order.due_by) ? "border-red-400/50 bg-red-950/40 font-semibold text-red-200" : "border-transparent"}`}>{formatDue(order.due_by)}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>


        </div>
      </div>

      {showRoomOpsImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Room Operations</p><h2 className="mt-1 text-xl font-semibold">Import Daily Room Operations</h2><p className="mt-1 text-sm text-slate-400">Paste spreadsheet rows, import CSV/TSV/TXT, or use a report photo/screenshot when this browser supports local text recognition. Photos are processed on-device, not sent to the AI refresh provider.</p></div><button type="button" onClick={() => setShowRoomOpsImport(false)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Close</button></div>
            <div className="space-y-4 p-5">
              <textarea value={roomOpsInput} onChange={(event) => setRoomOpsInput(event.target.value)} rows={8} placeholder={"Room\tCheckout Date\tCheckout Time\tRoom Status\tCheck-in Date\tCheck-in Time\tMove From\tMove To\tGuest Name\tRoom Type\tGuest Code\tARV\tLOS\tReserved\n316\t9/15/2026\t11:00 AM\tVacant Dirty\t9/15/2026\t4:00 PM\t316\t412\tGuest Name\tKING\tCODE\t9/12/2026\t3\tYes"} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm text-white outline-none focus:border-amber-400" />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void importRoomOperations(parseRoomOperationsText(roomOpsInput), "paste")} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950">Import Pasted Rows</button>
                <label className="cursor-pointer rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Import CSV / TSV / TXT<input type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={(event) => void handleRoomOpsFile(event.target.files?.[0])} /></label>
                <label className="cursor-pointer rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-900/40">Import Photo / Screenshot<input type="file" accept="image/*" className="hidden" onChange={(event) => void handleRoomOpsImage(event.target.files?.[0])} /></label>
              </div>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
