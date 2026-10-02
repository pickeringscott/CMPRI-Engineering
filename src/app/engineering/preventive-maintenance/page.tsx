"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
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

type PmEntry = {
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
  status?: "pending" | "approved" | "rejected";
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
type PmTab = "week" | "inspections" | "rooms" | "transfer" | "review";
type ActiveForm = { templateId: string; periodStart: string; scopeKey: string };
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
  { id: "week", label: "Weekly sheet" },
  { id: "inspections", label: "Inspection forms" },
  { id: "rooms", label: "Quarterly room PM" },
  { id: "transfer", label: "Transfer review" },
  { id: "review", label: "Review & confirm" },
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

function dateLabel(value: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, options);
}

function periodLabel(template: PmTemplate, period: string) {
  if (template.cadence === "daily") return dateLabel(period, { month: "long", day: "numeric", year: "numeric" });
  if (template.cadence === "weekly") {
    const end = new Date(`${period}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${dateLabel(period)} – ${dateLabel(end.toISOString().slice(0, 10), { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return dateLabel(period, { month: "long", year: "numeric" });
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
  return liveTask?.targets.some((target) => target.value === "TRUE") || false;
}

function SourceNote({ template }: { template: PmTemplate }) {
  return <span className="text-[11px] text-slate-500">{template.sourceReference}</span>;
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
  const base = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400 disabled:opacity-50";
  return (
    <label className="block min-w-0">
      <span className="text-xs font-semibold text-slate-300">{field.label}{field.required ? " *" : ""}</span>
      {field.type === "textarea" ? (
        <textarea required={field.required} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} rows={3} className={base} />
      ) : field.type === "select" || field.type === "yes-no" ? (
        <select required={field.required} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} className={base}>
          <option value="">Select…</option>
          {(field.type === "yes-no" ? ["Yes", "No"] : field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <input required={field.required} disabled={disabled} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={value} onChange={(event) => onChange(event.target.value)} className={base} />
      )}
    </label>
  );
}

function SectionHeading({ eyebrow, title, trailing }: { eyebrow?: string; title: string; trailing?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>{eyebrow && <p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">{eyebrow}</p>}<h2 className="mt-0.5 text-xl font-bold text-white">{title}</h2></div>
      {trailing}
    </div>
  );
}

export default function PreventiveMaintenancePage() {
  const router = useRouter();
  useEmbeddedModal();
  const [weekStart, setWeekStart] = useState(() => pmWeekStart(todayIso()));
  const [tab, setTab] = useState<PmTab>("week");
  const [entries, setEntries] = useState<PmEntry[]>([]);
  const [liveWorkbook, setLiveWorkbook] = useState<LivePmWorkbook | null>(null);
  const [reviewQueue, setReviewQueue] = useState<PmReviewProposal[]>([]);
  const [locations, setLocations] = useState<PmLocation[]>([]);
  const [accessRoles, setAccessRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [canEdit, setCanEdit] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [canWriteLivePm, setCanWriteLivePm] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const [reviewBusyId, setReviewBusyId] = useState("");
  const [roomSearch, setRoomSearch] = useState("");
  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [checklist, setChecklist] = useState<Record<string, ChecklistState>>({});
  const [repeatableRows, setRepeatableRows] = useState<Array<Record<string, string>>>([]);
  const [formNotes, setFormNotes] = useState("");
  const [deficiencyNotes, setDeficiencyNotes] = useState("");
  const [completedOn, setCompletedOn] = useState("");
  const [deficiencyLocationId, setDeficiencyLocationId] = useState("");
  const [pendingWorkOrderLink, setPendingWorkOrderLink] = useState<PendingWorkOrderLink | null>(null);
  const [confirmingProposal, setConfirmingProposal] = useState<PmReviewProposal | null>(null);
  const requestSequence = useRef(0);
  const busyEntries = useRef(new Set<string>());
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
      const response = await fetch(`/api/preventive-maintenance?week=${encodeURIComponent(week)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (sequence !== requestSequence.current || !isCurrent()) return;
      if (!response.ok || !Array.isArray(result.entries) || !result.workbook) throw new Error(result.error || "Live PM records could not be loaded.");
      setEntries(result.entries as PmEntry[]);
      setLiveWorkbook(result.workbook as LivePmWorkbook);
      setReviewQueue(Array.isArray(result.review_queue) ? result.review_queue as PmReviewProposal[] : []);
      setLocations(Array.isArray(result.locations) ? result.locations as PmLocation[] : []);
      setAccessRoles(Array.isArray(result.access_roles) ? result.access_roles.filter((role: unknown): role is string => typeof role === "string") : []);
      setCanEdit(result.can_edit === true || result.can_review === true);
      setCanReview(result.can_review === true);
      setCanWriteLivePm(result.can_write_live_pm === true);
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
          const pending = entry?.status === "pending" && Object.hasOwn(entry.responses || {}, item.id);
          if (pending ? entry?.responses?.[item.id] === true : sourceRoutineStatus(template, period, item.id, liveWorkbook)) complete += 1;
        }
      }
    }
    return { complete, total, percent: total ? Math.round((complete / total) * 100) : 0 };
  }, [liveWorkbook, monthTemplates, recordsByKey, weekStart]);

  const deficientCount = useMemo(() => entries.reduce((count, entry) =>
    count + Object.values(entry.responses || {}).filter((value) => value === "follow-up").length,
  0), [entries]);

  function entryFor(template: PmTemplate, periodStart: string, scopeKey = "property") {
    return recordsByKey.get(entryKey(template.id, periodStart, scopeKey));
  }

  function roomCompleted(room: string) {
    const proposal = roomTemplate && entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
    if (proposal?.status === "pending" && proposal.completed_on) return true;
    const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
    return Boolean(liveWorkbook?.rooms.find((item) => item.room === room)?.quarters[quarter]?.value);
  }

  async function saveEntry(payload: Record<string, unknown>) {
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
      setConfirmingProposal(null);
      setMessage(decision === "approve"
        ? "PM proposal confirmed. Approved values were applied to the live PM workbook."
        : "PM proposal rejected. The live PM workbook was not changed.");
      await loadWeek(weekStart);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The PM proposal could not be reviewed.";
      await loadWeek(weekStart);
      setError(message);
    } finally {
      setReviewBusyId("");
    }
  }

  async function updateRoutine(template: PmTemplate, periodStart: string, itemId: string, checked: boolean) {
    if (!canEdit || busyEntries.current.has(entryKey(template.id, periodStart))) return;
    const key = entryKey(template.id, periodStart);
    const existing = entryFor(template, periodStart);
    const responses = Object.fromEntries(template.checklist.map((item) => [
      item.id,
      existing?.status === "pending" && Object.hasOwn(existing.responses || {}, item.id)
        ? existing.responses[item.id] === true
        : routineStatus(template, periodStart, item.id),
    ])) as Record<string, boolean>;
    responses[itemId] = checked;
    const isComplete = template.checklist.every((item) => responses[item.id] === true);
    busyEntries.current.add(key);
    setSavingKey(key);
    setError("");
    setMessage("");
    try {
      await saveEntry({
        templateId: template.id,
        periodStart,
        scopeKey: "property",
        responses,
        formData: existing?.form_data || {},
        notes: existing?.notes || "",
        deficiencyNotes: existing?.deficiency_notes || "",
        completedOn: isComplete ? today : null,
        isComplete,
        expectedRevision: existing?.revision || 0,
        workOrderId: existing?.work_order_id || null,
      });
      setMessage(`${template.title} change saved as pending review.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PM checkbox could not be saved.");
    } finally {
      busyEntries.current.delete(key);
      setSavingKey("");
    }
  }

  function openForm(template: PmTemplate, periodStart: string, scopeKey = "property") {
    const existing = entryFor(template, periodStart, scopeKey);
    setActiveForm({ templateId: template.id, periodStart, scopeKey });
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
  }

  function locationForScope(scopeKey: string) {
    const room = scopeKey.match(/^room:(\d{2,4})$/)?.[1];
    if (room) return locations.find((location) =>
      String(location.room_number || "").trim() === room || location.name?.match(/\b\d{2,4}\b/)?.[0] === room,
    ) || null;
    return null;
  }

  const activeTemplate = activeForm ? findPmTemplate(activeForm.templateId) : null;
  const activeScopeKey = activeForm?.scopeKey || "property";
  const activeScopeEntry = activeForm && activeTemplate ? entryFor(activeTemplate, activeForm.periodStart, activeScopeKey) : null;
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
    for (const field of activeTemplate.fields) {
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
    return await saveEntry({
      templateId: activeTemplate.id,
      periodStart: activeForm.periodStart,
      scopeKey,
      responses: checklist,
      formData: formValues,
      notes: formNotes,
      deficiencyNotes,
      completedOn: completedOn || null,
      isComplete,
      expectedRevision: revisionOverride ?? existing?.revision ?? 0,
      workOrderId: workOrderId === undefined ? existing?.work_order_id || null : workOrderId,
    });
  }

  async function saveActive(isComplete: boolean) {
    setSavingKey("active-form");
    setError("");
    setMessage("");
    try {
      const saved = await persistActive(isComplete);
      setActiveForm((current) => current ? { ...current, scopeKey: saved.scope_key } : current);
      setMessage(isComplete
        ? `${activeTemplate?.title || "PM form"} submitted for review. It has not changed the live workbook.`
        : "PM draft saved as pending review. It has not changed the live workbook.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PM form could not be saved.");
    } finally {
      setSavingKey("");
    }
  }

  async function createWorkOrderFromDeficiency() {
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
        const linked = await persistActive(false, pending.id, pending.revision);
        setActiveForm((current) => current ? { ...current, scopeKey: linked.scope_key } : current);
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
      const linked = await persistActive(false, pendingWorkOrderLink.id, pendingWorkOrderLink.revision);
      setActiveForm((current) => current ? { ...current, scopeKey: linked.scope_key } : current);
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
            entry?.status === "pending" ? "Pending review; not yet applied" : "Current live workbook",
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
            entry?.status === "pending" ? "Pending review; not yet applied" : entry?.status === "approved" ? "Approved" : "Open",
          ]);
        }
        if (!template.checklist.length) rows.push([periodStart, template.cadence, template.title, entry?.scope_key || template.scope, entry?.is_complete ? "Complete" : "Open", entry?.completed_on || "", entry?.deficiency_notes || entry?.notes || "", template.sourceReference, entry?.status === "pending" ? "Pending review; not yet applied" : entry?.status === "approved" ? "Approved" : "Open"]);
      }
    }
    if (roomTemplate) {
      for (const room of PM_ROOM_NUMBERS) {
        const entry = entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
        const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
        const sourceDate = liveWorkbook?.rooms.find((item) => item.room === room)?.quarters[quarter]?.value || "";
        rows.push([currentQuarterPeriod, "quarterly", roomTemplate.title, `Room ${room}`, roomCompleted(room) ? "Complete" : "Open", entry?.status === "pending" ? entry.completed_on || "" : sourceDateIso(sourceDate), entry?.deficiency_notes || entry?.notes || "", roomTemplate.sourceReference, entry?.status === "pending" ? "Pending review; not yet applied" : "Current live workbook"]);
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

  function findReferencedForm(reference: string | null | undefined) {
    if (!reference) return null;
    const normalizedReference = reference.toLowerCase();
    return PM_TEMPLATES.find((template) =>
      template.kind !== "routine" && normalizedReference.includes(template.sourceFile.toLowerCase()),
    ) || null;
  }

  function openRoutineReference(reference: string | null | undefined, period: string, weekly = false) {
    const template = findReferencedForm(reference);
    if (!template) return;
    const formPeriod = template.cadence === "weekly" ? weekStart : period;
    openForm(template, formPeriod);
    if (weekly && template.kind === "meeting") setTab("week");
  }

  function inspectionCard(template: PmTemplate, periodStart: string) {
    const saved = entries.filter((entry) => entry.template_id === template.id && entry.period_start === periodStart);
    const newScope = template.scope === "equipment" ? "property" : template.scope === "area" ? "area:property" : "property";
    const existingSingle = saved.find((entry) => entry.scope_key === newScope);
    const complete = saved.some((entry) => entry.is_complete);
    return (
      <article key={`${template.id}:${periodStart}`} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-bold text-white">{template.title}</h3>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-300">{template.cadence}</span>
              {complete && <span className="rounded-full border border-emerald-500/30 bg-emerald-950/30 px-2 py-0.5 text-[10px] font-bold text-emerald-200">Complete</span>}
            </div>
            <p className="mt-1 text-xs text-slate-400">{periodLabel(template, periodStart)} · {template.scope}</p>
            <SourceNote template={template} />
            {saved.filter((entry) => entry.scope_key !== newScope).map((entry) => (
              <button key={entry.id} type="button" onClick={() => openForm(template, periodStart, entry.scope_key)} className="ml-2 mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400">{entry.scope_key.replace(/^[^:]+:/, "")}{entry.is_complete ? " · done" : " · open"}</button>
            ))}
          </div>
          <button type="button" onClick={() => openForm(template, periodStart, existingSingle?.scope_key || newScope)} className="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-bold text-slate-950">{!canEdit ? "View form" : existingSingle ? "Open form" : template.scope === "equipment" ? "Add inspection" : "Open form"}</button>
        </div>
      </article>
    );
  }

  function routineStatus(template: PmTemplate, period: string, itemId: string) {
    const proposal = entryFor(template, period);
    if (proposal?.status === "pending" && Object.hasOwn(proposal.responses || {}, itemId)) {
      return proposal.responses[itemId] === true;
    }
    return sourceRoutineStatus(template, period, itemId, liveWorkbook);
  }

  function renderRoutineTable(template: PmTemplate, periods: string[], heading: string, linkedReference?: (itemId: string) => string | null) {
    const savingFor = (period: string) => savingKey === entryKey(template.id, period);
    return (
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead className="bg-slate-900 text-xs text-slate-400">
            <tr><th className="sticky left-0 min-w-[270px] bg-slate-900 px-3 py-3">{heading}</th>{periods.map((period, index) => <th key={period} className="min-w-20 px-2 py-3 text-center">{template.cadence === "daily" ? <><span className="block font-bold text-white">{DAY_LABELS[index]}</span><span>{dateLabel(period)}</span></> : <span>{periodLabel(template, period)}</span>}</th>)}</tr>
          </thead>
          <tbody>
            {template.checklist.map((item, index) => (
              <tr key={item.id} className="border-t border-slate-800/80 hover:bg-slate-900/50">
                <th scope="row" className="sticky left-0 bg-slate-950 px-3 py-2.5 text-sm font-medium text-slate-200">
                  {item.category && <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{item.category}</span>}
                  {item.label}
                  {linkedReference?.(item.id) && <button type="button" onClick={() => openRoutineReference(linkedReference(item.id), periods[0], template.cadence === "weekly")} className="ml-2 text-[10px] font-bold text-emerald-300 hover:underline">Open attached form</button>}
                </th>
                {periods.map((period) => {
                  const checked = routineStatus(template, period, item.id);
                  const hasPending = entryFor(template, period)?.status === "pending"
                    && Object.hasOwn(entryFor(template, period)?.responses || {}, item.id);
                  return (
                    <td key={period} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`${item.label} · ${dateLabel(period, { month: "long", day: "numeric", year: "numeric" })}${hasPending ? " · pending review" : ""}`}
                        disabled={!canEdit || loading || savingFor(period)}
                        onClick={() => void updateRoutine(template, period, item.id, !checked)}
                        className={`grid h-9 w-9 place-items-center rounded-lg border mx-auto transition ${hasPending ? "border-amber-400 bg-amber-400/15 text-amber-200" : checked ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-600 bg-slate-900 text-transparent hover:border-emerald-400"} disabled:cursor-wait disabled:opacity-50`}
                        title={hasPending ? "Pending reviewer confirmation" : undefined}
                      >✓</button>
                    </td>
                  );
                })}
                <td className="sr-only">{index}</td>
              </tr>
            ))}
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
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5 lg:px-7">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.22em] text-emerald-300">CMPRI · Live PM workbook</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Preventive Maintenance</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">Weekly checklist, room-quarter completion dates, and interactive source forms. Technician changes remain pending until a reviewer explicitly confirms them.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-slate-900">Dashboard</ModalDashboardLink>
            <button type="button" onClick={downloadTransfer} className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-900/40">Export weekly CSV</button>
          </div>
        </header>

        <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-3 sm:p-4" aria-label="Week controls">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Previous week" onClick={() => changeWeek(-1)} className="grid h-10 w-10 place-items-center rounded-lg border border-slate-700 text-lg hover:border-emerald-400">‹</button>
              <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
                <span className="sr-only">Week beginning</span>
                <input type="date" value={weekStart} onChange={(event) => event.target.value && setWeekStart(pmWeekStart(event.target.value))} className="bg-transparent text-white outline-none" />
              </label>
              <button type="button" aria-label="Next week" onClick={() => changeWeek(1)} className="grid h-10 w-10 place-items-center rounded-lg border border-slate-700 text-lg hover:border-emerald-400">›</button>
              <button type="button" onClick={() => setWeekStart(pmWeekStart(today))} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800">This week</button>
            </div>
            <p className="text-sm font-semibold text-slate-300">{dateLabel(weekStart, { month: "long", day: "numeric", year: "numeric" })} – {dateLabel(weekEnd, { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Routine items checked</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{overallProgress.complete}<span className="text-sm font-medium text-slate-500"> / {overallProgress.total}</span></p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Weekly progress</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{overallProgress.percent}%</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Forms still open</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{openInspectionCount}</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Needs follow-up</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold text-amber-200">{deficientCount}</p></div>
          </div>
        </section>
        <div role="note" className="mt-3 rounded-xl border border-sky-500/30 bg-sky-950/20 px-4 py-3 text-sm text-sky-100">
          This view reads the live personal PM workbook. Saving a technician change creates a CMPRI review proposal; the workbook is not changed until it is explicitly approved.
        </div>

        <nav className="mt-4 flex gap-2 overflow-x-auto border-b border-slate-800 pb-2" aria-label="PM sections">
          {TAB_OPTIONS.filter((item) => item.id !== "review" || canReview).map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)} className={`shrink-0 rounded-lg px-4 py-2 text-sm font-bold transition ${tab === item.id ? "bg-emerald-400 text-slate-950" : "border border-slate-800 text-slate-300 hover:bg-slate-900"}`}>{item.label}{item.id === "review" && reviewQueue.length > 0 ? ` (${reviewQueue.length})` : ""}</button>)}
        </nav>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">{error}</div>}
        {message && !activeForm && <div role="status" className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/25 p-3 text-sm text-emerald-100">{message}</div>}
        {!canEdit && !loading && !error && <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-sm text-amber-100">The PM service resolved this session as read-only{accessRoles.length ? ` (roles: ${accessRoles.join(", ")})` : ""}. If you are a System Administrator, this role result is incorrect and should be reported to an administrator.</div>}

        {tab === "week" && (
          <div className="mt-5 space-y-7">
            <section>
              <SectionHeading eyebrow="Workbook · daily checkbox grid" title="Daily maintenance" trailing={<span className="text-xs text-slate-400">{dailyDone} / {dailyCount} complete</span>} />
              <p className="mb-3 mt-1 text-xs text-slate-500">Each checkbox saves separately for its date. Pool readings are entered in the Pool Log, with a shortcut from its linked form below.</p>
              {renderRoutineTable(dailyTemplate, weekDates, "Routine task")}
            </section>

            <section>
              <SectionHeading eyebrow="Live workbook · one completion per week" title="Weekly maintenance" trailing={<span className="text-xs text-slate-400">{weeklyTemplate.checklist.filter((item) => routineStatus(weeklyTemplate, weekStart, item.id)).length} / {weeklyTemplate.checklist.length} complete</span>} />
              <div className="mt-3">
                {renderRoutineTable(weeklyTemplate, [weekStart], "Weekly task", (itemId) => weeklyTemplate.checklist.find((item) => item.id === itemId)?.source?.endsWith(".pdf") ? weeklyTemplate.checklist.find((item) => item.id === itemId)!.source! : null)}
              </div>
            </section>

            {monthTemplates.map((template) => {
              const period = templatePeriodsForWeek(template, weekStart)[0];
              return (
                <section key={template.id}>
                  <SectionHeading eyebrow={`${template.title} · workbook checkboxes`} title={`${dateLabel(period, { month: "long", year: "numeric" })} monthly tasks`} trailing={<span className="text-xs text-slate-400">{template.checklist.filter((item) => routineStatus(template, period, item.id)).length} / {template.checklist.length} complete</span>} />
                  <div className="mt-3">
                    {renderRoutineTable(template, [period], "Monthly task", (itemId) => template.checklist.find((item) => item.id === itemId)?.source?.match(/[^, ]+\.pdf/i)?.[0] || null)}
                  </div>
                </section>
              );
            })}

            <section>
              <SectionHeading eyebrow="PDF checklists and logs" title="Inspections due this week" trailing={<button type="button" onClick={() => setTab("inspections")} className="text-sm font-bold text-emerald-300 hover:underline">Browse all forms</button>} />
              {formPeriods.length ? <div className="mt-3 grid gap-3 xl:grid-cols-2">{formPeriods.map(({ template, periodStart }) => inspectionCard(template, periodStart))}</div> : <p className="mt-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">No separate PDF forms are scheduled for this week.</p>}
              {monthRoutineTotal > 0 && <p className="mt-3 text-xs text-slate-500">Monthly checklist checkboxes completed: {monthRoutineDone} / {monthRoutineTotal}. Keep the checklist and linked inspection form in sync.</p>}
            </section>
          </div>
        )}

        {tab === "inspections" && (
          <div className="mt-5 space-y-7">
            <section>
              <SectionHeading eyebrow="Source PDFs · interactive CMPRI forms" title="Forms due in the selected week" />
              <p className="mt-1 text-sm text-slate-400">Checklist marks support complete, needs follow-up, and N/A. Log forms include repeatable inspection rows, measurements, repair dates, initials, and notes where required.</p>
              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {formPeriods.map(({ template, periodStart }) => inspectionCard(template, periodStart))}
              </div>
              {!formPeriods.length && <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">No scheduled source forms for this week.</p>}
            </section>
            <section>
              <SectionHeading eyebrow="Source checklist" title="All imported forms" />
              <p className="mt-1 text-xs text-slate-500">The source catalog covers 33 PDFs; the duplicated Fitness Center file is represented once. Source document and page are retained on each form.</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {PM_TEMPLATES.filter((template) => template.id.startsWith("pdf:") && template.kind !== "room").map((template) => {
                  const period = defaultFormPeriod(template, weekStart);
                  const records = entries.filter((entry) => entry.template_id === template.id);
                  return (
                    <article key={template.id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div><p className="font-semibold">{template.title}</p><p className="mt-1 text-xs text-slate-500">{template.cadence} · {template.scope} · {template.checklist.length} items</p></div>
                        <button type="button" onClick={() => openForm(template, period, template.scope === "equipment" ? "property" : template.scope === "area" ? "area:property" : "property")} className="rounded-md border border-slate-700 px-2 py-1 text-xs font-bold text-emerald-200">{canEdit ? "New" : "View form"}</button>
                      </div>
                      <SourceNote template={template} />
                      {records.slice(-3).map((entry) => <button key={entry.id} type="button" onClick={() => openForm(template, entry.period_start, entry.scope_key)} className="mr-1 mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200">{entry.scope_key.replace(/^[^:]+:/, "")} · {entry.is_complete ? "Complete" : "Draft"}</button>)}
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "rooms" && roomTemplate && (
          <section className="mt-5">
            <SectionHeading eyebrow={`Live workbook · ${PM_ROOM_NUMBERS.length} rooms`} title={`Quarterly guest room PM · ${dateLabel(currentQuarterPeriod, { month: "long", year: "numeric" })}`} trailing={<span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">{PM_ROOM_NUMBERS.filter(roomCompleted).length} / {PM_ROOM_NUMBERS.length} rooms complete</span>} />
            <p className="mt-1 text-sm text-slate-400">Room-quarter completion is a date, separate from item checkboxes. Select a room to complete its room checklist, set rank, record deficiencies, and create a linked work order.</p>
            <label className="mt-4 block max-w-md"><span className="sr-only">Search rooms</span><input value={roomSearch} onChange={(event) => setRoomSearch(event.target.value)} placeholder="Search room number…" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm outline-none focus:border-emerald-400" /></label>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Room</th><th className="px-4 py-3">Quarterly PM date</th><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th></tr></thead>
                <tbody>{filteredRooms.map((room) => {
                  const entry = entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
                  const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
                  const sourceDate = liveWorkbook?.rooms.find((item) => item.room === room)?.quarters[quarter]?.value || "";
                  const displayDate = entry?.status === "pending" && entry.completed_on ? entry.completed_on : sourceDate;
                  const roomRank = String(entry?.form_data?.rank || "—");
                  return <tr key={room} className="border-t border-slate-800/80">
                    <th className="px-4 py-3 font-bold">Room {room}</th>
                    <td className="px-4 py-3">{sourceDateIso(displayDate) ? dateLabel(sourceDateIso(displayDate), { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                    <td className="px-4 py-3 text-slate-300">{roomRank}</td>
                    <td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-xs ${entry?.status === "pending" ? "border-amber-500/40 bg-amber-950/30 text-amber-100" : displayDate ? "border-emerald-500/30 bg-emerald-950/30 text-emerald-200" : "border-slate-700 text-slate-400"}`}>{entry?.status === "pending" ? "Pending review" : displayDate ? "Complete" : "Due"}</span></td>
                    <td className="px-4 py-3 text-right"><button type="button" onClick={() => openForm(roomTemplate, currentQuarterPeriod, `room:${room}`)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:border-emerald-400">{!canEdit ? "View PM form" : entry ? "Open PM" : "Start PM"}</button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "review" && canReview && (
          <section className="mt-5 space-y-4">
            <SectionHeading eyebrow="Reviewer-only · explicit approval" title="Pending PM changes" trailing={<span className="rounded-full border border-amber-500/40 bg-amber-950/30 px-3 py-1 text-xs text-amber-100">{reviewQueue.length} awaiting review</span>} />
            <p className="max-w-4xl text-sm text-slate-400">Technician work is staged in CMPRI and has not changed the live workbook. Review the checklist values, notes, completion dates, and proposed cells before confirming.</p>
            {reviewQueue.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-400">There are no pending PM proposals.</div>
            ) : reviewQueue.map((proposal) => {
              const template = findPmTemplate(proposal.template_id);
              const payload = proposal.payload || {};
              const proposedResponses = payload.responses && typeof payload.responses === "object"
                ? payload.responses as Record<string, unknown>
                : {};
              const proposedFormData = payload.form_data && typeof payload.form_data === "object"
                ? payload.form_data as Record<string, unknown>
                : {};
              const logEntries = Array.isArray(proposedFormData.logEntries)
                ? proposedFormData.logEntries.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
                : [];
              return (
                <article key={proposal.id} className="rounded-2xl border border-amber-500/20 bg-slate-900/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-white">{template?.title || proposal.template_id}</h3>
                      <p className="mt-1 text-xs text-slate-400">{periodLabel(template || PM_TEMPLATES[0], proposal.period_start)} · {proposal.scope_key} · submitted by {proposal.submitted_by_name}</p>
                      <p className="mt-1 text-xs text-amber-200">{proposal.status === "processing" ? "Approval is being recovered; review and confirm again to finish safely." : "Pending your confirmation"}</p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" disabled={reviewBusyId === proposal.id || proposal.status === "processing"} onClick={() => void reviewProposal(proposal, "reject")} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-50">Reject</button>
                      <button type="button" disabled={reviewBusyId === proposal.id} onClick={() => setConfirmingProposal(proposal)} className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3 py-2 text-xs font-bold text-emerald-100 hover:bg-emerald-900/40 disabled:opacity-50">Review &amp; confirm…</button>
                    </div>
                  </div>
                  {template && Object.keys(proposedResponses).length > 0 && (
                    <ul className="mt-3 grid gap-1 border-t border-slate-800 pt-3 text-sm sm:grid-cols-2">
                      {template.checklist.filter((item) => Object.hasOwn(proposedResponses, item.id)).map((item) => <li key={item.id} className="flex justify-between gap-3 text-slate-300"><span>{item.label}</span><strong>{statusText(proposedResponses[item.id])}</strong></li>)}
                    </ul>
                  )}
                  {template?.fields.some((field) => proposedFormData[field.id] !== undefined && proposedFormData[field.id] !== "") && (
                    <dl className="mt-3 grid gap-2 border-t border-slate-800 pt-3 sm:grid-cols-2">
                      {template.fields.filter((field) => proposedFormData[field.id] !== undefined && proposedFormData[field.id] !== "").map((field) => <div key={field.id} className="rounded-lg bg-slate-950/70 px-3 py-2 text-sm"><dt className="text-xs text-slate-500">{field.label}</dt><dd className="mt-1 whitespace-pre-wrap text-slate-200">{String(proposedFormData[field.id])}</dd></div>)}
                    </dl>
                  )}
                  {template?.repeatableFields && logEntries.length > 0 && <div className="mt-3 border-t border-slate-800 pt-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{template.repeatableLabel || "Inspection records"}</p>
                    <ul className="mt-2 space-y-2">{logEntries.map((row, rowIndex) => <li key={rowIndex} className="rounded-lg bg-slate-950/70 p-3 text-xs text-slate-200"><strong className="mr-2 text-slate-400">Record {rowIndex + 1}</strong>{template.repeatableFields!.map((field) => row[field.id] ? `${field.label}: ${String(row[field.id])}` : "").filter(Boolean).join(" · ")}</li>)}</ul>
                  </div>}
                  {proposal.proposed_cells.length > 0 && <div className="mt-3 border-t border-slate-800 pt-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Proposed live workbook changes</p>
                    <ul className="mt-2 space-y-1 text-sm text-slate-200">
                      {proposal.proposed_cells.map((cell, index) => <li key={`${cell.sheet}-${cell.row}-${cell.column}-${index}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                        <span>{cell.label} · {cell.sheet} row {cell.row}, column {cell.column}</span>
                        <span><span className="text-slate-500">{cell.expectedValue || "blank"}</span> → <strong className="text-emerald-200">{cell.proposedValue}</strong></span>
                      </li>)}
                    </ul>
                  </div>}
                  {typeof payload.notes === "string" && payload.notes && <p className="mt-3 border-t border-slate-800 pt-3 text-sm text-slate-300"><strong>Notes:</strong> {payload.notes}</p>}
                  {typeof payload.deficiency_notes === "string" && payload.deficiency_notes && <p className="mt-2 text-sm text-amber-100"><strong>Follow-up:</strong> {payload.deficiency_notes}</p>}
                </article>
              );
            })}
          </section>
        )}

        {tab === "transfer" && (
          <section className="mt-5">
            <SectionHeading eyebrow="Weekly handoff" title="Corporate transfer review" trailing={<button type="button" onClick={downloadTransfer} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950">Download CSV</button>} />
            <p className="mt-2 max-w-4xl text-sm text-slate-400">This is a review/export only. It never changes the live corporate site or spreadsheet. The CSV includes the selected week’s daily and weekly checkboxes, that month’s checklist, scheduled inspection checklist responses, and the current quarter’s room dates.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">Routine checkbox cells</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{overallProgress.complete} / {overallProgress.total}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">Source forms due</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{formPeriods.length}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">Room-quarter completions</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{PM_ROOM_NUMBERS.filter(roomCompleted).length} / {PM_ROOM_NUMBERS.length}</p></div>
            </div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full min-w-[650px] text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase text-slate-400"><tr><th className="px-4 py-3">Cadence</th><th className="px-4 py-3">Checklist / form</th><th className="px-4 py-3">Progress</th><th className="px-4 py-3">Needs work</th></tr></thead>
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
                      <td className="px-4 py-3 capitalize text-slate-400">{template.cadence}</td>
                      <td className="px-4 py-3 font-medium">{template.title}</td>
                      <td className="px-4 py-3">{template.checklist.length ? `${checked} / ${total}` : record?.is_complete ? "Complete" : "Open"}</td>
                      <td className="px-4 py-3 text-amber-200">{issues || "—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <details className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
              <summary className="cursor-pointer font-semibold">Source records and transfer notes</summary>
              <ul className="mt-3 space-y-1 text-sm text-slate-400">
                <li>Routine schedules and monthly checkboxes: {PM_TEMPLATES.find((template) => template.id === PM_DAILY_TEMPLATE_ID)?.sourceFile}.</li>
                <li>Room-quarter dates: the yearly tabs and Room PM Checklist source.</li>
                <li>Interactive inspection fields: source PDF title and page are shown on each form.</li>
                <li>No existing corporate spreadsheet completion values were copied or overwritten by this interface.</li>
              </ul>
            </details>
          </section>
        )}

        {loading && <div role="status" className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">Loading live PM workbook and review proposals…</div>}
        {savingKey && savingKey !== "active-form" && savingKey !== "work-order" && <p className="mt-3 text-right text-xs text-slate-500">Saving your PM entry…</p>}
      </div>

      {activeForm && activeTemplate && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/80">
          <section role="dialog" aria-modal="true" aria-labelledby="pm-form-title" className="cmpri-modal-shell border border-slate-700 bg-slate-950 shadow-2xl">
            <header className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 rounded-t-2xl border-b border-slate-800 bg-slate-950/95 p-4 backdrop-blur sm:p-5">
              <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">{activeTemplate.cadence} PM form · {periodLabel(activeTemplate, activeForm.periodStart)}</p><h2 id="pm-form-title" className="mt-1 text-xl font-bold">{activeTemplate.title}{activeTemplate.scope === "room" ? ` · Room ${activeScopeKey.slice(5)}` : ""}</h2><SourceNote template={activeTemplate} /></div>
              <button type="button" onClick={() => { setActiveForm(null); setError(""); setMessage(""); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900">Close</button>
            </header>
            <div className="space-y-5 p-4 sm:p-5">
              {activeTemplate.instructions && <p className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100">{activeTemplate.instructions}</p>}
              {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}
              {message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 p-3 text-sm text-emerald-100">{message}</p>}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5"><p className="text-[11px] uppercase tracking-wide text-slate-500">Source period</p><p className="mt-1 text-sm font-semibold">{periodLabel(activeTemplate, activeForm.periodStart)}</p></div>
                {activeTemplate.kind !== "routine" && <label className="block"><span className="text-xs font-semibold text-slate-300">{activeTemplate.kind === "room" ? "Quarterly room PM completion date *" : "Completion date"}</span><input type="date" disabled={!canEdit || !!savingKey} value={completedOn} onChange={(event) => setCompletedOn(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white disabled:opacity-50" /></label>}
                {activeTemplate.scope === "room" && <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5"><p className="text-[11px] uppercase tracking-wide text-slate-500">Room</p><p className="mt-1 text-sm font-bold">{activeScopeKey.slice(5)}</p></div>}
                {activeTemplate.fields.map((field) => (
                  <FieldInput key={field.id} field={field} value={formData[field.id] || ""} disabled={!canEdit || !!savingKey} onChange={(value) => setFormData((current) => ({ ...current, [field.id]: value }))} />
                ))}
              </div>

              {activeTemplate.checklist.length > 0 && (
                <section>
                  <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-bold">Inspection checklist</h3><p className="mt-0.5 text-xs text-slate-500">Record each item as acceptable, needing follow-up, or not applicable.</p></div><span className="text-xs text-slate-400">{Object.keys(checklist).length} / {activeTemplate.checklist.length} reviewed</span></div>
                  <div className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800">
                    {activeTemplate.checklist.map((item) => (
                      <div key={item.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1"><p className="text-sm text-slate-200">{item.category && <span className="mr-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">{item.category}</span>}{item.label}</p><span className="text-[10px] text-slate-600">{item.source}</span></div>
                        <div className="flex shrink-0 gap-1">
                          {(["complete", "follow-up", "na"] as const).map((state) => <button key={state} type="button" disabled={!canEdit || !!savingKey} aria-pressed={checklist[item.id] === state} onClick={() => setChecklist((current) => ({ ...current, [item.id]: state }))} className={`rounded-md border px-2 py-1.5 text-[11px] font-bold ${checklist[item.id] === state ? statusStyle(state === "complete" ? true : state === "follow-up" ? state : "na") : "border-slate-700 text-slate-400 hover:border-slate-500"} disabled:opacity-40`}>{state === "complete" ? "✓ OK" : state === "follow-up" ? "/ Follow-up" : "N/A"}</button>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTemplate.repeatableFields && (
                <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-2"><div><h3 className="font-bold">{activeTemplate.repeatableLabel || "Inspection records"}</h3><p className="mt-0.5 text-xs text-slate-500">Add one row for each inspected device, valve, or test location.</p></div><button type="button" disabled={!canEdit || !!savingKey} onClick={() => setRepeatableRows((current) => [...current, {}])} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-emerald-200 disabled:opacity-40">Add row +</button></div>
                  <div className="mt-3 space-y-3">
                    {repeatableRows.map((row, index) => (
                      <div key={index} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                        <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Record {index + 1}</p><button type="button" disabled={!canEdit || !!savingKey} onClick={() => setRepeatableRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="text-xs text-red-300 hover:underline">Remove</button></div>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {activeTemplate.repeatableFields!.map((field) => <FieldInput key={field.id} field={field} value={row[field.id] || ""} disabled={!canEdit || !!savingKey} onChange={(value) => setRepeatableRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, [field.id]: value } : item))} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                <label className="block"><span className="text-xs font-semibold text-slate-300">Inspection notes</span><textarea disabled={!canEdit || !!savingKey} value={formNotes} onChange={(event) => setFormNotes(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400" placeholder="Record observations, readings, or context…" /></label>
                <label className="block"><span className="text-xs font-semibold text-amber-200">Deficiencies and follow-up plan</span><textarea disabled={!canEdit || !!savingKey} value={deficiencyNotes} onChange={(event) => setDeficiencyNotes(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-amber-500/30 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-400" placeholder="Describe what needs repair and the next step…" /></label>
              </div>

              {deficiencyNotes.trim() && canEdit && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-950/15 p-3">
                  <p className="text-sm font-bold text-amber-100">Create a linked work order</p>
                  <p className="mt-1 text-xs text-amber-100/70">The PM record is saved first. The work order will include the form source, inspection period, marked deficiencies, and your follow-up notes.</p>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="min-w-[240px] flex-1"><span className="text-xs font-semibold text-slate-300">Work-order location</span><select value={deficiencyLocationId} onChange={(event) => setDeficiencyLocationId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">Select location…</option>{locations.map((location) => <option key={location.id} value={location.id}>{[location.area, location.room_number, location.name].filter(Boolean).join(" · ")}</option>)}</select></label>
                    <button type="button" disabled={!canEdit || !!savingKey || !deficiencyLocationId} onClick={() => void createWorkOrderFromDeficiency()} className="rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40">{savingKey === "work-order" ? "Creating…" : "Save & create work order"}</button>
                  </div>
                </div>
              )}

              {pendingLinkMatchesForm && pendingWorkOrderLink && <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100"><span>Work order {pendingWorkOrderLink.displayId} exists but is not yet linked to this PM entry.</span><button type="button" disabled={!!savingKey} onClick={() => void retryPendingWorkOrderLink()} className="rounded-md border border-amber-400/40 px-3 py-1.5 font-bold disabled:opacity-40">Retry link</button></div>}
              {activeScopeEntry?.work_order_id && <button type="button" onClick={() => openLinkedWorkOrder(activeScopeEntry.work_order_id!)} className="rounded-lg border border-sky-500/30 bg-sky-950/25 px-3 py-2 text-sm font-semibold text-sky-200">Open linked work order</button>}

              <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-4">
                <button type="button" disabled={!canEdit || !!savingKey} onClick={() => void saveActive(false)} className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-bold text-slate-200 disabled:opacity-40">{savingKey === "active-form" ? "Saving…" : "Save draft"}</button>
                <button type="button" disabled={!canEdit || !!savingKey} onClick={() => void saveActive(true)} className="rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40">Mark complete</button>
              </footer>
            </div>
          </section>
        </div>
      )}
      {confirmingProposal && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/80">
          <section role="dialog" aria-modal="true" aria-labelledby="pm-confirm-title" className="cmpri-modal-shell border border-emerald-500/30 bg-slate-950 shadow-2xl">
            <p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">Explicit reviewer confirmation</p>
            <h2 id="pm-confirm-title" className="mt-1 text-xl font-bold text-white">Confirm live PM changes</h2>
            <p className="mt-2 text-sm text-slate-300">This applies the listed changes to the personal live PM workbook. The existing workbook sync remains responsible for corporate propagation.</p>
            {confirmingProposal.proposed_cells.length > 0 ? (
              <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm">
                {confirmingProposal.proposed_cells.map((cell, index) => <li key={`${cell.sheet}-${cell.row}-${cell.column}-${index}`} className="flex flex-wrap justify-between gap-2 border-b border-slate-800 pb-2 last:border-0 last:pb-0">
                  <span className="text-slate-200">{cell.label} · {cell.sheet} row {cell.row}, column {cell.column}</span>
                  <span><span className="text-slate-500">{cell.expectedValue || "blank"}</span> → <strong className="text-emerald-200">{cell.proposedValue}</strong></span>
                </li>)}
              </ul>
            ) : <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-slate-300">This proposal contains PDF checklist notes and measurements but no mapped workbook cells.</p>}
            {confirmingProposal.proposed_cells.length > 0 && !canWriteLivePm && <p role="alert" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-sm text-amber-100">Workbook writes are disabled in this environment. No changes can be applied until the dev review is complete and CMPRI_LIVE_PM_WRITES_ENABLED is enabled.</p>}
            <footer className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setConfirmingProposal(null)} className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-900">Cancel</button>
              <button type="button" disabled={reviewBusyId === confirmingProposal.id || (confirmingProposal.proposed_cells.length > 0 && !canWriteLivePm)} onClick={() => void reviewProposal(confirmingProposal, "approve")} className="rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">{reviewBusyId === confirmingProposal.id ? "Applying…" : "Confirm & approve"}</button>
            </footer>
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
