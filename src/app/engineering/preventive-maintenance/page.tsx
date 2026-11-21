"use client";

import { useUiLanguage } from "@/components/UiLanguageProvider";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { loadCmpriSession } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { isPmRoutineCellChecked } from "@/lib/pm/routine-responses";
import { findReferencedPmTemplate } from "@/lib/pm/references";
import { workOrderFormTarget } from "@/lib/pm/work-order-form-target";
import PmRecordedIssues from "@/components/PmRecordedIssues";
import {
  findPmTemplate,
  PM_DAILY_TEMPLATE_ID,
  PM_ROOM_NUMBERS,
  PM_ROOM_TEMPLATE_ID,
  PM_TEMPLATES,
  PM_WEEKLY_TEMPLATE_ID,
  pmWeekDates,
  pmWeekStart,
  quarterPeriodForDate,
  templatePeriodsForWeek,
  type PmFormField,
  type PmTemplate,
} from "@/lib/pm/catalog";

import { taskComplete, taskEditable, taskVisual, type PmTaskState, type PmTaskActor } from "@/lib/pm/task-review";
import { usePmTaskQueue, pmEntryTaskState } from "@/lib/pm/use-task-queue";
import { hasPmFormRecovery, pmFormDraftKey, readPmFormDraft, samePmForm, type PmFormIdentity } from "@/lib/pm/form-workspace";
import { usePmFormWorkspace } from "@/lib/pm/use-form-workspace";
import "./pm-approved.css";

type PmEntry = {
  task_states?: Record<string, PmTaskState>;
  submitted_by?: string;
  submitted_by_name?: string;
  id: string;
  template_id: string;
  period_start: string;
  scope_key: string;
  responses: Record<string, unknown>;
  form_data: Record<string, unknown>;
  notes: string;
  deficiency_notes: string;
  completed_on: string | null;
  is_complete: boolean;
  completed_by_name: string | null;
  work_order_id: string | null;
  revision: number;
  updated_at: string;
  status?: "pending" | "processing" | "approved" | "rejected";
  can_edit_entry?: boolean;
  proposed_cells?: Array<{ sheet: string; row: number; column: number; label: string; expectedValue: string; proposedValue: string }>;
};
type PmReviewProposal = {
  id: string;
  template_id: string;
  period_start: string;
  scope_key: string;
  payload: Record<string, unknown>;
  proposed_cells: Array<{ sheet: string; row: number; column: number; label: string; expectedValue: string; proposedValue: string }>;
  submitted_by_name: string;
  status: "pending" | "processing";
  revision: number;
  created_at: string;
};
type LivePmTarget = { sheet: string; row: number; column: number; label: string; kind: "checkbox" | "completion-date"; value: string; period: string };
type LivePmTask = { id: string; label: string; category: string; source: string; targets: LivePmTarget[] };
type LivePmWorkbook = {
  daily: Record<string, LivePmTask[]>;
  weekly: Record<string, LivePmTask[]>;
  monthly: Record<string, LivePmTask[]>;
  rooms: Array<{ room: string; quarters: Record<string, LivePmTarget | null> }>;
  fetchedAt: string;
};
type PmLocation = { id: string; name: string; room_number: string | null; area: string | null; location_type: string | null };
type PmTab = "week" | "inspections" | "rooms" | "history";
type ActiveForm = PmFormIdentity;
type WorkOrderTarget = { form: ActiveForm | null; locationId: string | null; room: string | null; week: string };
type PendingWorkOrderLink = {
  id: string;
  displayId: string;
  revision: number;
  templateId: string;
  periodStart: string;
  scopeKey: string;
};
type ChecklistState = "complete" | "follow-up" | "na";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_SHEETS = ["JAN", "FEB", "MAR", "APRIL", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"];
const TAB_OPTIONS: Array<{ id: PmTab; label: string }> = [
  { id: "week", label: "Weekly Sheet" },
  { id: "inspections", label: "Inspection Forms" },
  { id: "rooms", label: "Quarterly PM" },
  { id: "history", label: "Maintenance History" },
];

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function sourceDateIso(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== Number(match[1]) || date.getUTCDate() !== Number(match[2])) return "";
  return date.toISOString().slice(0, 10);
}

function dateLabel(value: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }, locale = "en-US") {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale, options);
}

function periodLabel(template: PmTemplate, period: string, locale = "en-US") {
  if (template.cadence === "daily") return dateLabel(period, { month: "long", day: "numeric", year: "numeric" }, locale);
  if (template.cadence === "weekly") {
    const end = new Date(`${period}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${dateLabel(period, undefined, locale)} – ${dateLabel(end.toISOString().slice(0, 10), { month: "short", day: "numeric", year: "numeric" }, locale)}`;
  }
  return dateLabel(period, { month: "long", year: "numeric" }, locale);
}

function entryKey(templateId: string, periodStart: string, scopeKey = "property") {
  return `${templateId}|${periodStart}|${scopeKey}`;
}

function statusText(value: unknown) {
  if (value === true || value === "complete") return "Complete";
  if (value === "follow-up") return "Needs work";
  if (value === "na") return "N/A";
  return "Open";
}

function statusStyle(value: unknown) {
  if (value === true || value === "complete") return "border-emerald-400/35 bg-emerald-950/35 text-emerald-200";
  if (value === "follow-up") return "border-amber-400/40 bg-amber-950/35 text-amber-100";
  if (value === "na") return "border-slate-600 bg-slate-800 text-slate-300";
  return "border-slate-700 bg-slate-950 text-slate-400";
}

function sourceRoutineStatus(template: PmTemplate, period: string, itemId: string, workbook: LivePmWorkbook | null) {
  const item = template.checklist.find((candidate) => candidate.id === itemId);
  if (!item || !workbook) return false;
  const month = MONTH_SHEETS[Number(period.slice(5, 7)) - 1];
  const tasks = template.cadence === "daily"
    ? workbook.daily[period] || []
    : template.cadence === "weekly"
      ? workbook.weekly[month] || []
      : workbook.monthly[month] || [];
  const liveTask = tasks.find((task) => task.label.trim().toLowerCase() === item.label.trim().toLowerCase());
  return isPmRoutineCellChecked(liveTask?.targets || []);
}

function SourceNote({ template }: { template: PmTemplate }) {
  return <span className="text-[11px] text-slate-500">{template.sourceReference}</span>;
}

function LoadingPmDocumentReader() {
  const { t } = useUiLanguage();
  return <p role="status" className="text-sm text-slate-300">{t("Loading document reader…")}</p>;
}

const LocalOcrReview = dynamic(() => import("@/components/LocalOcrReview"), {
  ssr: false,
  loading: LoadingPmDocumentReader,
});

/** OCR is a reference inside the existing form, not a PM save or approval. */
function PmOcrReference() {
  const { t } = useUiLanguage();
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/50 p-3" aria-label={t("Read an inspection document")}>
      <button type="button" aria-expanded={open} aria-controls="pm-ocr-reference" onClick={() => setOpen(value => !value)} className="min-h-10 rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-200">
        {open ? t("Close document reader") : t("Read a document for reference")}
      </button>
      {open && <div id="pm-ocr-reference" className="mt-3 space-y-2">
        <p className="text-xs text-slate-300">{t("Compare recognized text with the original document. Copy only reviewed information into this form. Reading a document does not save, complete, or approve a PM record.")}</p>
        <LocalOcrReview />
      </div>}
    </section>
  );
}

function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PmFormField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useUiLanguage();
  const base = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400 disabled:opacity-50";
  return (
    <label className="block min-w-0">
      <span className="text-xs font-semibold text-slate-300">{t(field.label)}{field.required ? " *" : ""}</span>
      {field.type === "textarea" ? (
        <textarea required={field.required} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} rows={3} className={base} />
      ) : field.type === "select" || field.type === "yes-no" ? (
        <select required={field.required} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} className={base}>
          <option value="">{t("Select…")}</option>
          {(field.type === "yes-no" ? ["Yes", "No"] : field.options || []).map((option) => <option key={option} value={option}>{t(option)}</option>)}
        </select>
      ) : (
        <input required={field.required} disabled={disabled} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={value} onChange={(event) => onChange(event.target.value)} className={base} />
      )}
    </label>
  );
}

function SectionHeading({ eyebrow, title, trailing }: { eyebrow?: string; title: string; trailing?: ReactNode }) {
  const { t } = useUiLanguage();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>{eyebrow && <p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">{t(eyebrow)}</p>}<h2 className="mt-0.5 text-xl font-bold text-white">{t(title)}</h2></div>
      {trailing}
    </div>
  );
}

export default function PreventiveMaintenancePage() {
  const { t, tt, locale } = useUiLanguage();
  const embedded = useEmbeddedModal();
  const router = useRouter();
  const [actor, setActor] = useState<PmTaskActor>({ id: "", name: "", role: "manager" });
  const [frequency, setFrequency] = useState("daily");
  const [phoneDay, setPhoneDay] = useState(0);
  const [poolRequired, setPoolRequired] = useState<string | null>(null);
  const [focusTask, setFocusTask] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [weekStart, setWeekStart] = useState(() => pmWeekStart(todayIso()));
  const [tab, setTab] = useState<PmTab>("week");
  const [entries, setEntries] = useState<PmEntry[]>([]);
  const [liveWorkbook, setLiveWorkbook] = useState<LivePmWorkbook | null>(null);
  const [reviewQueue, setReviewQueue] = useState<PmReviewProposal[]>([]);
  const [locations, setLocations] = useState<PmLocation[]>([]);
  const [accessRoles, setAccessRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [spreadsheetSyncEnabled, setSpreadsheetSyncEnabled] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const [reviewBusyId, setReviewBusyId] = useState("");
  const [roomSearch, setRoomSearch] = useState("");
  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const activeFormRef = useRef<ActiveForm | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [workOrderTarget, setWorkOrderTarget] = useState<WorkOrderTarget | null>(null);
  const openedWorkOrderTarget = useRef(false);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [checklist, setChecklist] = useState<Record<string, ChecklistState>>({});
  const [repeatableRows, setRepeatableRows] = useState<Array<Record<string, string>>>([]);
  const [formNotes, setFormNotes] = useState("");
  const [deficiencyNotes, setDeficiencyNotes] = useState("");
  const [completedOn, setCompletedOn] = useState("");
  const [deficiencyLocationId, setDeficiencyLocationId] = useState("");
  const [pendingWorkOrderLink, setPendingWorkOrderLink] = useState<PendingWorkOrderLink | null>(null);
  const requestSequence = useRef(0);
  const [queueOwner, setQueueOwner] = useState<{ hotelId: string; userId: string } | null>(null);
  const verifiedOwner = useRef<{ hotelId: string; userId: string } | null>(null);
  const [loadedWeek, setLoadedWeek] = useState("");
  const taskQueue = usePmTaskQueue<PmEntry>({
    owner: queueOwner, actor, canEdit, context: { weekStart, frequency, tab, phoneDay },
    onRestoreContext: context => {
      setWeekStart(pmWeekStart(context.weekStart)); setFrequency(context.frequency);
      setTab(context.tab as PmTab); setPhoneDay(context.phoneDay);
    },
    onSaved: saved => setEntries(current => [...current.filter(entry => entryKey(entry.template_id, entry.period_start, entry.scope_key) !== entryKey(saved.template_id, saved.period_start, saved.scope_key)), saved]),
    onError: setError, onPoolRequired: setPoolRequired,
  });
  const today = todayIso();
  const weekDates = useMemo(() => pmWeekDates(weekStart), [weekStart]);
  const weekEnd = weekDates[6];
  const roomTemplate = findPmTemplate(PM_ROOM_TEMPLATE_ID);
  const currentQuarterPeriod = quarterPeriodForDate(weekStart);

  const loadWeek = useCallback(async (week: string, isCurrent: () => boolean = () => true) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to open Preventive Maintenance.");
      const cmpriSession = await loadCmpriSession();
      if (!cmpriSession.capabilities.includes("view_pm")) {
        window.location.replace(cmpriSession.landing);
        return;
      }
      const workOrder = new URLSearchParams(window.location.search).get("workOrder") || "";
      const query = new URLSearchParams({ week });
      if (workOrder) query.set("workOrder", workOrder);
      const response = await fetch(`/api/preventive-maintenance?${query}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: hasPmFormRecovery(localStorage, { hotelId: cmpriSession.hotelId, userId: cmpriSession.user.id }, week) ? "reload" : "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (sequence !== requestSequence.current || !isCurrent()) return;
      if (!response.ok || !Array.isArray(result.entries) || !result.workbook) throw new Error(result.error || "Live PM records could not be loaded.");
      if (result.actor_id !== cmpriSession.user.id) throw new Error("Your account changed while loading PM. Reopen Preventive Maintenance.");
      if (verifiedOwner.current && (verifiedOwner.current.hotelId !== cmpriSession.hotelId || verifiedOwner.current.userId !== cmpriSession.user.id)) {
        activeFormRef.current = null;
        setActiveForm(null);
      }
      verifiedOwner.current = { hotelId: cmpriSession.hotelId, userId: cmpriSession.user.id };
      setQueueOwner({ hotelId: cmpriSession.hotelId, userId: cmpriSession.user.id });
      setEntries(result.entries as PmEntry[]);
      setLiveWorkbook(result.workbook as LivePmWorkbook);
      setReviewQueue(Array.isArray(result.review_queue) ? result.review_queue as PmReviewProposal[] : []);
      setLocations(Array.isArray(result.locations) ? result.locations as PmLocation[] : []);
      if (workOrder && !openedWorkOrderTarget.current) {
        const form = result.linked_form;
        setWorkOrderTarget({
          form: form && typeof form.template_id === "string" && typeof form.period_start === "string" && typeof form.scope_key === "string"
            ? { templateId: form.template_id, periodStart: form.period_start, scopeKey: form.scope_key } : null,
          locationId: typeof result.work_order_location_id === "string" ? result.work_order_location_id : null,
          room: typeof result.work_order_room === "string" ? result.work_order_room : null,
          week,
        });
      }
      setAccessRoles(Array.isArray(result.access_roles) ? result.access_roles.filter((role: unknown): role is string => typeof role === "string") : []);
      setSpreadsheetSyncEnabled(result.spreadsheet_sync_enabled === true);
      setCanEdit(result.can_edit === true || result.can_review === true);
      setCanReview(result.can_review === true);
      setActor({ id: result.actor_id || "", name: result.actor_name || "", role: result.can_review ? "chief" : result.can_edit ? "technician" : "manager" });
      setLoadedWeek(week);
    } catch (cause) {
      if (sequence === requestSequence.current && isCurrent()) setError(cause instanceof Error ? cause.message : "PM records could not be loaded.");
    } finally {
      if (sequence === requestSequence.current && isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      if (!(await enforceSessionPreference())) {
        window.location.replace("/");
        return;
      }
      if (current) await loadWeek(weekStart, () => current);
    })().catch((cause) => {
      if (current) {
        setError(cause instanceof Error ? cause.message : "Unable to verify your session.");
        setLoading(false);
      }
    });
    return () => { current = false; };
  }, [loadWeek, weekStart]);

  const recordsByKey = useMemo(() => new Map(entries.map((entry) => [
    entryKey(entry.template_id, entry.period_start, entry.scope_key),
    entry,
  ])), [entries]);

  const monthTemplates = useMemo(() => PM_TEMPLATES.filter((template) =>
    template.id.startsWith("workbook:monthly:") && templatePeriodsForWeek(template, weekStart).length > 0,
  ), [weekStart]);

  const formPeriods = useMemo(() => PM_TEMPLATES
    .filter((template) => template.kind !== "routine" && template.kind !== "room")
    .flatMap((template) => templatePeriodsForWeek(template, weekStart).map((periodStart) => ({ template, periodStart }))),
  [weekStart]);

  const overallProgress = useMemo(() => {
    const routineTasks = PM_TEMPLATES.filter((template) =>
      template.id === PM_DAILY_TEMPLATE_ID || template.id === PM_WEEKLY_TEMPLATE_ID || monthTemplates.some((month) => month.id === template.id),
    );
    let complete = 0;
    let total = 0;
    for (const template of routineTasks) {
      const periods = templatePeriodsForWeek(template, weekStart);
      for (const period of periods) {
        const entry = recordsByKey.get(entryKey(template.id, period));
        for (const item of template.checklist) {
          total += 1;
          const queued = taskQueue.periods.find(pending => pending.templateId === template.id && pending.periodStart === period)?.changes.find(change => change.itemId === item.id);
          if (queued) { if (taskComplete(queued.desiredState)) complete += 1; continue; }
          const hasSavedResponse = Object.hasOwn(entry?.responses || {}, item.id);
          const useSavedResponse = hasSavedResponse && (entry?.status === "pending" || !spreadsheetSyncEnabled);
          if (useSavedResponse ? entry?.responses?.[item.id] === true : sourceRoutineStatus(template, period, item.id, liveWorkbook)) complete += 1;
        }
      }
    }
    return { complete, total, percent: total ? Math.round((complete / total) * 100) : 0 };
  }, [liveWorkbook, monthTemplates, recordsByKey, spreadsheetSyncEnabled, weekStart, taskQueue.periods]);

  const deficientCount = useMemo(() => entries.reduce((count, entry) =>
    count + Object.values(entry.responses || {}).filter((value) => value === "follow-up").length,
  0), [entries]);

  function entryFor(template: PmTemplate, periodStart: string, scopeKey = "property") {
    return recordsByKey.get(entryKey(template.id, periodStart, scopeKey));
  }

  function roomCompleted(room: string) {
    const proposal = roomTemplate && entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
    if (proposal?.status === "pending" && proposal.completed_on) return true;
    if (!spreadsheetSyncEnabled && proposal) return proposal.is_complete || Boolean(proposal.completed_on);
    const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
    return Boolean(liveWorkbook?.rooms.find((item) => item.room === room)?.quarters[quarter]?.value);
  }

  async function saveEntry(payload: Record<string, unknown>) {
    const verified = await loadCmpriSession();
    if (!queueOwner || verified.user.id !== queueOwner.userId || verified.hotelId !== queueOwner.hotelId || !verified.capabilities.includes("view_pm")) {
      throw new Error("Sign in with the same account and property before saving this PM form. Your draft is kept here.");
    }
    const session = await getValidSession();
    if (!session?.access_token) throw new Error("Sign in again before saving PM.");
    const response = await fetch("/api/preventive-maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.entry) throw new Error(result.error || "PM entry could not be saved.");
    const saved = result.entry as PmEntry;
    setEntries((current) => [
      ...current.filter((entry) => entryKey(entry.template_id, entry.period_start, entry.scope_key) !== entryKey(saved.template_id, saved.period_start, saved.scope_key)),
      saved,
    ]);
    return saved;
  }

  async function reviewProposal(proposal: PmReviewProposal, decision: "approve" | "reject") {
    setReviewBusyId(proposal.id);
    setError("");
    setMessage("");
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again before reviewing PM.");
      const response = await fetch("/api/preventive-maintenance/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ proposalId: proposal.id, decision, expectedRevision: proposal.revision }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.proposal) throw new Error(result.error || "The PM proposal could not be reviewed.");
      setMessage(decision === "approve"
        ? "PM proposal approved."
        : "PM proposal rejected.");
      await loadWeek(weekStart);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The PM proposal could not be reviewed.";
      await loadWeek(weekStart);
      setError(message);
    } finally {
      setReviewBusyId("");
    }
  }

  function updateRoutine(template: PmTemplate, periodStart: string, itemId: string) {
    setError("");
    taskQueue.queue(template, periodStart, itemId, entryFor(template, periodStart));
  }

  function taskState(template: PmTemplate, period: string, itemId: string): PmTaskState | undefined {
    const queued = taskQueue.periods.find(pending => pending.templateId === template.id && pending.periodStart === period)?.changes.find(change => change.itemId === itemId);
    return queued?.desiredState || pmEntryTaskState(entryFor(template, period), template, itemId);
  }

  function locationForScope(scopeKey: string) {
    const room = scopeKey.match(/^room:(\d{2,4})$/)?.[1];
    if (room) return locations.find((location) =>
      String(location.room_number || "").trim() === room || location.name?.match(/\b\d{2,4}\b/)?.[0] === room,
    ) || null;
    return null;
  }

  function openForm(template: PmTemplate, periodStart: string, scopeKey = "property") {
    if (!queueOwner || loading || loadedWeek !== weekStart) return;
    const existing = entryFor(template, periodStart, scopeKey);
    const identity = { templateId: template.id, periodStart, scopeKey };
    activeFormRef.current = identity;
    setActiveForm(identity);
    setFormRevision(existing?.revision || 0);
    setFormData(Object.fromEntries(Object.entries(existing?.form_data || {}).map(([key, value]) => [key, String(value ?? "")])));
    setChecklist(Object.fromEntries(Object.entries(existing?.responses || {}).filter(([, value]) => typeof value === "string") as Array<[string, ChecklistState]>));
    const priorRows = existing?.form_data?.logEntries;
    setRepeatableRows(Array.isArray(priorRows)
      ? priorRows.map((row) => row && typeof row === "object" ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? "")])) : {})
      : template.repeatableFields ? [{}] : []);
    setFormNotes(existing?.notes || "");
    setDeficiencyNotes(existing?.deficiency_notes || "");
    setCompletedOn(existing?.completed_on || "");
    setDeficiencyLocationId(locationForScope(scopeKey)?.id || "");
    setError("");
    setMessage("");
    try {
      const draft = readPmFormDraft(localStorage.getItem(pmFormDraftKey(queueOwner, identity)), queueOwner, identity);
      if (draft) {
        setFormData(draft.formData); setChecklist(draft.checklist); setRepeatableRows(draft.repeatableRows);
        setFormNotes(draft.formNotes); setDeficiencyNotes(draft.deficiencyNotes); setCompletedOn(draft.completedOn);
        setFormRevision(draft.revision);
        setDeficiencyLocationId(locations.some(location => location.id === draft.deficiencyLocationId) ? draft.deficiencyLocationId : "");
        if (draft.revision !== (existing?.revision || 0)) setError("This PM entry changed elsewhere. Your recovered form is kept here with its original revision; saving cannot replace the newer record.");
      }
    } catch { /* Browser storage can be unavailable; normal CMPRI saving remains available. */ }
  }

  useEffect(() => {
    if (!workOrderTarget || loading || openedWorkOrderTarget.current) return;
    const linked = workOrderTarget.form;
    const targetWeek = linked ? pmWeekStart(linked.periodStart) : weekStart;
    if (targetWeek !== weekStart) {
      // Resolve a historical linked form against the records for its period.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWeekStart(targetWeek);
      return;
    }
    // Wait for the selected period's records before opening a saved form.
    if (workOrderTarget.week !== weekStart) return;
    const location = locations.find((item) => item.id === workOrderTarget.locationId);
    const target = workOrderFormTarget(linked, location, PM_ROOM_NUMBERS, PM_ROOM_TEMPLATE_ID, currentQuarterPeriod, workOrderTarget.room);
    const template = target && findPmTemplate(target.templateId);
    openedWorkOrderTarget.current = true;
    if (!target || !template) {
      setMessage("No linked PM form or quarterly guest-room form was found for this work order. Select a form below.");
      return;
    }
    setTab(template.kind === "room" ? "rooms" : "inspections");
    openForm(template, target.periodStart, target.scopeKey);
    if (location) setDeficiencyLocationId(location.id);
  // openForm reads the records and actor loaded for this week; the ref prevents reopening.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workOrderTarget, loading, weekStart, locations, currentQuarterPeriod]);

  useEffect(() => {
    if (!focusTask || loading) return;
    const element = document.getElementById(focusTask);
    if (element) { element.scrollIntoView({ block: "center" }); element.focus(); }
  }, [focusTask, loading, weekStart, tab, phoneDay, frequency]);

  const pendingTasks = entries.flatMap(entry => {
    const template = findPmTemplate(entry.template_id);
    if (!template || template.kind !== "routine") return [];
    return template.checklist.flatMap(item => {
      const state = entry.task_states?.[item.id];
      const pending = state ? state.status === "needs" : entry.status === "pending" && entry.responses?.[item.id] === true;
      return pending ? [{ template, item, period: entry.period_start, name: state?.workerName || entry.submitted_by_name || "" }] : [];
    });
  });
  function focusPendingTask(task: typeof pendingTasks[number]) {
    setWeekStart(pmWeekStart(task.period)); setTab("week"); setFrequency(task.template.cadence);
    setPhoneDay(pmWeekDates(pmWeekStart(task.period)).indexOf(task.period));
    setFocusTask(`pm-task-${task.template.id}-${task.period}-${task.item.id}`); setNotificationsOpen(false);
  }

  const activeTemplate = activeForm ? findPmTemplate(activeForm.templateId) : null;
  const activeScopeKey = activeForm?.scopeKey || "property";
  const activeScopeEntry = activeForm && activeTemplate ? entryFor(activeTemplate, activeForm.periodStart, activeScopeKey) : null;
  const activeCanEdit = canEdit
    && (!["pending", "processing"].includes(activeScopeEntry?.status || "") || activeScopeEntry?.can_edit_entry === true);
  const formContents = useMemo(() => ({ revision: formRevision, formData, checklist, repeatableRows, formNotes, deficiencyNotes, completedOn, deficiencyLocationId }),
    [formRevision, formData, checklist, repeatableRows, formNotes, deficiencyNotes, completedOn, deficiencyLocationId]);
  const { persist: persistFormWorkspace } = usePmFormWorkspace({
    owner: queueOwner, loadedWeek: loading ? "" : loadedWeek, weekStart, activeForm, contents: formContents, canEdit: activeCanEdit,
    preferWorkOrder: Boolean(workOrderTarget || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("workOrder"))),
    onSelectWeek: setWeekStart,
    onRestore: identity => {
      const template = findPmTemplate(identity.templateId);
      if (!template) return;
      setTab(template.kind === "room" ? "rooms" : "inspections");
      openForm(template, identity.periodStart, identity.scopeKey);
    },
    onError: setError,
  });
  const followUpItems = activeTemplate?.checklist.filter((item) => checklist[item.id] === "follow-up") || [];
  const pendingLinkMatchesForm = Boolean(
    pendingWorkOrderLink && activeForm && activeTemplate
    && pendingWorkOrderLink.templateId === activeTemplate.id
    && pendingWorkOrderLink.periodStart === activeForm.periodStart
    && pendingWorkOrderLink.scopeKey === activeScope(activeTemplate, activeForm.scopeKey),
  );

  function activeScope(template: PmTemplate, sourceScope: string) {
    if (template.scope === "room") return sourceScope;
    if (template.scope === "equipment") {
      const identifier = formData.unitIdentifier || formData.location || "";
      return identifier.trim() ? `equipment:${identifier.trim().toLowerCase()}` : sourceScope;
    }
    return sourceScope;
  }

  function validateActive(isComplete: boolean) {
    if (!activeTemplate || !activeForm) return "Select a PM form first.";
    for (const field of isComplete ? activeTemplate.fields : []) {
      if (field.required && !String(formData[field.id] || "").trim()) return `${field.label} is required.`;
    }
    if (isComplete && activeTemplate.checklist.some((item) => !checklist[item.id])) {
      return "Mark each checklist item complete, needs follow-up, or not applicable before finishing.";
    }
    if (isComplete && activeTemplate.repeatableFields?.length) {
      if (!repeatableRows.length) return `Add at least one ${activeTemplate.repeatableLabel?.toLowerCase() || "inspection record"}.`;
      const missing = repeatableRows.some((row) => activeTemplate.repeatableFields!.some((field) => field.required && !String(row[field.id] || "").trim()));
      if (missing) return "Complete the required fields in each inspection row before finishing.";
    }
    if (isComplete && activeTemplate.kind === "room" && !completedOn) return "Enter the room PM completion date.";
    if (isComplete && followUpItems.length && !deficiencyNotes.trim()) return "Describe the deficiencies and the follow-up plan.";
    return "";
  }

  async function persistActive(isComplete: boolean, workOrderId?: string | null, revisionOverride?: number) {
    if (!activeTemplate || !activeForm) throw new Error("Select a PM form first.");
    const problem = validateActive(isComplete);
    if (problem) throw new Error(problem);
    const scopeKey = activeScope(activeTemplate, activeForm.scopeKey);
    const existing = entryFor(activeTemplate, activeForm.periodStart, scopeKey)
      || (scopeKey !== activeForm.scopeKey ? entryFor(activeTemplate, activeForm.periodStart, activeForm.scopeKey) : undefined);
    const formValues: Record<string, unknown> = { ...formData };
    if (activeTemplate.repeatableFields) formValues.logEntries = repeatableRows;
    const saved = await saveEntry({
      templateId: activeTemplate.id,
      periodStart: activeForm.periodStart,
      scopeKey,
      responses: checklist,
      formData: formValues,
      notes: formNotes,
      deficiencyNotes,
      completedOn: completedOn || null,
      isComplete,
      expectedRevision: revisionOverride ?? formRevision,
      workOrderId: workOrderId === undefined ? existing?.work_order_id || null : workOrderId,
    });
    if (queueOwner) {
      try {
        const key = pmFormDraftKey(queueOwner, activeForm);
        const stored = readPmFormDraft(localStorage.getItem(key), queueOwner, activeForm);
        // An acknowledged save may finish after the nested form closes. Advance only
        // the exact saved draft, retaining edits made in this or another window.
        if (stored && stored.revision === formRevision
          && JSON.stringify([stored.formData, stored.checklist, stored.repeatableRows, stored.formNotes, stored.deficiencyNotes, stored.completedOn, stored.deficiencyLocationId])
          === JSON.stringify([formData, checklist, repeatableRows, formNotes, deficiencyNotes, completedOn, deficiencyLocationId])) {
          localStorage.setItem(key, JSON.stringify({ ...stored, revision: saved.revision }));
        }
      } catch { /* The current form and explicit save remain available. */ }
    }
    if (activeFormRef.current && samePmForm(activeFormRef.current, activeForm)) {
      activeFormRef.current = { ...activeForm, scopeKey: saved.scope_key };
      setActiveForm(activeFormRef.current);
      setFormRevision(saved.revision);
    }
    return saved;
  }

  async function saveActive(isComplete: boolean) {
    if (!activeCanEdit) return;
    setSavingKey("active-form");
    setError("");
    setMessage("");
    try {
      await persistActive(isComplete);
      setMessage(isComplete
        ? `${activeTemplate?.title || "PM form"} saved.`
        : "PM draft saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PM form could not be saved.");
    } finally {
      setSavingKey("");
    }
  }

  const draftRemoteSave = useRef<() => Promise<unknown>>(async () => {});
  const draftSession = useRef({ key: "", signature: "" });
  const draftFlush = useRef<() => void>(() => {});
  useEffect(() => { draftRemoteSave.current = () => persistActive(false); });
  useEffect(() => {
    if (!activeForm || !queueOwner || !activeCanEdit) { draftFlush.current = () => {}; draftSession.current.key = ""; return; }
    const key = pmFormDraftKey(queueOwner, activeForm);
    const signature = JSON.stringify({ formData, checklist, repeatableRows, formNotes, deficiencyNotes, completedOn });
    if (draftSession.current.key !== key) draftSession.current = { key, signature };
    const flush = () => {
      persistFormWorkspace();
      if (draftSession.current.signature === signature) return;
      void draftRemoteSave.current().then(() => { draftSession.current.signature = signature; }).catch(() => {
        // Incomplete equipment drafts may not yet have an identity. Retain them locally.
      });
    };
    draftFlush.current = flush;
    let timer: ReturnType<typeof setTimeout>;
    const restart = () => { clearTimeout(timer); timer = setTimeout(flush, 300_000); };
    restart();
    const events = ["pointerdown", "keydown", "input", "scroll"];
    events.forEach(event => window.addEventListener(event, restart, true));
    return () => { clearTimeout(timer); events.forEach(event => window.removeEventListener(event, restart, true)); };
  }, [activeForm, queueOwner, activeCanEdit, formData, checklist, repeatableRows, formNotes, deficiencyNotes, completedOn, persistFormWorkspace]);

  async function createWorkOrderFromDeficiency() {
    if (!activeCanEdit) return;
    if (!activeTemplate || !activeForm || !deficiencyNotes.trim()) {
      setError("Record the deficiency details before creating a work order.");
      return;
    }
    if (!deficiencyLocationId) {
      setError("Select the room or location for the work order.");
      return;
    }
    setSavingKey("work-order");
    setError("");
    setMessage("");
    try {
      const prior = await persistActive(false);
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again before creating the work order.");
      const issue = `PM deficiency: ${activeTemplate.title}`;
      const detail = [
        `PM form: ${activeTemplate.title}`,
        `Source: ${activeTemplate.sourceReference}`,
        `Scheduled period: ${periodLabel(activeTemplate, activeForm.periodStart)}`,
        followUpItems.length ? `Checklist deficiencies: ${followUpItems.map((item) => item.label).join("; ")}` : "",
        `Follow-up notes: ${deficiencyNotes.trim()}`,
      ].filter(Boolean).join("\n");
      const response = await fetch("/api/work-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ orders: [{ location_id: deficiencyLocationId, issue, notes: detail, category: "General", priority: "High" }] }),
      });
      const result = await response.json().catch(() => ({}));
      const created = Array.isArray(result.work_orders) ? result.work_orders[0] : null;
      if (!response.ok || !created?.id) throw new Error(result.error || "The PM deficiency work order could not be created.");
      const pending = {
        id: String(created.id),
        displayId: String(created.display_id || created.id),
        revision: prior.revision,
        templateId: activeTemplate.id,
        periodStart: activeForm.periodStart,
        scopeKey: prior.scope_key,
      };
      setPendingWorkOrderLink(pending);
      try {
        await persistActive(false, pending.id, pending.revision);
        setPendingWorkOrderLink(null);
        setMessage(`Work order ${pending.displayId} created and linked to this PM entry.`);
      } catch (linkError) {
        setMessage(`Work order ${pending.displayId} was created, but linking it to the PM entry failed. Retry the link below.`);
        throw linkError;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Work order could not be created.");
    } finally {
      setSavingKey("");
    }
  }

  async function retryPendingWorkOrderLink() {
    if (!pendingWorkOrderLink) return;
    setSavingKey("work-order");
    setError("");
    try {
      await persistActive(false, pendingWorkOrderLink.id, pendingWorkOrderLink.revision);
      setPendingWorkOrderLink(null);
      setMessage(`Work order ${pendingWorkOrderLink.displayId} linked to this PM entry.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The work order could not be linked to this PM entry.");
    } finally {
      setSavingKey("");
    }
  }

  function openLinkedWorkOrder(id: string) {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: "cmpri-open-related-work-order",
        targetWorkOrderId: id,
        modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
      }, window.location.origin);
      return;
    }
    router.push(`/work-orders/${encodeURIComponent(id)}`);
  }

  function changeWeek(offset: number) {
    const date = new Date(`${weekStart}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset * 7);
    setWeekStart(date.toISOString().slice(0, 10));
  }

  const [exportingExcel, setExportingExcel] = useState(false);
  async function downloadExcel() {
    setExportingExcel(true); setError("");
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again before exporting PM.");
      const records = [...entries];
      if (activeForm && activeTemplate) {
        const scope = activeScope(activeTemplate, activeForm.scopeKey);
        const index = records.findIndex(e => e.template_id === activeForm.templateId && e.period_start === activeForm.periodStart && e.scope_key === scope);
        const draft = { ...activeScopeEntry, template_id: activeForm.templateId, period_start: activeForm.periodStart, scope_key: scope,
          responses: checklist, form_data: { ...formData, logEntries: repeatableRows }, notes: formNotes,
          deficiency_notes: deficiencyNotes, completed_on: completedOn || null, is_complete: false, status: "Current form (unsaved)" };
        if (index >= 0) records.splice(index, 1);
        records.push(draft as unknown as PmEntry);
      }
      const response = await fetch("/api/preventive-maintenance/export", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ week: weekStart, entries: records }) });
      if (!response.ok) throw new Error((await response.json()).error || "Excel export failed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `cmpri-pm-${weekStart}.xlsx`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Excel exported in ${(Number(response.headers.get("X-PM-Export-Duration-Ms")) / 1000).toFixed(2)} seconds.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Excel export failed."); }
    finally { setExportingExcel(false); }
  }

  function downloadTransfer() {
    const rows: string[][] = [["Date / period", "Cadence", "Form / task", "Scope", "Status", "Completion date", "Notes / deficiency", "Source", "Review status"]];
    const routineTemplates = PM_TEMPLATES.filter((template) =>
      template.id === PM_DAILY_TEMPLATE_ID || template.id === PM_WEEKLY_TEMPLATE_ID || monthTemplates.some((month) => month.id === template.id),
    );
    for (const template of routineTemplates) {
      for (const period of templatePeriodsForWeek(template, weekStart)) {
        const entry = entryFor(template, period);
        for (const item of template.checklist) {
          rows.push([
            period,
            template.cadence,
            item.label,
            item.category || "Property",
            statusText(routineStatus(template, period, item.id)),
            entry?.completed_on || "",
            entry?.notes || "",
            item.source || template.sourceReference,
            entry?.task_states?.[item.id]?.status || (entry?.status === "pending" ? "Pending review" : spreadsheetSyncEnabled ? "Current workbook" : "CMPRI only; sheet sync disabled"),
          ]);
        }
      }
    }
    for (const { template, periodStart } of formPeriods) {
      const scoped = entries.filter((entry) => entry.template_id === template.id && entry.period_start === periodStart);
      const records = scoped.length ? scoped : [undefined];
      for (const entry of records) {
        for (const item of template.checklist) {
          rows.push([
            periodStart,
            template.cadence,
            `${template.title}: ${item.label}`,
            entry?.scope_key || template.scope,
            statusText(entry?.responses?.[item.id]),
            entry?.completed_on || "",
            entry?.deficiency_notes || entry?.notes || "",
            item.source || template.sourceReference,
            entry?.status === "pending" ? "Pending review" : entry?.status === "approved" ? "Approved in CMPRI" : "Open",
          ]);
        }
        if (!template.checklist.length) rows.push([periodStart, template.cadence, template.title, entry?.scope_key || template.scope, entry?.is_complete ? "Complete" : "Open", entry?.completed_on || "", entry?.deficiency_notes || entry?.notes || "", template.sourceReference, entry?.status === "pending" ? "Pending review" : entry?.status === "approved" ? "Approved in CMPRI" : "Open"]);
      }
    }
    if (roomTemplate) {
      for (const room of PM_ROOM_NUMBERS) {
        const entry = entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
        const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
        const sourceDate = liveWorkbook?.rooms.find((item) => item.room === room)?.quarters[quarter]?.value || "";
        rows.push([currentQuarterPeriod, "quarterly", roomTemplate.title, `Room ${room}`, roomCompleted(room) ? "Complete" : "Open", entry?.completed_on || (spreadsheetSyncEnabled ? sourceDateIso(sourceDate) : ""), entry?.deficiency_notes || entry?.notes || "", roomTemplate.sourceReference, entry?.status === "pending" ? "Pending review" : spreadsheetSyncEnabled ? "Current workbook" : "CMPRI only; sheet sync disabled"]);
      }
    }
    const csv = rows.map((row) => row.map((cell) => `"${String(cell || "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cmpri-pm-${weekStart}-transfer.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const dailyTemplate = findPmTemplate(PM_DAILY_TEMPLATE_ID)!;
  const weeklyTemplate = findPmTemplate(PM_WEEKLY_TEMPLATE_ID)!;
  const dailyCount = dailyTemplate.checklist.length * weekDates.length;
  const openInspectionCount = formPeriods.filter(({ template, periodStart }) =>
    !entries.some((entry) => entry.template_id === template.id && entry.period_start === periodStart && entry.is_complete),
  ).length;
  const filteredRooms = PM_ROOM_NUMBERS.filter((room) => room.includes(roomSearch.trim()));

  function openRoutineReference(reference: string | null | undefined, period: string, weekly = false) {
    const template = findReferencedPmTemplate(reference, PM_TEMPLATES);
    if (!template) return;
    const formPeriod = template.cadence === "weekly" ? weekStart : period;
    openForm(template, formPeriod);
    if (weekly && template.kind === "meeting") setTab("week");
  }

  function inspectionCard(template: PmTemplate, periodStart: string) {
    const saved = entries.filter((entry) => entry.template_id === template.id && entry.period_start === periodStart);
    const newScope = template.scope === "equipment" ? "property" : template.scope === "area" ? "area:property" : "property";
    const existingSingle = saved.find((entry) => entry.scope_key === newScope);
    const linkedFinal = entries.some(entry => {
      const routine = findPmTemplate(entry.template_id);
      return routine?.cadence === "weekly" && entry.period_start === pmWeekStart(periodStart)
        && routine.checklist.some(item => findReferencedPmTemplate(item.source, PM_TEMPLATES)?.id === template.id && entry.task_states?.[item.id]?.attachedFormStatus === "final");
    });
    const complete = linkedFinal || saved.some((entry) => entry.is_complete);
    return (
      <article key={`${template.id}:${periodStart}`} className="pm-inspection-card rounded-xl border border-slate-800 bg-slate-950/70 p-2.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-bold text-white">{t(template.title)}</h3>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-300">{t(template.cadence)}</span>
              {complete && <span className="rounded-full border border-emerald-500/30 bg-emerald-950/30 px-2 py-0.5 text-[10px] font-bold text-emerald-200">{t("Complete")}</span>}
            </div>
            <p className="mt-0.5 text-xs text-slate-400">{periodLabel(template, periodStart, locale)} · {t(template.scope)}</p>
            {saved.filter((entry) => entry.scope_key !== newScope).map((entry) => (
              <button key={entry.id} type="button" onClick={() => openForm(template, periodStart, entry.scope_key)} className="ml-2 mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400">{entry.scope_key.replace(/^[^:]+:/, "")}{entry.is_complete ? t(" · done") : t(" · open")}</button>
            ))}
          </div>
          {canReview && reviewQueue.filter(proposal => proposal.template_id === template.id && proposal.period_start === periodStart).map(proposal => <button key={proposal.id} type="button" disabled={reviewBusyId === proposal.id} onClick={() => void reviewProposal(proposal, "approve")} className="rounded-lg border border-slate-600 px-3 py-2 text-red-400">{t("✓ Approve")}{" "}{proposal.scope_key.replace(/^[^:]+:/, "")}</button>)}
          <button type="button" onClick={() => openForm(template, periodStart, existingSingle?.scope_key || newScope)} className="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-bold text-slate-950">{!canEdit || (["pending", "processing"].includes(existingSingle?.status || "") && !existingSingle?.can_edit_entry) ? t("View form") : existingSingle ? t("Open form") : template.scope === "equipment" ? t("Add inspection") : t("Open form")}</button>
        </div>
      </article>
    );
  }

  function routineStatus(template: PmTemplate, period: string, itemId: string) {
    const queued = taskQueue.periods.find(pending => pending.templateId === template.id && pending.periodStart === period)?.changes.find(change => change.itemId === itemId);
    if (queued) return taskComplete(queued.desiredState);
    const proposal = entryFor(template, period);
    if (proposal?.task_states?.[itemId]) return taskComplete(proposal.task_states[itemId]);
    if (proposal?.status === "pending" && Object.hasOwn(proposal.responses || {}, itemId)) {
      return proposal.responses[itemId] === true;
    }
    if (!spreadsheetSyncEnabled && Object.hasOwn(proposal?.responses || {}, itemId)) {
      return proposal?.responses[itemId] === true;
    }
    return sourceRoutineStatus(template, period, itemId, liveWorkbook);
  }

  function renderRoutineTable(template: PmTemplate, periods: string[], heading: string, linkedReference?: (itemId: string) => string | null, history = false) {
    const savingFor = (period: string) => taskQueue.flushing || savingKey === entryKey(template.id, period);
    return (
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table data-phone-daily={template.cadence === "daily" || undefined} className="pm-task-table w-full min-w-[760px] border-collapse text-left">
          <thead className="bg-slate-900 text-xs text-slate-400">
            <tr><th className="sticky left-0 min-w-[270px] bg-slate-900 px-3 py-3">{t(heading)}</th>{periods.map((period, index) => <th key={period} data-current-day={periods.indexOf(period) === phoneDay || undefined} className="min-w-20 px-2 py-3 text-center">{template.cadence === "daily" ? <><span className="block font-bold text-white">{t(DAY_LABELS[index])}</span><span>{dateLabel(period, undefined, locale)}</span></> : <span>{periodLabel(template, period, locale)}</span>}</th>)}</tr>
          </thead>
          <tbody>
            {template.checklist.map((item, index) => {
              const reference = linkedReference?.(item.id) || null;
              return (
              <tr key={item.id} className="border-t border-slate-800/80 hover:bg-slate-900/50">
                <th scope="row" className="sticky left-0 bg-slate-950 px-3 py-2.5 text-sm font-medium text-slate-200">
                  {item.category && <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{t(item.category)}</span>}
                  {t(item.label)}
                  {findReferencedPmTemplate(reference, PM_TEMPLATES) && <button type="button" onClick={() => openRoutineReference(reference, periods[0], template.cadence === "weekly")} className="ml-2 text-[10px] font-bold text-emerald-300 hover:underline">{t("Open attached form")}</button>}
                </th>
                {periods.map((period) => {
                  const state = taskState(template, period, item.id);
                  const visual = taskVisual(state, actor);
                  const hasPending = visual === "needs";
                  return (
                    <td key={period} data-current-day={periods.indexOf(period) === phoneDay || undefined} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        role="checkbox"
                        id={`${history ? "pm-history" : "pm-task"}-${template.id}-${period}-${item.id}`}
                        data-preview-status={visual}
                        aria-checked={visual !== "empty"}
                        aria-label={t("{value0} · {value1}{value2}", { value0: t(item.label), value1: dateLabel(period, { month: "long", day: "numeric", year: "numeric" }, locale), value2: hasPending ? t(" · pending review") : "" })}
                        disabled={!canEdit || !taskEditable(state, actor) || !liveWorkbook || savingFor(period)}
                        onClick={() => void updateRoutine(template, period, item.id)}
                        className={`grid h-9 w-9 place-items-center rounded-lg border mx-auto transition ${hasPending ? "border-amber-400 bg-amber-400/15 text-amber-200" : visual === "approved" ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-600 bg-slate-900 text-transparent hover:border-emerald-400"} disabled:cursor-wait disabled:opacity-50`}
                        title={tt("{value0}{value1}", { value0: visual === "needs" ? t("Needs approval") : visual === "approved" ? t("Approved") : t("Not checked"), value1: state?.workerName ? t(" · Completed by {name}", { name: state.workerName }) : "" })}
                      >✓</button>
                    </td>
                  );
                })}
                <td className="sr-only">{index}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const dailyDone = dailyTemplate.checklist.reduce((sum, item) =>
    sum + weekDates.filter((date) => routineStatus(dailyTemplate, date, item.id)).length, 0,
  );
  const monthRoutineDone = monthTemplates.reduce((sum, template) => {
    const period = templatePeriodsForWeek(template, weekStart)[0];
    return sum + template.checklist.filter((item) => routineStatus(template, period, item.id)).length;
  }, 0);
  const monthRoutineTotal = monthTemplates.reduce((sum, template) => sum + template.checklist.length, 0);

  return (
    <main data-pm-mobile="true" data-cmpri-action-surface className="min-h-screen bg-slate-950 text-white">
      <div inert={Boolean(poolRequired)} className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5 lg:px-7">
        {!embedded && <header className="mb-3">
          <h1 className="text-xl font-bold">{t("Preventive Maintenance")}</h1>
        </header>}
        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-2 sm:p-3" aria-label={t("Week controls")}>
          <div className="pm-toolbar">
            <div className="pm-date-controls">
              <button type="button" aria-label={t("Previous week")} onClick={() => changeWeek(-1)}>‹</button>
              <label><span className="sr-only">{t("Week beginning")}</span><input type="date" value={weekStart} onChange={(event) => event.target.value && setWeekStart(pmWeekStart(event.target.value))} /></label>
              <button type="button" aria-label={t("Next week")} onClick={() => changeWeek(1)}>›</button>
            </div>
            <div className="pm-toolbar-actions">
              {canReview && <button type="button" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(value => !value)}>{t("Needs Approval (")}{pendingTasks.length})</button>}
              <button type="button" onClick={downloadTransfer}>{t("Export Weekly CSV")}</button>

            </div>
          </div>
          <div className="pm-date-caption">
            <button type="button" disabled={exportingExcel} onClick={() => void downloadExcel()}>{exportingExcel ? t("Exporting…") : t("Export Excel")}</button><span>{dateLabel(weekStart, { month: "long", day: "numeric", year: "numeric" }, locale)} – {dateLabel(weekEnd, { month: "long", day: "numeric", year: "numeric" }, locale)}</span><button type="button" onClick={() => setWeekStart(pmWeekStart(today))}>{t("This week")}</button></div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">{t("Routine items checked")}</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{overallProgress.complete}<span className="text-sm font-medium text-slate-500"> / {overallProgress.total}</span></p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">{t("Weekly progress")}</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{overallProgress.percent}%</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">{t("Forms still open")}</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{openInspectionCount}</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">{t("Needs follow-up")}</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold text-amber-200">{deficientCount}</p></div>
          </div>
        </section>

        {taskQueue.periods.length > 0 && <div className="my-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/40 p-3 text-sm" role="status">
          <span>{taskQueue.flushing ? t("Saving PM changes…") : t("{value0} PM changes queued. They save when this window closes.", { value0: taskQueue.periods.reduce((count, period) => count + period.changes.length, 0) })}</span>
          <button type="button" disabled={taskQueue.flushing} className="rounded border border-slate-500 px-3 py-1.5" onClick={() => void taskQueue.flush().catch(cause => setError(cause instanceof Error ? cause.message : "PM changes could not be saved."))}>{t("Save queued changes")}</button>
          <button type="button" disabled={taskQueue.flushing} className="rounded border border-slate-500 px-3 py-1.5" onClick={() => taskQueue.discard()}>{t("Discard queued changes")}</button>
        </div>}

        {canReview && notificationsOpen && <section aria-label={t("PM approvals")} className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-600 p-2">{pendingTasks.length ? pendingTasks.map(task => <button key={`${task.template.id}-${task.period}-${task.item.id}`} type="button" className="block w-full p-2 text-left" onClick={() => focusPendingTask(task)} title={tt("{value0} · Completed by {value1}", { value0: task.period, value1: task.name })}>{t("Needs Review:")}{" "}{t(task.item.label)} · {dateLabel(task.period, undefined, locale)}</button>) : <p>{t("No tasks awaiting review.")}</p>}</section>}

        <nav className="pm-section-tabs" aria-label={t("PM sections")}>
          {TAB_OPTIONS.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)} className={`shrink-0 rounded-lg px-4 py-2 text-sm font-bold transition ${tab === item.id ? "bg-emerald-400 text-slate-950" : "border border-slate-800 text-slate-300 hover:bg-slate-900"}`}>{t(item.label)}</button>)}
        </nav>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">{t(error)}</div>}
        {message && !activeForm && <div role="status" className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/25 p-3 text-sm text-emerald-100">{t(message)}</div>}
        {!canEdit && !loading && !error && <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-sm text-amber-100">{t("The PM service resolved this session as read-only")}{accessRoles.length ? t(" (roles: {value0})", { value0: accessRoles.join(", ") }) : ""}{t(". If you are a System Administrator, this role result is incorrect and should be reported to an administrator.")}</div>}


        {tab === "week" && (
          <div className="pm-routines mt-5 space-y-7">
            <div className="phone-switch">{["daily", "weekly", "monthly", "history"].map(value => <button key={value} type="button" aria-pressed={frequency === value} onClick={() => setFrequency(value)}>{value}</button>)}</div>
            {frequency === "daily" && <div className="phone-days">{weekDates.map((date, index) => <button key={date} type="button" aria-pressed={phoneDay === index} onClick={() => setPhoneDay(index)}>{t(DAY_LABELS[index])}<small>{dateLabel(date, undefined, locale)}</small></button>)}</div>}
            <section className={frequency !== "daily" ? "pm-phone-hidden" : ""}>
              <div className="pm-legend"><span><i className="legend-red">✓</i>{" "}{t("Needs approval")}</span><span><i className="legend-green">✓</i>{" "}{t("Approved")}</span></div>
              <SectionHeading eyebrow={t("Workbook · daily checkbox grid")} title={tt("Daily maintenance")} trailing={<span className="text-xs text-slate-400">{dailyDone} / {dailyCount}{" "}{t("complete")}</span>} />
              <p className="mb-3 mt-1 text-xs text-slate-500">{t("Checkbox changes save together when this window closes. Pool readings are entered in the Pool Log, with a shortcut from its linked form below.")}</p>
              {renderRoutineTable(dailyTemplate, weekDates, "Routine task")}
            </section>

            <section className={frequency !== "weekly" ? "pm-phone-hidden" : ""}>
              <SectionHeading eyebrow={t("Live workbook · one completion per week")} title={tt("Weekly maintenance")} trailing={<span className="text-xs text-slate-400">{weeklyTemplate.checklist.filter((item) => routineStatus(weeklyTemplate, weekStart, item.id)).length} / {weeklyTemplate.checklist.length}{" "}{t("complete")}</span>} />
              <div className="mt-3">
                {renderRoutineTable(weeklyTemplate, [weekStart], "Weekly task", (itemId) => weeklyTemplate.checklist.find((item) => item.id === itemId)?.source?.endsWith(".pdf") ? weeklyTemplate.checklist.find((item) => item.id === itemId)!.source! : null)}
              </div>
            </section>

            {monthTemplates.map((template) => {
              const period = templatePeriodsForWeek(template, weekStart)[0];
              return (
                <section key={template.id} className={frequency !== "monthly" ? "pm-phone-hidden" : ""}>
                  <SectionHeading eyebrow={t("{value0} · workbook checkboxes", { value0: template.title })} title={tt("{value0} monthly tasks", { value0: dateLabel(period, { month: "long", year: "numeric" }, locale) })} trailing={<span className="text-xs text-slate-400">{template.checklist.filter((item) => routineStatus(template, period, item.id)).length} / {template.checklist.length}{" "}{t("complete")}</span>} />
                  <div className="mt-3">
                    {renderRoutineTable(template, [period], "Monthly task", (itemId) => template.checklist.find((item) => item.id === itemId)?.source || null)}
                  </div>
                </section>
              );
            })}

            <section className={frequency !== "history" ? "pm-phone-hidden" : ""}>
              <SectionHeading title={tt("Weekly History By Month")} />
              {entries.filter(entry => entry.template_id === PM_WEEKLY_TEMPLATE_ID).map(entry => <article key={entry.id} className="mt-3 rounded-lg border border-slate-700 p-3"><p className="mb-2 font-bold">{dateLabel(entry.period_start, { month: "long", day: "numeric", year: "numeric" }, locale)}</p>{renderRoutineTable(weeklyTemplate, [entry.period_start], "Weekly Task", undefined, true)}</article>)}
              {!entries.some(entry => entry.template_id === PM_WEEKLY_TEMPLATE_ID) && <p className="mt-2 text-sm text-slate-400">{t("No weekly records in the loaded period.")}</p>}
            </section>
            <section>
              <SectionHeading eyebrow={t("PDF checklists and logs")} title={tt("Inspections due this week")} trailing={<button type="button" onClick={() => setTab("inspections")} className="text-sm font-bold text-emerald-300 hover:underline">{t("Browse all forms")}</button>} />
              {formPeriods.length ? <div className="mt-2 grid gap-2 xl:grid-cols-2">{formPeriods.map(({ template, periodStart }) => inspectionCard(template, periodStart))}</div> : <p className="mt-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">{t("No separate PDF forms are scheduled for this week.")}</p>}
              {monthRoutineTotal > 0 && <p className="mt-3 text-xs text-slate-500">{t("Monthly checklist checkboxes completed:")}{" "}{monthRoutineDone} / {monthRoutineTotal}{t(". Keep the checklist and linked inspection form in sync.")}</p>}
            </section>
          </div>
        )}

        {tab === "inspections" && (
          <div className="mt-5 space-y-7">
            <section>
              <SectionHeading eyebrow={t("Source PDFs · interactive CMPRI forms")} title={tt("Forms due in the selected week")} />
              <p className="mt-1 text-sm text-slate-400">{t("Checklist marks support complete, needs follow-up, and N/A. Log forms include repeatable inspection rows, measurements, repair dates, initials, and notes where required.")}</p>
              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {formPeriods.map(({ template, periodStart }) => inspectionCard(template, periodStart))}
              </div>
              {!formPeriods.length && <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">{t("No scheduled source forms for this week.")}</p>}
            </section>
            <section>
              <SectionHeading eyebrow={t("Source checklist")} title={tt("All imported forms")} />
              <p className="mt-1 text-xs text-slate-500">{t("The source catalog covers 33 PDFs; the duplicated Fitness Center file is represented once. Source document and page are retained on each form.")}</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {PM_TEMPLATES.filter((template) => template.id.startsWith("pdf:") && template.kind !== "room").map((template) => {
                  const period = defaultFormPeriod(template, weekStart);
                  const records = entries.filter((entry) => entry.template_id === template.id);
                  return (
                    <article key={template.id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div><p className="font-semibold">{t(template.title)}</p><p className="mt-1 text-xs text-slate-500">{t(template.cadence)} · {t(template.scope)} · {template.checklist.length}{" "}{t("items")}</p></div>
                        <button type="button" onClick={() => openForm(template, period, template.scope === "equipment" ? "property" : template.scope === "area" ? "area:property" : "property")} className="rounded-md border border-slate-700 px-2 py-1 text-xs font-bold text-emerald-200">{canEdit ? t("New") : t("View form")}</button>
                      </div>
                      <SourceNote template={template} />
                      {records.slice(-3).map((entry) => <button key={entry.id} type="button" onClick={() => openForm(template, entry.period_start, entry.scope_key)} className="mr-1 mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200">{entry.scope_key.replace(/^[^:]+:/, "")} · {entry.is_complete ? t("Complete") : t("Draft")}</button>)}
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "rooms" && roomTemplate && (
          <section className="mt-5">
            <SectionHeading eyebrow={t("Live workbook · {value0} rooms", { value0: PM_ROOM_NUMBERS.length })} title={tt("Quarterly guest room PM · {value0}", { value0: dateLabel(currentQuarterPeriod, { month: "long", year: "numeric" }, locale) })} trailing={<span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">{PM_ROOM_NUMBERS.filter(roomCompleted).length} / {PM_ROOM_NUMBERS.length}{" "}{t("rooms complete")}</span>} />
            <p className="mt-1 text-sm text-slate-400">{t("Room-quarter completion is a date, separate from item checkboxes. Select a room to complete its room checklist, set rank, record deficiencies, and create a linked work order.")}</p>
            <label className="mt-4 block max-w-md"><span className="sr-only">{t("Search rooms")}</span><input value={roomSearch} onChange={(event) => setRoomSearch(event.target.value)} placeholder={t("Search room number…")} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm outline-none focus:border-emerald-400" /></label>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">{t("Room")}</th><th className="px-4 py-3">{t("Quarterly PM date")}</th><th className="px-4 py-3">{t("Rank")}</th><th className="px-4 py-3">{t("Status")}</th><th className="px-4 py-3"></th></tr></thead>
                <tbody>{filteredRooms.map((room) => {
                  const entry = entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
                  const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
                  const sourceDate = liveWorkbook?.rooms.find((item) => item.room === room)?.quarters[quarter]?.value || "";
                  const displayDate = entry?.completed_on || sourceDate;
                  const roomRank = String(entry?.form_data?.rank || "—");
                  return <tr key={room} className="border-t border-slate-800/80">
                    <th className="px-4 py-3 font-bold">{t("Room")}{" "}{room}</th>
                    <td className="px-4 py-3">{sourceDateIso(displayDate) ? dateLabel(sourceDateIso(displayDate), { month: "short", day: "numeric", year: "numeric" }, locale) : "—"}</td>
                    <td className="px-4 py-3 text-slate-300">{roomRank}</td>
                    <td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-xs ${entry?.status === "pending" ? "border-amber-500/40 bg-amber-950/30 text-amber-100" : displayDate ? "border-emerald-500/30 bg-emerald-950/30 text-emerald-200" : "border-slate-700 text-slate-400"}`}>{entry?.status === "pending" ? t("Pending review") : displayDate ? t("Complete") : t("Due")}</span></td>
                    <td className="px-4 py-3 text-right">{canReview && reviewQueue.filter(proposal => proposal.template_id === roomTemplate.id && proposal.period_start === currentQuarterPeriod && proposal.scope_key === `room:${room}`).map(proposal => <button key={proposal.id} type="button" onClick={() => void reviewProposal(proposal, "approve")} disabled={reviewBusyId === proposal.id} className="mr-2 rounded-lg border border-slate-600 p-2 text-red-400">{t("✓ Approve")}</button>)}<button type="button" onClick={() => openForm(roomTemplate, currentQuarterPeriod, `room:${room}`)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:border-emerald-400">{!canEdit || (["pending", "processing"].includes(entry?.status || "") && !entry?.can_edit_entry) ? t("View PM form") : entry ? t("Open PM") : t("Start PM")}</button></td>
                  </tr>;
                })}
                  {filteredRooms.length === 0 && <tr><td colSpan={5} role="status" className="border-t border-slate-800/80 px-4 py-5 text-center text-slate-400">{t("No rooms match “")}{roomSearch.trim()}”.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "history" && (
          <section className="mt-5">
            <SectionHeading eyebrow={t("CMPRI records")} title={tt("Maintenance History")} trailing={<button type="button" onClick={downloadTransfer} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950">{t("Download CSV")}</button>} />
            <PmRecordedIssues key={actor.id} actorId={actor.id} locations={locations} onOpen={openLinkedWorkOrder} onHistory={()=>setTab("history")} />
            <p className="mt-2 max-w-4xl text-sm text-slate-400">{t("This is a CMPRI review/export only and does not change Google Sheets. The CSV includes CMPRI checklist responses, scheduled inspection forms, and room completion records.")}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">{t("Routine checkbox cells")}</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{overallProgress.complete} / {overallProgress.total}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">{t("Source forms due")}</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{formPeriods.length}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">{t("Room-quarter completions")}</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{PM_ROOM_NUMBERS.filter(roomCompleted).length} / {PM_ROOM_NUMBERS.length}</p></div>
            </div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full min-w-[650px] text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase text-slate-400"><tr><th className="px-4 py-3">{t("Cadence")}</th><th className="px-4 py-3">{t("Checklist / form")}</th><th className="px-4 py-3">{t("Progress")}</th><th className="px-4 py-3">{t("Needs work")}</th></tr></thead>
                <tbody>
                  {[
                    ...routineTemplatesForTransfer(monthTemplates, weekStart),
                    ...formPeriods.map(({ template, periodStart }) => ({ template, period: periodStart })),
                  ].map(({ template, period }) => {
                    const isDaily = template.id === PM_DAILY_TEMPLATE_ID;
                    const records = entries.filter((entry) => entry.template_id === template.id && (
                      isDaily ? weekDates.includes(entry.period_start) : entry.period_start === period
                    ));
                    const record = records.find((entry) => entry.scope_key === "property") || records[0];
                    const checked = isDaily
                      ? records.reduce((count, entry) => count + template.checklist.filter((item) => entry.responses?.[item.id] === true).length, 0)
                      : template.checklist.filter((item) => {
                        const value = record?.responses?.[item.id];
                        return value === true || value === "complete" || value === "na";
                      }).length;
                    const total = isDaily ? template.checklist.length * weekDates.length : template.checklist.length;
                    const issues = records.reduce((count, entry) =>
                      count + template.checklist.filter((item) => entry.responses?.[item.id] === "follow-up").length, 0,
                    );
                    return <tr key={`${template.id}:${period}`} className="border-t border-slate-800">
                      <td className="px-4 py-3 capitalize text-slate-400">{t(template.cadence)}</td>
                      <td className="px-4 py-3 font-medium">{t(template.title)}</td>
                      <td className="px-4 py-3">{template.checklist.length ? t("{checked} / {total}", { checked: checked, total: total }) : record?.is_complete ? t("Complete") : t("Open")}</td>
                      <td className="px-4 py-3 text-amber-200">{issues || "—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <details className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
              <summary className="cursor-pointer font-semibold">{t("Source records and transfer notes")}</summary>
              <ul className="mt-3 space-y-1 text-sm text-slate-400">
                <li>{t("Routine schedules and monthly checkboxes:")}{" "}{PM_TEMPLATES.find((template) => template.id === PM_DAILY_TEMPLATE_ID)?.sourceFile}.</li>
                <li>{t("Room-quarter dates: the yearly tabs and Room PM Checklist source.")}</li>
                <li>{t("Interactive inspection fields: source PDF title and page are shown on each form.")}</li>
                <li>{t("No existing corporate spreadsheet completion values were copied or overwritten by this interface.")}</li>
              </ul>
            </details>
          </section>
        )}

        {loading && <div role="status" className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">{t("Loading PM records…")}</div>}
        {savingKey && savingKey !== "active-form" && savingKey !== "work-order" && <p className="mt-3 text-right text-xs text-slate-500">{t("Saving your PM entry…")}</p>}
      </div>

      {poolRequired && <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm" onKeyDown={event => { if (event.key === "Escape") setPoolRequired(null); }}><section role="dialog" aria-modal="true" aria-labelledby="pm-pool-question" className="max-w-lg rounded-xl border border-slate-600 bg-slate-950 p-6"><p id="pm-pool-question">{t("Would You Like To Create The Pool Log For")}{" "}{dateLabel(poolRequired, { month: "numeric", day: "numeric", year: "2-digit" }, locale)}?</p><div className="mt-5 flex justify-center gap-4"><a className="rounded-lg border border-slate-600 p-3 font-bold text-emerald-400" href={`/engineering/pool-log?date=${poolRequired}`}>{t("Open Pool Log")}</a><button autoFocus type="button" className="rounded-lg border border-slate-600 p-3 font-bold text-red-400" onClick={() => setPoolRequired(null)}>{t("Cancel")}</button></div></section></div>}
      {activeForm && activeTemplate && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/80">
          <section role="dialog" aria-modal="true" aria-labelledby="pm-form-title" className="pm-inspection cmpri-modal-shell border border-slate-700 bg-slate-950 shadow-2xl">
            <header className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 rounded-t-2xl border-b border-slate-800 bg-slate-950/95 p-4 backdrop-blur sm:p-5">
              <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">{t(activeTemplate.cadence)}{" "}{t("PM form ·")}{" "}{periodLabel(activeTemplate, activeForm.periodStart, locale)}</p><h2 id="pm-form-title" className="mt-1 text-xl font-bold">{t(activeTemplate.title)}{activeTemplate.scope === "room" ? t(" · Room {value0}", { value0: activeScopeKey.slice(5) }) : ""}</h2><SourceNote template={activeTemplate} /></div>
              <button type="button" onClick={() => { persistFormWorkspace(); draftFlush.current(); activeFormRef.current = null; setActiveForm(null); setError(""); setMessage(""); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900">{t("Close")}</button>
            </header>
            <div className="pm-inspection-body space-y-5 p-4 sm:p-5">
              {activeTemplate.instructions && <p className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100">{t(activeTemplate.instructions)}</p>}
              {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">{t(error)}</p>}
              {message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 p-3 text-sm text-emerald-100">{t(message)}</p>}
              {activeCanEdit && <PmOcrReference />}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5"><p className="text-[11px] uppercase tracking-wide text-slate-500">{t("Source period")}</p><p className="mt-1 text-sm font-semibold">{periodLabel(activeTemplate, activeForm.periodStart, locale)}</p></div>
                {activeTemplate.kind !== "routine" && <label className="block"><span className="text-xs font-semibold text-slate-300">{activeTemplate.kind === "room" ? t("Quarterly room PM completion date *") : t("Completion date")}</span><input type="date" disabled={!activeCanEdit || !!savingKey} value={completedOn} onChange={(event) => setCompletedOn(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white disabled:opacity-50" /></label>}
                {activeTemplate.scope === "room" && <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5"><p className="text-[11px] uppercase tracking-wide text-slate-500">{t("Room")}</p><p className="mt-1 text-sm font-bold">{activeScopeKey.slice(5)}</p></div>}
                {activeTemplate.fields.map((field) => (
                  <FieldInput key={field.id} field={field} value={formData[field.id] || ""} disabled={!activeCanEdit || !!savingKey} onChange={(value) => setFormData((current) => ({ ...current, [field.id]: value }))} />
                ))}
              </div>

              {activeTemplate.checklist.length > 0 && (
                <section>
                  <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-bold">{t("Inspection checklist")}</h3><p className="mt-0.5 text-xs text-slate-500">{t("Record each item as acceptable, needing follow-up, or not applicable.")}</p></div><span className="text-xs text-slate-400">{Object.keys(checklist).length} / {activeTemplate.checklist.length}{" "}{t("reviewed")}</span></div>
                  <div className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800">
                    {activeTemplate.checklist.map((item) => (
                      <div key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1"><p className="text-sm text-slate-200">{item.category && <span className="mr-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t(item.category)}</span>}{t(item.label)}</p><span className="text-[10px] text-slate-600">{item.source}</span></div>
                        <div className="flex shrink-0 gap-1">
                          {(["complete", "follow-up", "na"] as const).map((state) => <button key={state} type="button" disabled={!activeCanEdit || !!savingKey} aria-pressed={checklist[item.id] === state} onClick={() => setChecklist((current) => ({ ...current, [item.id]: state }))} className={`rounded-md border px-2 py-1.5 text-[11px] font-bold ${checklist[item.id] === state ? statusStyle(state === "complete" ? true : state === "follow-up" ? state : "na") : "border-slate-700 text-slate-400 hover:border-slate-500"} disabled:opacity-40`}>{state === "complete" ? t("✓ OK") : state === "follow-up" ? t("/ Follow-up") : t("N/A")}</button>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTemplate.repeatableFields && (
                <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-2"><div><h3 className="font-bold">{activeTemplate.repeatableLabel || t("Inspection records")}</h3><p className="mt-0.5 text-xs text-slate-500">{t("Add one row for each inspected device, valve, or test location.")}</p></div><button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => setRepeatableRows((current) => [...current, {}])} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-emerald-200 disabled:opacity-40">{t("Add row +")}</button></div>
                  <div className="mt-3 space-y-3">
                    {repeatableRows.map((row, index) => (
                      <div key={index} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                        <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">{t("Record")}{" "}{index + 1}</p><button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => setRepeatableRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="text-xs text-red-300 hover:underline">{t("Remove")}</button></div>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {activeTemplate.repeatableFields!.map((field) => <FieldInput key={field.id} field={field} value={row[field.id] || ""} disabled={!activeCanEdit || !!savingKey} onChange={(value) => setRepeatableRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, [field.id]: value } : item))} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                <label className="block"><span className="text-xs font-semibold text-slate-300">{t("Inspection notes")}</span><textarea disabled={!activeCanEdit || !!savingKey} value={formNotes} onChange={(event) => setFormNotes(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400" placeholder={t("Record observations, readings, or context…")} /></label>
                <label className="block"><span className="text-xs font-semibold text-amber-200">{t("Deficiencies and follow-up plan")}</span><textarea disabled={!activeCanEdit || !!savingKey} value={deficiencyNotes} onChange={(event) => setDeficiencyNotes(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-amber-500/30 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-400" placeholder={t("Describe what needs repair and the next step…")} /></label>
              </div>

              {deficiencyNotes.trim() && activeCanEdit && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-950/15 p-3">
                  <p className="text-sm font-bold text-amber-100">{t("Create a linked work order")}</p>
                  <p className="mt-1 text-xs text-amber-100/70">{t("The PM record is saved first. The work order will include the form source, inspection period, marked deficiencies, and your follow-up notes.")}</p>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="min-w-[240px] flex-1"><span className="text-xs font-semibold text-slate-300">{t("Work-order location")}</span><select value={deficiencyLocationId} onChange={(event) => setDeficiencyLocationId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">{t("Select location…")}</option>{locations.map((location) => <option key={location.id} value={location.id}>{[location.area, location.room_number, location.name].filter(Boolean).join(" · ")}</option>)}</select></label>
                    <button type="button" disabled={!activeCanEdit || !!savingKey || !deficiencyLocationId} onClick={() => void createWorkOrderFromDeficiency()} className="rounded-full bg-amber-300 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40">{savingKey === "work-order" ? t("Creating…") : t("Save & create work order")}</button>
                  </div>
                </div>
              )}

              {pendingLinkMatchesForm && pendingWorkOrderLink && <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100"><span>{t("Work order")}{" "}{pendingWorkOrderLink.displayId}{" "}{t("exists but is not yet linked to this PM entry.")}</span><button type="button" disabled={!!savingKey} onClick={() => void retryPendingWorkOrderLink()} className="rounded-md border border-amber-400/40 px-3 py-1.5 font-bold disabled:opacity-40">{t("Retry link")}</button></div>}
              {activeScopeEntry?.work_order_id && <button type="button" onClick={() => openLinkedWorkOrder(activeScopeEntry.work_order_id!)} className="rounded-lg border border-sky-500/30 bg-sky-950/25 px-3 py-2 text-sm font-semibold text-sky-200">{t("Open linked work order")}</button>}

              <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-4">
                <button type="button" disabled={exportingExcel} onClick={() => void downloadExcel()} className="rounded-lg border px-4 py-2.5 text-sm font-bold">{exportingExcel ? t("Exporting…") : t("Export Excel")}</button>
                <button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => void saveActive(false)} className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-bold text-slate-200 disabled:opacity-40">{savingKey === "active-form" ? t("Saving…") : t("Save draft")}</button>
                <button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => void saveActive(true)} className="rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40">{t("Mark complete")}</button>
              </footer>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function defaultFormPeriod(template: PmTemplate, weekStart: string) {
  const scheduledPeriod = templatePeriodsForWeek(template, weekStart)[0];
  if (scheduledPeriod) return scheduledPeriod;
  if (template.cadence === "daily" || template.cadence === "weekly") return weekStart;
  if (template.cadence === "monthly") return `${weekStart.slice(0, 7)}-01`;

  const date = new Date(`${weekStart}T12:00:00Z`);
  for (let offset = 0; offset < 12; offset += 1) {
    const candidate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1, 12));
    const period = candidate.toISOString().slice(0, 10);
    if (templatePeriodsForWeek(template, period).includes(period)) return period;
  }
  throw new Error(`No scheduled period is configured for ${template.title}.`);
}

function routineTemplatesForTransfer(monthTemplates: PmTemplate[], weekStart: string) {
  return [
    { template: findPmTemplate(PM_DAILY_TEMPLATE_ID)!, period: weekStart },
    { template: findPmTemplate(PM_WEEKLY_TEMPLATE_ID)!, period: weekStart },
    ...monthTemplates.flatMap((template) => {
      const period = templatePeriodsForWeek(template, weekStart)[0];
      return period ? [{ template, period }] : [];
    }),
  ];
}
