"use client";
import { pmIssueCandidates, pmIssueContext, pmIssueExternalId, pmSubmittedIssueLinks, pmTicketClosed, type PmIssue, type PmIssueLink } from "@/lib/pm/issues";
import { pmFieldGroups, pmRecordSummary } from "@/lib/pm/presentation";
import PmIssueDialog from "@/components/PmIssueDialog";
import FieldInput from "@/components/PmFieldInput";
import { linkedRoutineCompletion } from "@/lib/pm/completion-links";
import { pmEntryForm } from "@/lib/pm/entry-form";
import PmAnswerControls from "@/components/PmAnswerControls";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";
import { useResourceChange } from "@/lib/events/use-resource-change";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { loadCmpriSession } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { pmRoutineChecked, isPmRoutineSummary, isPmRoutineCellChecked } from "@/lib/pm/routine-responses";
import { findReferencedPmTemplate } from "@/lib/pm/references";
import { roomCompletion, type StoredRoomHistory } from "@/lib/pm/history";
import PmRecordedIssues from "@/components/PmRecordedIssues";
import PmSourceEvidence from "@/components/PmMaintenanceHistory";
import {
  findPmTemplate,
  PM_DAILY_TEMPLATE_ID,
  PM_ROOM_NUMBERS,
  PM_ROOM_TEMPLATE_ID,
  PM_TEMPLATES,
  PM_WEEKLY_TEMPLATE_ID,
  corporateWeeklyTemplate,
  PM_PROGRAM_HISTORY_TEMPLATES,
  pmWeekDates,
  pmWeekStart,
  quarterPeriodForDate,
  templatePeriodsForWeek,

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
  completion_review_required?: boolean;
  source_completion_verified?: boolean;
  unverified_completion_items?: string[];
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
type PmTab = "week" | "inspections" | "rooms" | "transfer" | "review" | "sources";
type ActiveForm = { templateId: string; periodStart: string; scopeKey: string };
type ChecklistState = "complete" | "follow-up" | "na" | "";
type IssueDetails = Record<string, { detail?: string; locationId?: string; flagged?: boolean }>;
type IssueLink = PmIssueLink;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_SHEETS = ["JAN", "FEB", "MAR", "APRIL", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"];
const TAB_OPTIONS: Array<{ id: PmTab; label: string }> = [
  { id: "week", label: "Weekly sheet" },
  { id: "inspections", label: "Inspection forms" },
  { id: "rooms", label: "Quarterly room PM" },
  { id: "sources", label: "Maintenance history" },
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
  return isPmRoutineCellChecked(liveTask?.targets || []);
}

function SourceNote({ template }: { template: PmTemplate }) {
  return <span className="text-[11px] text-slate-500">{template.sourceReference}</span>;
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
  const [roomHistory, setRoomHistory] = useState<StoredRoomHistory[]>([]);
  const [approvedRooms, setApprovedRooms] = useState<PmEntry[]>([]);
  const [approvedInspections, setApprovedInspections] = useState<PmEntry[]>([]);
  const [liveWorkbook, setLiveWorkbook] = useState<LivePmWorkbook | null>(null);
  const [reviewQueue, setReviewQueue] = useState<PmReviewProposal[]>([]);
  const [locations, setLocations] = useState<PmLocation[]>([]);
  const [accessRoles, setAccessRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [spreadsheetSyncEnabled, setSpreadsheetSyncEnabled] = useState(false);
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
  const [issueDetails, setIssueDetails] = useState<IssueDetails>({});
  const [issueLinks, setIssueLinks] = useState<IssueLink[]>([]);
  const [issueConfirmation, setIssueConfirmation] = useState<{ entry: PmEntry; issues: PmIssue[] } | null>(null);
  const [issueResults, setIssueResults] = useState<Record<string, { id?: string; error?: string }>>({});
  const [confirmingIssues, setConfirmingIssues] = useState(false);
  const [monthlyAttention, setMonthlyAttention] = useState<{ template: PmTemplate; period: string; itemId: string; detail: string; locationId: string } | null>(null);
  const [savingCell, setSavingCell] = useState("");
  const [checklist, setChecklist] = useState<Record<string, ChecklistState>>({});
  const [repeatableRows, setRepeatableRows] = useState<Array<Record<string, string>>>([]);
  const [formNotes, setFormNotes] = useState("");
  const [deficiencyNotes, setDeficiencyNotes] = useState("");
  const [completedOn, setCompletedOn] = useState("");
  const [confirmingProposal, setConfirmingProposal] = useState<PmReviewProposal | null>(null);
  const requestSequence = useRef(0);
  const busyEntries = useRef(new Set<string>());
  const [phoneRoutine, setPhoneRoutine] = useState("daily");
  const [phoneDay, setPhoneDay] = useState(0);
  const [phoneMonth, setPhoneMonth] = useState(0);
  const [phoneForm, setPhoneForm] = useState("");
  const [phonePeriod, setPhonePeriod] = useState("");
  const [phoneCatalog, setPhoneCatalog] = useState(false);
  const [phoneRecord, setPhoneRecord] = useState(0);
  const [routineMatchIds, setRoutineMatchIds] = useState<string[]>([]);
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
      const response = await fetch(`/api/preventive-maintenance?week=${encodeURIComponent(week)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (sequence !== requestSequence.current || !isCurrent()) return;
      if (!response.ok || !Array.isArray(result.entries) || !result.workbook) throw new Error(result.error || "Live PM records could not be loaded.");
      setIssueLinks(Array.isArray(result.issue_links) ? result.issue_links : []);
      setEntries(result.entries as PmEntry[]);
      setRoomHistory(Array.isArray(result.room_history) ? result.room_history : []);
      setApprovedRooms(Array.isArray(result.approved_rooms) ? result.approved_rooms : []);
      setApprovedInspections(Array.isArray(result.approved_inspections) ? result.approved_inspections : []);
      setLiveWorkbook(result.workbook as LivePmWorkbook);
      setReviewQueue(Array.isArray(result.review_queue) ? result.review_queue as PmReviewProposal[] : []);
      setLocations(Array.isArray(result.locations) ? result.locations as PmLocation[] : []);
      setAccessRoles(Array.isArray(result.access_roles) ? result.access_roles.filter((role: unknown): role is string => typeof role === "string") : []);
      setSpreadsheetSyncEnabled(result.spreadsheet_sync_enabled === true);
      setCanEdit(result.can_edit === true || result.can_review === true);
      setCanReview(result.can_review === true);
      setCanWriteLivePm(result.spreadsheet_sync_enabled === true && result.can_write_live_pm === true);
    } catch (cause) {
      if (sequence === requestSequence.current && isCurrent()) setError(cause instanceof Error ? cause.message : "PM records could not be loaded.");
    } finally {
      if (sequence === requestSequence.current && isCurrent()) setLoading(false);
    }
  }, []);
  useResourceChange("pm", () => { void loadWeek(weekStart); });
  useResourceChange("work-orders", () => { void loadWeek(weekStart); });

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
        for (const item of template.checklist) {
          if (isPmRoutineSummary(item.id)) continue;
          total += 1;
          if (routineStatus(template, period, item.id)) complete += 1;
        }
      }
    }
    return { complete, total, percent: total ? Math.round((complete / total) * 100) : 0 };
  }, [approvedInspections, entries, issueLinks, liveWorkbook, monthTemplates, recordsByKey, spreadsheetSyncEnabled, weekStart]);

  const deficientCount = useMemo(() => entries.reduce((count, entry) =>
    count + (findPmTemplate(entry.template_id) ? pmIssueCandidates(findPmTemplate(entry.template_id)!, entry).length : 0),
  0), [entries]);

  function entryFor(template: PmTemplate, periodStart: string, scopeKey = "property") {
    return recordsByKey.get(entryKey(template.id, periodStart, scopeKey));
  }

  function roomCompleted(room: string) {
    return roomState(room).complete;
  }

  function roomState(room: string) {
    const proposal = roomTemplate ? entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`) : undefined;
    const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
    const history = roomHistory.find(item => item.room === room && item.period_start === currentQuarterPeriod);
    const approved = approvedRooms.find(item => item.scope_key === `room:${room}` && item.period_start === currentQuarterPeriod);
    return roomCompletion(history, approved || proposal, spreadsheetSyncEnabled ? sourceDateIso(liveWorkbook?.rooms.find(item => item.room === room)?.quarters[quarter]?.value || "") : "");
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
    setEntries((current) => {
      const key = entryKey(saved.template_id, saved.period_start, saved.scope_key);
      const prior = current.find(entry => entryKey(entry.template_id, entry.period_start, entry.scope_key) === key);
      return [
        ...current.filter(entry => entryKey(entry.template_id, entry.period_start, entry.scope_key) !== key),
        saved.template_id.startsWith("workbook:")
          ? { ...saved, responses: { ...prior?.responses, ...saved.responses } }
          : saved,
      ];
    });
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
        ? "PM proposal approved in CMPRI. Google Sheets sync is disabled; no spreadsheet changes were made."
        : "PM proposal rejected. No Google Sheets changes were made.");
      await loadWeek(weekStart);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The PM proposal could not be reviewed.";
      await loadWeek(weekStart);
      setError(message);
    } finally {
      setReviewBusyId("");
    }
  }

  async function updateRoutine(template: PmTemplate, periodStart: string, itemId: string, checked: boolean | "follow-up", detail?: string, locationId?: string) {
    if (!canEdit || busyEntries.current.has(entryKey(template.id, periodStart))) return;
    const key = entryKey(template.id, periodStart);
    const existing = entryFor(template, periodStart);
    const currentResponses = Object.fromEntries(template.checklist.map((item) => [
      item.id,
      existing?.status === "pending" && Object.hasOwn(existing.responses || {}, item.id)
        ? existing.responses[item.id] === true
        : routineStatus(template, periodStart, item.id),
    ]));
    const responses = { ...currentResponses, [itemId]: checked };
    const isComplete = template.checklist.every((item) => responses[item.id] === true);
    busyEntries.current.add(key);
    setSavingKey(key);
    setSavingCell(`${key}:${itemId}`);
    setError("");
    setMessage("");
    try {
      const saved = await saveEntry({
        templateId: template.id,
        periodStart,
        scopeKey: "property",
        responses: { [itemId]: checked },
        formData: { ...existing?.form_data, pmIssueDetails: {
          ...((existing?.form_data?.pmIssueDetails as IssueDetails) || {}),
          ...(checked === "follow-up" ? { [`item:${itemId}`]: { detail: detail || "", locationId: locationId || "" } } : {}),
        } },
        notes: existing?.notes || "",
        deficiencyNotes: existing?.deficiency_notes || "",
        completedOn: isComplete ? today : null,
        isComplete,
        expectedRevision: existing?.revision || 0,
        workOrderId: existing?.work_order_id || null,
      });
      setMessage(`${template.title} change saved as pending review.`);
      if (checked === "follow-up") {
        setMonthlyAttention(null);
        openIssueConfirmation(saved, pmIssueCandidates(template, saved));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PM checkbox could not be saved.");
    } finally {
      setSavingCell("");
      busyEntries.current.delete(key);
      setSavingKey("");
    }
  }

  function openForm(template: PmTemplate, periodStart: string, scopeKey = "property") {
    const existing = entryFor(template, periodStart, scopeKey);
    setActiveForm({ templateId: template.id, periodStart, scopeKey });
    const historical=template.kind==='room'?roomHistory.find(row=>row.room===scopeKey.slice(5)&&row.period_start===periodStart):undefined;
    const saved = pmEntryForm(existing, historical);
    setFormData(saved.formData);
    setIssueDetails(existing?.form_data?.pmIssueDetails && typeof existing.form_data.pmIssueDetails === "object"
      ? existing.form_data.pmIssueDetails as IssueDetails : {});
    setChecklist(saved.checklist as Record<string, ChecklistState>);
    setPhoneRecord(0);
    setRepeatableRows((saved.logEntries || (template.repeatableFields ? [{}] : [])).map((row, index) => ({ ...row, _pmRowId: (row as Record<string, string>)._pmRowId || (saved.logEntries ? `legacy-${index}` : crypto.randomUUID()) })));
    setFormNotes(saved.notes);
    setDeficiencyNotes(saved.deficiencyNotes);
    setCompletedOn(saved.completedOn);

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
  const activeHistory = activeForm && activeTemplate?.kind === "room" ? roomHistory.find(item => item.room === activeScopeKey.slice(5) && item.period_start === activeForm.periodStart) : undefined;
  const activeCanEdit = canEdit
    && (!["pending", "processing"].includes(activeScopeEntry?.status || "") || activeScopeEntry?.can_edit_entry === true);
  const followUpItems = activeTemplate?.checklist.filter((item) => checklist[item.id] === "follow-up") || [];
  const activeIssues = activeTemplate ? pmIssueCandidates(activeTemplate, {
    responses: checklist, form_data: { ...formData, logEntries: repeatableRows, pmIssueDetails: issueDetails }, deficiency_notes: deficiencyNotes,
  }).map(issue => ({ ...issue, locationId: issue.locationId || locationForScope(activeScopeKey)?.id || "" })) : [];
  const issueTargets = activeTemplate ? [
    ...activeTemplate.fields.map(field => ({ key: `field:${field.id}`, label: field.label })),
    ...repeatableRows.flatMap((row, index) => (activeTemplate.repeatableFields || []).map(field => ({ key: `row:${row._pmRowId}:${field.id}`, label: `Record ${index + 1} — ${field.label}` }))),
    { key: "notes:follow-up", label: "Recorded follow-up notes" },
  ] : [];

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
    if (isComplete && activeIssues.some(issue => !issue.detail.trim())) return "Describe each flagged issue before finishing.";
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
    const formValues: Record<string, unknown> = { ...formData, pmIssueDetails: {
      ...issueDetails,
      ...Object.fromEntries(activeIssues.map(issue => [issue.key, { ...issueDetails[issue.key], detail: issue.detail, locationId: issue.locationId }])),
    } };
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
    if (!activeCanEdit) return;
    setSavingKey("active-form");
    setError("");
    setMessage("");
    try {
      const saved = await persistActive(isComplete);
      setActiveForm((current) => current ? { ...current, scopeKey: saved.scope_key } : current);
      if (isComplete && activeIssues.length) openIssueConfirmation(saved, activeIssues);
      setMessage(isComplete
        ? `${activeTemplate?.title || "PM form"} saved in CMPRI. Google Sheets sync is disabled.`
        : "PM draft saved in CMPRI. Google Sheets sync is disabled.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PM form could not be saved.");
    } finally {
      setSavingKey("");
    }
  }

  async function createWorkOrderFromDeficiency() {
    if (!activeCanEdit || !activeTemplate || !activeForm) return;
    // The manual action joins the same explicit confirmation, never a second creation path.
    setSavingKey("active-form");
    setError("");
    try {
      const saved = await persistActive(activeScopeEntry?.is_complete === true);
      setActiveForm(current => current ? { ...current, scopeKey: saved.scope_key } : current);
      if (!activeIssues.length) throw new Error("Mark Follow-up or flag a field, then describe the issue first.");
      openIssueConfirmation(saved, activeIssues);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare PM work orders."); }
    finally { setSavingKey(""); }
  }

  function openIssueConfirmation(entry: PmEntry, issues: PmIssue[]) {
    setIssueResults(Object.fromEntries(issues.flatMap(issue => {
      const existing = issueLinks.find(link => link.import_external_id === pmIssueExternalId(entry.template_id, entry.period_start, entry.scope_key, issue.key));
      return existing ? [[issue.key, { id: existing.id }]] : [];
    })));
    setIssueConfirmation({ entry, issues });
  }

  async function confirmIssueWorkOrders() {
    if (!issueConfirmation || confirmingIssues) return;
    setConfirmingIssues(true);
    const { entry, issues } = issueConfirmation;
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again before confirming work orders.");
      for (const issue of issues) {
        if (issueResults[issue.key]?.id) continue;
        try {
          const response = await fetch("/api/work-orders", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ orders: [{}], pm_submission: { confirmed: true, proposalId: entry.id, revision: entry.revision, issueKey: issue.key } }),
          });
          const result = await response.json().catch(() => ({}));
          const order = result.work_orders?.[0];
          if (!response.ok || !order?.id) throw new Error(result.error || "Could not confirm this issue. Retry checks the existing link first.");
          setIssueResults(current => ({ ...current, [issue.key]: { id: String(order.id) } }));
            if (window.parent !== window) window.parent.postMessage({
              type: "cmpri-pm-work-orders-confirmed",
              modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
            }, window.location.origin);
          const externalId = pmIssueExternalId(entry.template_id, entry.period_start, entry.scope_key, issue.key);
            setIssueLinks(current => [...current.filter(link => link.import_external_id !== externalId), { id: String(order.id), display_id: order.display_id, import_external_id: externalId, status: order.status }]);
        } catch (cause) {
          setIssueResults(current => ({ ...current, [issue.key]: { error: cause instanceof Error ? cause.message : "Confirmation failed." } }));
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign in again."); }
    finally { setConfirmingIssues(false); }
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
            entry?.status === "pending" ? "Pending review" : spreadsheetSyncEnabled ? "Current workbook" : "CMPRI only; sheet sync disabled",
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
        const completion = roomState(room);
        const historical = roomHistory.find(item => item.room === room && item.period_start === currentQuarterPeriod);
        rows.push([currentQuarterPeriod, "quarterly", roomTemplate.title, `Room ${room}`, completion.status, completion.date || (completion.complete ? "Date unknown" : ""), entry?.deficiency_notes || entry?.notes || "", historical ? `${historical.source_name}: ${historical.source_reference}` : roomTemplate.sourceReference, historical ? "Historical completion confirmed in CMPRI" : entry?.status || "Open"]);
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
  const dailyTasks = dailyTemplate.checklist.filter(item => !isPmRoutineSummary(item.id));
  const dailyCount = dailyTasks.length * weekDates.length;
  const openInspectionCount = formPeriods.filter(({ template, periodStart }) =>
    !entries.some((entry) => entry.template_id === template.id && entry.period_start === periodStart && entry.is_complete),
  ).length;
  const filteredRooms = PM_ROOM_NUMBERS.filter((room) => room.includes(roomSearch.trim()));

  function openRoutineReference(reference: string | null | undefined, period: string, weekly = false) {
    const template = findReferencedPmTemplate(reference, PM_TEMPLATES);
    if (!template) return;
    const formPeriod = template.cadence === "weekly" ? weekStart : period;
    const candidates = entries.filter(entry => entry.template_id === template.id && (
      entry.period_start === formPeriod || (template.cadence === "quarterly"
        && quarterPeriodForDate(entry.period_start) === quarterPeriodForDate(formPeriod))
    ));
    if (candidates.length > 1) {
        setPhoneForm(template.id);
        setPhonePeriod(candidates.find(entry => entry.period_start === formPeriod)?.period_start || candidates[0].period_start);
        setRoutineMatchIds(candidates.map(entry => entry.id));
      setTab("inspections");
        setMessage("Several saved inspections match this form and reporting period. Choose the intended saved record.");
      return;
    }
      setRoutineMatchIds([]);
    const saved = candidates[0];
    openForm(template, saved?.period_start || formPeriod, saved?.scope_key
      || (template.scope === "area" ? "area:property" : "property"));
    if (weekly && template.kind === "meeting") setTab("week");
  }

  function inspectionCard(template: PmTemplate, periodStart: string, omitRecordIds: string[] = []) {
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
            {saved.some(entry => entry.completion_review_required) && <p className="mt-2 text-xs text-amber-200">Recorded source answers are preserved. Whole-inspection completion still requires review; a recorded answer alone does not establish completion.</p>}
            {saved.filter((entry) => entry.scope_key !== newScope && !omitRecordIds.includes(entry.id)).map((entry) => (
              <button key={entry.id} type="button" onClick={() => openForm(template, periodStart, entry.scope_key)} className="ml-2 mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400">{entry.scope_key.replace(/^[^:]+:/, "")}{entry.is_complete ? " · done" : " · open"}</button>
            ))}
          </div>
          {(!existingSingle || !omitRecordIds.includes(existingSingle.id)) && <button type="button" onClick={() => openForm(template, periodStart, existingSingle?.scope_key || newScope)} className="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-bold text-slate-950">{!canEdit || (["pending", "processing"].includes(existingSingle?.status || "") && !existingSingle?.can_edit_entry) ? "View form" : existingSingle ? "Open form" : template.scope === "equipment" ? "Add inspection" : "Open form"}</button>}
        </div>
      </article>
    );
  }

  function routineStatus(template: PmTemplate, period: string, itemId: string) {
    const proposal = entryFor(template, period);
    const reference = template.checklist.find(item => item.id === itemId)?.source || "";
    if (template.id.startsWith("workbook:monthly:") && (proposal?.responses?.[itemId] === "follow-up" || attachedAttention(reference, period) || attachedPendingIssue(reference, period)
      || pmSubmittedIssueLinks(issueLinks, template.id, period, "property", `item:${itemId}`).length)) return false;
    const inspectionComplete = template.id.startsWith("workbook:monthly:")
      && linkedRoutineCompletion(reference, period, PM_TEMPLATES, approvedInspections);
    return pmRoutineChecked(proposal, itemId, spreadsheetSyncEnabled,
      sourceRoutineStatus(template, period, itemId, liveWorkbook) || inspectionComplete);
  }

  function canEditPeriod(template: PmTemplate, period: string) {
    const entry = entryFor(template, period);
    return canEdit && (!["pending", "processing"].includes(entry?.status || "") || entry?.can_edit_entry === true);
  }

  function attachedEntries(reference: string | null, period: string) {
    if (!reference) return [];
    const templates = reference.split(/[,\n]/).map(name => findReferencedPmTemplate(name, PM_TEMPLATES)).filter(Boolean);
    return entries.filter(entry => templates.some(template => template && entry.template_id === template.id
      && (template.cadence === "quarterly" ? quarterPeriodForDate(entry.period_start) === quarterPeriodForDate(period) : entry.period_start === period)));
  }

  function attachedTickets(reference: string | null, period: string) {
    return attachedEntries(reference, period).flatMap(entry => issueLinks.filter(link =>
      link.id === entry.work_order_id || link.import_external_id.startsWith(pmIssueContext(entry.template_id, entry.period_start, entry.scope_key))));
  }

  function attachedAttention(reference: string | null, period: string) {
    return attachedTickets(reference, period).length > 0 || attachedEntries(reference, period).some(entry => !!entry.work_order_id);
  }

  function attachedPendingIssue(reference: string | null, period: string) {
    return attachedEntries(reference, period).some(entry => {
      const template = PM_TEMPLATES.find(template => template.id === entry.template_id);
      return template && pmIssueCandidates(template, entry).some(issue => !pmSubmittedIssueLinks(issueLinks, entry.template_id, entry.period_start, entry.scope_key, issue.key).length);
    });
  }

  function renderRoutineTable(template: PmTemplate, periods: string[], heading: string, linkedReference?: (itemId: string) => string | null) {
    const savingFor = (period: string) => savingKey === entryKey(template.id, period);
    return (
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table data-phone-single={periods.length === 1 ? "" : undefined} data-phone-daily={template.cadence === "daily" ? "" : undefined} className="w-full min-w-[760px] border-collapse text-left">
          <thead className="bg-slate-900 text-xs text-slate-400">
            <tr><th className="sticky left-0 min-w-[270px] bg-slate-900 px-3 py-3">{heading}</th>{periods.map((period, index) => <th key={period} data-current-day={template.cadence === "daily" && index === phoneDay ? "" : undefined} className="min-w-20 px-2 py-3 text-center">{template.cadence === "daily" ? <><span className="block font-bold text-white">{DAY_LABELS[index]}</span><span>{dateLabel(period)}</span></> : <span>{periodLabel(template, period)}</span>}</th>)}</tr>
          </thead>
          <tbody>
            {template.checklist.map((item, index) => {
              const reference = linkedReference?.(item.id) || null;
              return (
              <tr key={item.id} className="border-t border-slate-800/80 hover:bg-slate-900/50">
                <th scope="row" className="sticky left-0 bg-slate-950 px-3 py-2.5 text-sm font-medium text-slate-200">
                  {item.category && <span data-repeated-category={index > 0 && template.checklist[index - 1].category === item.category ? "" : undefined} className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{item.category}</span>}
                  {item.label}
                  {findReferencedPmTemplate(reference, PM_TEMPLATES) && <button type="button" onClick={() => openRoutineReference(reference, periods[0], template.cadence === "weekly")} className="ml-2 text-[10px] font-bold text-emerald-300 hover:underline">Open attached form</button>}
                </th>
                {periods.map((period) => {
                  const monthly = template.id.startsWith("workbook:monthly:");
                  const submitted = monthly ? [...pmSubmittedIssueLinks(issueLinks, template.id, period, "property", `item:${item.id}`), ...attachedTickets(reference, period)] : [];
                  const attention = monthly && (submitted.length > 0 || attachedAttention(reference, period));
                  const pendingIssue = monthly && ((entryFor(template, period)?.responses?.[item.id] === "follow-up" && !pmSubmittedIssueLinks(issueLinks, template.id, period, "property", `item:${item.id}`).length) || attachedPendingIssue(reference, period));
                  const checked = !attention && !pendingIssue && routineStatus(template, period, item.id);
                  const sourceUnverified = entryFor(template, period)?.unverified_completion_items?.includes(item.id);
                  const hasPending = entryFor(template, period)?.status === "pending"
                    && Object.hasOwn(entryFor(template, period)?.responses || {}, item.id);
                  return (
                    <td key={period} data-current-day={template.cadence === "daily" && period === periods[phoneDay] ? "" : undefined} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={attention || (sourceUnverified && !checked) ? "mixed" : checked}
                        data-pm-attention={attention ? "true" : undefined}
                        data-pm-saving-period={savingFor(period) ? "true" : undefined}
                        aria-busy={savingCell === `${entryKey(template.id, period)}:${item.id}`}
                        aria-label={`${item.label} · ${dateLabel(period, { month: "long", day: "numeric", year: "numeric" })}${attention ? " · needs attention" : ""}${hasPending ? " · pending review" : ""}`}
                        disabled={!canEditPeriod(template, period) || !liveWorkbook || savingFor(period)}
                        onClick={() => {
                          if (attention) { if (submitted[0]) openLinkedWorkOrder(submitted[0].id); else openRoutineReference(reference, period, false); return; }
                          if (monthly && (checked || pendingIssue)) {
                            if (pendingIssue && entryFor(template, period)?.responses?.[item.id] !== "follow-up" && findReferencedPmTemplate(reference, PM_TEMPLATES)) { openRoutineReference(reference, period, false); return; }
                            const saved = (entryFor(template, period)?.form_data?.pmIssueDetails as IssueDetails)?.[`item:${item.id}`];
                            setMonthlyAttention({ template, period, itemId: item.id, detail: saved?.detail || "", locationId: saved?.locationId || "" });
                          } else void updateRoutine(template, period, item.id, !checked);
                        }}
                        className={`grid h-9 w-9 place-items-center rounded-lg border mx-auto transition ${attention ? "border-red-400 bg-red-950 text-red-100" : checked ? "border-emerald-400 bg-emerald-400 text-slate-950" : "border-slate-600 bg-slate-900 text-transparent hover:border-emerald-400"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 ${savingCell === `${entryKey(template.id, period)}:${item.id}` ? "cursor-wait" : ""}`}
                        title={sourceUnverified ? "Legacy completion preserved; source contains unrecorded tasks. Requires completion review." : hasPending ? "Pending reviewer confirmation" : undefined}
                      >{attention ? "×" : "✓"}</button>
                      {monthly && checked && !attention && <button type="button" disabled={!canEditPeriod(template, period) || savingFor(period)} className="block mx-auto text-xs text-slate-400" onClick={() => void updateRoutine(template, period, item.id, false)}>Clear</button>}
                      {hasPending && <span className="block text-[10px] text-slate-400">Pending review</span>}
                      {pendingIssue && <span className="block text-xs text-slate-300">Ticket pending</span>}
                      {submitted.filter(pmTicketClosed).map(link => <span key={link.id} className="block text-[10px] text-slate-300" title={`Ticket ${link.display_id || link.id} closed; inspection result retained`}>Ticket closed</span>)}
                      {sourceUnverified && <span className="block text-xs text-amber-200">Completion unverified</span>}
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

  const dailyDone = dailyTasks.reduce((sum, item) =>
    sum + weekDates.filter((date) => routineStatus(dailyTemplate, date, item.id)).length, 0,
  );
  const monthRoutineDone = monthTemplates.reduce((sum, template) => {
    const period = templatePeriodsForWeek(template, weekStart)[0];
    return sum + template.checklist.filter((item) => routineStatus(template, period, item.id)).length;
  }, 0);
  const monthRoutineTotal = monthTemplates.reduce((sum, template) => sum + template.checklist.length, 0);

  const phoneForms = PM_TEMPLATES.filter(template => template.id.startsWith("pdf:") && template.kind !== "room");
  const selectedPhoneForm = phoneForms.find(template => template.id === phoneForm) || formPeriods[0]?.template || phoneForms[0];
  const selectedPhonePeriods = selectedPhoneForm ? [...new Set([
    ...formPeriods.filter(item => item.template.id === selectedPhoneForm.id).map(item => item.periodStart),
    ...entries.filter(entry => entry.template_id === selectedPhoneForm.id).map(entry => entry.period_start),
    defaultFormPeriod(selectedPhoneForm, weekStart),
  ])].sort().reverse() : [];
  const selectedPhonePeriod = selectedPhonePeriods.includes(phonePeriod) ? phonePeriod : selectedPhonePeriods.find(period => formPeriods.some(item => item.template.id === selectedPhoneForm?.id && item.periodStart === period)) || selectedPhonePeriods[0];

  return (
    <main data-pm-mobile className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5 lg:px-7">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.22em] text-emerald-300">CMPRI · Preventive Maintenance</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Preventive Maintenance</h1>
            <p className="pm-desktop-only mt-1 max-w-3xl text-sm text-slate-400">Weekly checklist, room-quarter completion dates, and interactive source forms. Technician changes remain pending until a reviewer explicitly confirms them.</p>
          </div>
          <div className="pm-desktop-only flex flex-wrap items-center gap-2">
            <ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-slate-900">Dashboard</ModalDashboardLink>
            <button type="button" onClick={downloadTransfer} className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-900/40">Export weekly CSV</button>
          </div>
        </header>
        <PmRecordedIssues locations={locations} links={issueLinks} onOpen={openLinkedWorkOrder} onHistory={() => setTab("sources")} onLinked={link => {
          setIssueLinks(current => [...current.filter(item => item.import_external_id !== link.import_external_id), link]);
          if (window.parent !== window) window.parent.postMessage({type:"cmpri-pm-work-orders-confirmed",modalToken:new URLSearchParams(window.location.search).get("modalToken") || ""}, window.location.origin);
        }} />


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
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Routine items</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{overallProgress.complete}<span className="text-sm font-medium text-slate-500"> / {overallProgress.total}</span></p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Weekly progress</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{overallProgress.percent}%</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Forms still open</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold">{openInspectionCount}</p></div>
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-3"><p className="text-xs text-slate-500">Needs follow-up</p><p className="cmpri-modal-kpi-value mt-1 text-xl font-bold text-amber-200">{deficientCount}</p></div>
          </div>
        </section>
        <div role="note" className="pm-desktop-only mt-3 rounded-xl border border-sky-500/30 bg-sky-950/20 px-4 py-3 text-sm text-sky-100">
          Google Sheets sync is temporarily disabled for troubleshooting. PM checklist and form changes are stored in CMPRI only; this workspace will not read from or write to Google Sheets.
        </div>

        <details className="pm-phone-only phone-about"><summary>Workspace information &amp; export</summary><p>Technician edits remain pending until reviewed. Checklist completion and equipment condition are separate.</p><p>Google Sheets synchronization is disabled; this workspace uses CMPRI records.</p><button type="button" onClick={downloadTransfer}>Export weekly CSV</button></details>
        <label className="pm-phone-only phone-picker">Workspace<select aria-label="Mobile PM section" value={tab} onChange={event => setTab(event.target.value as PmTab)}>{TAB_OPTIONS.filter(item => item.id !== "review" || canReview).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <nav className="pm-desktop-only mt-4 flex gap-2 overflow-x-auto border-b border-slate-800 pb-2" aria-label="PM sections">
          {TAB_OPTIONS.filter((item) => item.id !== "review" || canReview).map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)} className={`shrink-0 rounded-lg px-4 py-2 text-sm font-bold transition ${tab === item.id ? "bg-emerald-400 text-slate-950" : "border border-slate-800 text-slate-300 hover:bg-slate-900"}`}>{item.label}{item.id === "review" && reviewQueue.length > 0 ? ` (${reviewQueue.length})` : ""}</button>)}
        </nav>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">{error}</div>}
        {message && !activeForm && <div role="status" className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/25 p-3 text-sm text-emerald-100">{message}</div>}
        {!canEdit && !loading && !error && <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-sm text-amber-100">The PM service resolved this session as read-only{accessRoles.length ? ` (roles: ${accessRoles.join(", ")})` : ""}. If you are a System Administrator, this role result is incorrect and should be reported to an administrator.</div>}
        {!spreadsheetSyncEnabled && !loading && !error && <div role="status" className="pm-desktop-only mt-4 rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 text-sm text-amber-100">Google Sheets integration is disconnected. Checklist states show CMPRI records only; edits and approvals will not be synchronized to the spreadsheet.</div>}
        {loading && liveWorkbook && <div role="status" className="mt-4 rounded-xl border border-sky-500/30 bg-sky-950/20 p-3 text-sm text-sky-100">Refreshing PM records. You can continue using the last loaded checklist; saves are checked against the latest server revision.</div>}

        {tab === "week" && (
          <div className="pm-routines mt-5 space-y-7">
            <div className="pm-phone-only phone-switch" aria-label="Routine frequency">{["daily", "weekly", "monthly", "history"].map(value => <button key={value} type="button" aria-pressed={phoneRoutine === value} onClick={() => setPhoneRoutine(value)}>{value}</button>)}</div>
            <section className={phoneRoutine === "daily" ? "" : "pm-desktop-only"}>
              <SectionHeading eyebrow="Workbook · daily checkbox grid" title="Daily maintenance" trailing={<span className="text-xs text-slate-400">{dailyDone} / {dailyCount} complete</span>} />
              <p className="pm-desktop-only mb-3 mt-1 text-xs text-slate-500">Each checkbox saves separately for its date. Pool readings are entered in the Pool Log, with a shortcut from its linked form below.</p>
              <div className="pm-phone-only phone-days" aria-label="Daily task date">{weekDates.map((date, index) => <button key={date} type="button" aria-pressed={phoneDay === index} onClick={() => setPhoneDay(index)}>{DAY_LABELS[index]}<span>{dateLabel(date, { day: "numeric" })}</span></button>)}</div>
              {renderRoutineTable(dailyTemplate, weekDates, "Routine task")}
            </section>

            <section className={phoneRoutine === "weekly" ? "" : "pm-desktop-only"}>
              <SectionHeading eyebrow="Live workbook · one completion per week" title="Weekly maintenance" trailing={<span className="text-xs text-slate-400">{weeklyTemplate.checklist.filter((item) => routineStatus(weeklyTemplate, weekStart, item.id)).length} / {weeklyTemplate.checklist.length} complete</span>} />
              <div className="mt-3">
                {renderRoutineTable(weeklyTemplate, [weekStart], "Weekly task", (itemId) => weeklyTemplate.checklist.find((item) => item.id === itemId)?.source?.endsWith(".pdf") ? weeklyTemplate.checklist.find((item) => item.id === itemId)!.source! : null)}
              </div>
            </section>

            <section className={phoneRoutine === "history" ? "" : "pm-desktop-only"}>
              <SectionHeading eyebrow="Original corporate week slots" title="Weekly history by month" />
              <p className="mt-2 text-sm text-slate-400">WK1–WK5 preserve the workbook headings. The month identifies the reporting period, not an exact inspection date. Summary checks do not fill individual tasks.</p>
              {renderRoutineTable(corporateWeeklyTemplate, [`${weekStart.slice(0, 7)}-01`], "Corporate weekly task")}
            </section>

            <div className={phoneRoutine === "monthly" ? "pm-phone-only phone-switch" : "pm-hidden"} aria-label="Monthly reporting period">{monthTemplates.map((template, index) => <button key={template.id} type="button" aria-pressed={Math.min(phoneMonth, monthTemplates.length - 1) === index} onClick={() => setPhoneMonth(index)}>{dateLabel(templatePeriodsForWeek(template, weekStart)[0], { month: "long", year: "numeric" })}</button>)}</div>
            {monthTemplates.map((template, index) => {
              const period = templatePeriodsForWeek(template, weekStart)[0];
              return (
                <section key={template.id} className={phoneRoutine === "monthly" && index === Math.min(phoneMonth, monthTemplates.length - 1) ? "" : "pm-desktop-only"}>
                  <SectionHeading eyebrow={`${template.title} · workbook checkboxes`} title={`${dateLabel(period, { month: "long", year: "numeric" })} monthly tasks`} trailing={<span className="text-xs text-slate-400">{template.checklist.filter((item) => routineStatus(template, period, item.id)).length} / {template.checklist.length} complete</span>} />
                  <div className="mt-3">
                    {renderRoutineTable(template, [period], "Monthly task", (itemId) => template.checklist.find((item) => item.id === itemId)?.source || null)}
                  </div>
                </section>
              );
            })}

            {PM_PROGRAM_HISTORY_TEMPLATES.filter(template => String(template.sourceYear) === weekStart.slice(0, 4)).map(template => (
              <section key={template.id} className={phoneRoutine === "history" ? "" : "pm-desktop-only"}>
                <SectionHeading eyebrow="Corporate annual grid" title={template.title} />
                <p className="mt-2 text-sm text-slate-400">{template.instructions}</p>
                {renderRoutineTable(template, [`${template.sourceYear}-01-01`], "Recorded area / compliance task")}
              </section>
            ))}

            <button className="pm-phone-only phone-form-link" type="button" onClick={() => setTab("inspections")}>Open inspection forms &amp; saved records</button>
            <section className="pm-desktop-only">
              <SectionHeading eyebrow="PDF checklists and logs" title="Inspections due this week" trailing={<button type="button" onClick={() => setTab("inspections")} className="text-sm font-bold text-emerald-300 hover:underline">Browse all forms</button>} />
              {formPeriods.length ? <div className="mt-3 grid gap-3 xl:grid-cols-2">{formPeriods.map(({ template, periodStart }) => inspectionCard(template, periodStart))}</div> : <p className="mt-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">No separate PDF forms are scheduled for this week.</p>}
              {monthRoutineTotal > 0 && <p className="mt-3 text-xs text-slate-500">Monthly checklist checkboxes completed: {monthRoutineDone} / {monthRoutineTotal}. Keep the checklist and linked inspection form in sync.</p>}
            </section>
          </div>
        )}

        {tab === "inspections" && (
          <div className="mt-5 space-y-7">
            <section className="pm-phone-only phone-form-picker">
              <label className="phone-picker">Inspection<select aria-label="Inspection type" value={selectedPhoneForm?.id || ""} onChange={event => { setPhoneForm(event.target.value); setPhonePeriod(""); setRoutineMatchIds([]); }}>{phoneForms.map(template => <option key={template.id} value={template.id}>{template.title}</option>)}</select></label>
              <label className="phone-picker">Reporting period<select aria-label="Inspection period" value={selectedPhonePeriod || ""} onChange={event => { setPhonePeriod(event.target.value); setRoutineMatchIds([]); }}>{selectedPhonePeriods.map(period => <option key={period} value={period}>{selectedPhoneForm ? periodLabel(selectedPhoneForm, period) : period}{entries.some(entry => entry.template_id === selectedPhoneForm?.id && entry.period_start === period) ? " — saved records" : ""}</option>)}</select></label>
              {selectedPhoneForm && routineMatchIds.length > 1 && <div role="group" aria-label="Matching saved inspections">
                {entries.filter(entry => entry.template_id === selectedPhoneForm.id && routineMatchIds.includes(entry.id)).map(entry => <button key={entry.id} type="button" className="phone-form-link" onClick={() => { setPhonePeriod(entry.period_start); openForm(selectedPhoneForm, entry.period_start, entry.scope_key); }}>{periodLabel(selectedPhoneForm, entry.period_start)} · {entry.scope_key.replace(/^[^:]+:/, "")} · {entry.is_complete ? "Complete" : "Recorded answers"}</button>)}
              </div>}
              {selectedPhoneForm && selectedPhonePeriod && inspectionCard(selectedPhoneForm, selectedPhonePeriod, routineMatchIds)}
              <button className="phone-form-link" type="button" aria-expanded={phoneCatalog} onClick={() => setPhoneCatalog(value => !value)}>{phoneCatalog ? "Hide" : "Browse"} complete form catalog &amp; history</button>
            </section>
            <section className="pm-desktop-only">
              <SectionHeading eyebrow="Source PDFs · interactive CMPRI forms" title="Forms due in the selected week" />
              <p className="mt-1 text-sm text-slate-400">Checklist marks support complete, needs follow-up, and N/A. Log forms include repeatable inspection rows, measurements, repair dates, initials, and notes where required.</p>
              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {formPeriods.map(({ template, periodStart }) => inspectionCard(template, periodStart))}
              </div>
              {!formPeriods.length && <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">No scheduled source forms for this week.</p>}
            </section>
            <section className={phoneCatalog ? "" : "pm-desktop-only"}>
              <SectionHeading eyebrow="Source checklist" title="All imported forms" />
              <p className="mt-1 text-xs text-slate-500">The source catalog covers 33 PDFs; the duplicated Fitness Center file is represented once. Source document and page are retained on each form.</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {PM_TEMPLATES.filter((template) => template.id.startsWith("pdf:") && template.kind !== "room").map((template) => {
                  const period = defaultFormPeriod(template, weekStart);
                  const records = entries.filter((entry) => entry.template_id === template.id);
                  return (
                    <article key={template.id} className={`${selectedPhoneForm?.id === template.id ? "pm-desktop-only" : ""} rounded-xl border border-slate-800 bg-slate-900/70 p-3`}>
                      <div className="flex items-start justify-between gap-2">
                        <div><p className="font-semibold">{template.title}</p><p className="mt-1 text-xs text-slate-500">{template.cadence} · {template.scope} · {template.checklist.length} items</p></div>
                        <button type="button" onClick={() => openForm(template, period, template.scope === "equipment" ? "property" : template.scope === "area" ? "area:property" : "property")} className="rounded-md border border-slate-700 px-2 py-1 text-xs font-bold text-emerald-200">{canEdit ? "New" : "View form"}</button>
                      </div>
                      <SourceNote template={template} />
                      {records.map((entry) => <button key={entry.id} type="button" onClick={() => openForm(template, entry.period_start, entry.scope_key)} className="mr-1 mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200">{periodLabel(template, entry.period_start)} · {entry.scope_key.replace(/^[^:]+:/, "")} · {entry.is_complete ? "Complete" : "Recorded answers"}</button>)}
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
              <table className="pm-phone-stack w-full min-w-[620px] text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Room</th><th className="px-4 py-3">Quarterly PM date</th><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th></tr></thead>
                <tbody>{filteredRooms.map((room) => {
                  const entry = entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
                  const completion = roomState(room);
                  const displayDate = completion.date;
                  const historical = roomHistory.find(item => item.room === room && item.period_start === currentQuarterPeriod);
                  const roomRank = String(entry?.form_data?.rank || "—");
                  return <tr key={room} className="border-t border-slate-800/80">
                    <th className="px-4 py-3 font-bold">Room {room}</th>
                      <td data-label="Quarterly PM date" className="px-4 py-3">{sourceDateIso(displayDate) ? dateLabel(sourceDateIso(displayDate), { month: "short", day: "numeric", year: "numeric" }) : completion.complete ? "Date unknown" : "—"}{historical && <details className="mt-1 text-xs text-slate-400"><summary>Historical source</summary>{historical.source_name} · {historical.source_reference}<p>Whole room complete; checklist answers unchanged.</p></details>}</td>
                    <td data-label="Rank" className="px-4 py-3 text-slate-300">{roomRank}</td>
                      <td data-label="Status" className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-xs ${completion.status === "Pending review" ? "border-amber-500/40 bg-amber-950/30 text-amber-100" : completion.complete ? "border-emerald-500/30 bg-emerald-950/30 text-emerald-200" : "border-slate-700 text-slate-400"}`}>{completion.status}</span></td>
                    <td data-label="Actions" className="px-4 py-3 text-right"><button type="button" onClick={() => openForm(roomTemplate, currentQuarterPeriod, `room:${room}`)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:border-emerald-400">{!canEdit || (["pending", "processing"].includes(entry?.status || "") && !entry?.can_edit_entry) ? "View PM form" : entry ? "Open PM" : "Start PM"}</button></td>
                  </tr>;
                })}
                  {filteredRooms.length === 0 && <tr><td colSpan={5} role="status" className="border-t border-slate-800/80 px-4 py-5 text-center text-slate-400">No rooms match “{roomSearch.trim()}”.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "review" && canReview && (
          <section className="mt-5 space-y-4">
            <SectionHeading eyebrow="Reviewer-only · explicit approval" title="Pending PM changes" trailing={<span className="rounded-full border border-amber-500/40 bg-amber-950/30 px-3 py-1 text-xs text-amber-100">{reviewQueue.length} awaiting review</span>} />
            <p className="max-w-4xl text-sm text-slate-400">Technician work is staged in CMPRI. Spreadsheet sync is disabled, so approvals update CMPRI records only and do not change Google Sheets.</p>
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
                  {template && pmIssueCandidates(template, { responses: proposedResponses, form_data: proposedFormData }).map(issue => <div key={issue.key} className="mt-2 rounded border border-slate-700 p-2 text-sm"><strong>{issue.label}</strong><p>{issue.detail || "Issue description not recorded"}</p><p>{locations.find(location => location.id === issue.locationId)?.name || "Work-order location not selected"}</p></div>)}
                  {typeof payload.notes === "string" && payload.notes && <p className="mt-3 border-t border-slate-800 pt-3 text-sm text-slate-300"><strong>Notes:</strong> {payload.notes}</p>}
                  {typeof payload.deficiency_notes === "string" && payload.deficiency_notes && <p className="mt-2 text-sm text-amber-100"><strong>Follow-up:</strong> {payload.deficiency_notes}</p>}
                </article>
              );
            })}
          </section>
        )}

        {tab === "sources" && <PmSourceEvidence canReview={canReview} />}

        {tab === "transfer" && (
          <section className="mt-5">
            <SectionHeading eyebrow="Weekly handoff" title="Corporate transfer review" trailing={<button type="button" onClick={downloadTransfer} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950">Download CSV</button>} />
            <p className="mt-2 max-w-4xl text-sm text-slate-400">This is a CMPRI review/export only and does not change Google Sheets. The CSV includes CMPRI checklist responses, scheduled inspection forms, and room completion records.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">Routine checkbox cells</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{overallProgress.complete} / {overallProgress.total}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">Source forms due</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{formPeriods.length}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">Room-quarter completions</p><p className="cmpri-modal-kpi-value mt-1 text-2xl font-bold">{PM_ROOM_NUMBERS.filter(roomCompleted).length} / {PM_ROOM_NUMBERS.length}</p></div>
            </div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
              <table className="pm-phone-stack w-full min-w-[650px] text-left text-sm">
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
                    const checked = template.kind === "routine"
                      ? (isDaily ? weekDates : [period]).reduce((count, date) => count
                        + template.checklist.filter(item => routineStatus(template, date, item.id)).length, 0)
                      : template.checklist.filter((item) => {
                        const value = record?.responses?.[item.id];
                        return value === true || value === "complete" || value === "na";
                      }).length;
                    const total = isDaily ? template.checklist.length * weekDates.length : template.checklist.length;
                    const issues = records.reduce((count, entry) =>
                      count + pmIssueCandidates(template, entry).length, 0,
                    );
                    return <tr key={`${template.id}:${period}`} className="border-t border-slate-800">
                      <td data-label="Cadence" className="px-4 py-3 capitalize text-slate-400">{template.cadence}</td>
                      <td data-label="Checklist / form" className="px-4 py-3 font-medium">{template.title}</td>
                      <td data-label="Progress" className="px-4 py-3">{template.checklist.length ? `${checked} / ${total}` : record?.is_complete ? "Complete" : "Open"}</td>
                      <td data-label="Needs work" className="px-4 py-3 text-amber-200">{issues || "—"}</td>
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

        {loading && <div role="status" className="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">Loading PM records…</div>}
        {savingKey && savingKey !== "active-form" && savingKey !== "work-order" && <p className="mt-3 text-right text-xs text-slate-500">Saving your PM entry…</p>}
      </div>

      {activeForm && activeTemplate && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/80">
          <section role="dialog" aria-modal="true" aria-labelledby="pm-form-title" className="pm-inspection cmpri-modal-shell border border-slate-700 bg-slate-950 shadow-2xl">
            <header className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 rounded-t-2xl border-b border-slate-800 bg-slate-950/95 p-4 backdrop-blur sm:p-5">
              <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">{activeTemplate.cadence} PM form · {periodLabel(activeTemplate, activeForm.periodStart)}</p><h2 id="pm-form-title" className="mt-1 text-xl font-bold">{activeTemplate.title}{activeTemplate.scope === "room" ? ` · Room ${activeScopeKey.slice(5)}` : ""}</h2><SourceNote template={activeTemplate} /></div>
              <button type="button" onClick={() => { setActiveForm(null); setError(""); setMessage(""); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900">Close</button>
            </header>
            <div className="pm-inspection-body space-y-5 p-4 sm:p-5">


              {activeTemplate.instructions && <p className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-100">{activeTemplate.instructions}</p>}



              <section className="pm-form-section"><h3 className="pm-field-heading">Current inspection</h3><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5"><p className="text-[11px] uppercase tracking-wide text-slate-500">Source period</p><p className="mt-1 text-sm font-semibold">{periodLabel(activeTemplate, activeForm.periodStart)}</p></div>
                {activeTemplate.kind !== "routine" && <label className="block"><span className="text-xs font-semibold text-slate-300">{activeTemplate.kind === "room" ? "Quarterly room PM completion date *" : "Completion date"}</span><input type="date" disabled={!activeCanEdit || !!savingKey} value={completedOn} onChange={(event) => setCompletedOn(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white disabled:opacity-50" /></label>}
                {activeTemplate.scope === "room" && <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5"><p className="text-[11px] uppercase tracking-wide text-slate-500">Room</p><p className="mt-1 text-sm font-bold">{activeScopeKey.slice(5)}</p></div>}
              </div>
                {pmFieldGroups(activeTemplate.fields).map(group => <fieldset key={group.title} className="pm-field-group"><legend className="pm-field-heading">{group.title}</legend><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.fields.map(field => <FieldInput key={field.id} field={field.label === "Inspection notes" ? { ...field, label: "Form inspection notes" } : field} value={formData[field.id] || ""} disabled={!activeCanEdit || !!savingKey} onChange={(value) => setFormData((current) => ({ ...current, [field.id]: value }))} />)}
                </div></fieldset>)}
              </section>

              {activeTemplate.checklist.length > 0 && (
                <section>
                  <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-bold">Inspection checklist</h3><p className="mt-0.5 text-xs text-slate-500">Record each item as acceptable, needing follow-up, or not applicable.</p></div><span className="text-xs text-slate-400">{activeHistory ? `Historically completed · ${Object.keys(checklist).length} condition answers recorded` : `${Object.keys(checklist).length} / ${activeTemplate.checklist.length} reviewed`}</span></div>
                  <div className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800">
                    {activeTemplate.checklist.map((item) => (
                      <div key={item.id} className="pm-checklist-row flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1"><p className="text-sm text-slate-200">{item.category && <span className="mr-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">{item.category}</span>}{item.label}</p><span className="text-[10px] text-slate-600">{item.source}</span></div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1">
                          <PmAnswerControls label={item.label} value={checklist[item.id] || ""} historicalCompleted={!!activeHistory} disabled={!activeCanEdit || !!savingKey} onChange={state => setChecklist(current => ({...current, [item.id]: state as ChecklistState}))} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTemplate.repeatableFields && (
                <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-2"><div><h3 className="font-bold">{activeTemplate.repeatableLabel || "Inspection records"}</h3><p className="mt-0.5 text-xs text-slate-500">Add one row for each inspected device, valve, or test location.</p></div><button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => setRepeatableRows((current) => [...current, { _pmRowId: crypto.randomUUID() }])} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-emerald-200 disabled:opacity-40">Add row +</button></div>
                  <div className="mt-3 space-y-3">
                    {repeatableRows.map((row, index) => (
                      <div key={row._pmRowId || index} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                        <div className="pm-record-heading flex items-center justify-between"><p className="pm-desktop-only text-xs font-bold uppercase tracking-wide text-slate-500">Record {index + 1}</p><button type="button" className="pm-phone-only phone-record-toggle" aria-expanded={phoneRecord === index} onClick={() => setPhoneRecord(phoneRecord === index ? -1 : index)}>{pmRecordSummary(activeTemplate.repeatableFields!, row, index)}</button><button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => setRepeatableRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="pm-record-remove text-xs text-red-300 hover:underline" aria-label={`Remove record ${index + 1}`}>Remove</button></div>
                        <div className={`${phoneRecord === index ? "" : "pm-desktop-only"} mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3`}>
                          {activeTemplate.repeatableFields!.map((field) => <FieldInput key={field.id} field={field} value={row[field.id] || ""} disabled={!activeCanEdit || !!savingKey} onChange={(value) => setRepeatableRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, [field.id]: value } : item))} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="pm-form-section"><h3 className="pm-field-heading">Maintenance notes and follow-up</h3><div className="grid gap-3 lg:grid-cols-2">
                <label className="block"><span className="text-xs font-semibold text-slate-300">Maintenance notes</span><textarea disabled={!activeCanEdit || !!savingKey} value={formNotes} onChange={(event) => setFormNotes(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-400" placeholder="Record observations, readings, or context…" /></label>
                <label className="block"><span className="text-xs font-semibold text-amber-200">Deficiencies and follow-up plan</span><textarea disabled={!activeCanEdit || !!savingKey} value={deficiencyNotes} onChange={(event) => setDeficiencyNotes(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-amber-500/30 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-400" placeholder="Describe what needs repair and the next step…" /></label>
              </div></section>

              <section className="rounded-xl border border-slate-700 p-3" aria-label="PM work-order issues">
                <h3 className="font-bold">Issues for work-order confirmation</h3>
                <p className="text-xs text-slate-400">Follow-up and field-specific failures appear here. No work order is created until you confirm. Draft saving does not create orders.</p>
                <label className="block mt-2 text-sm">Report an issue with a field
                  <select value="" disabled={!activeCanEdit || !!savingKey} className="block w-full bg-slate-900 p-2" onChange={event => { const key = event.target.value; if (key) setIssueDetails(current => ({ ...current, [key]: { ...current[key], flagged: true, ...(key === "notes:follow-up" ? { detail: deficiencyNotes } : {}) } })); }}>
                    <option value="">Select field or notes</option>{issueTargets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}
                  </select>
                </label>
                {activeIssues.map(issue => <fieldset key={issue.key} className="mt-3 border-t border-slate-700 pt-2"><legend className="text-sm font-semibold">{issue.label}</legend>
                  <label className="block text-xs">Issue description<textarea disabled={!activeCanEdit || !!savingKey} className="block w-full bg-slate-900 p-2 text-sm" value={issue.detail} onChange={event => setIssueDetails(current => ({ ...current, [issue.key]: { ...current[issue.key], detail: event.target.value } }))} /></label>
                  <label className="block text-xs mt-1">Work-order location<select disabled={!activeCanEdit || !!savingKey} className="block w-full bg-slate-900 p-2 text-sm" value={issue.locationId} onChange={event => setIssueDetails(current => ({ ...current, [issue.key]: { ...current[issue.key], locationId: event.target.value } }))}><option value="">Select location</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
                  {issueDetails[issue.key]?.flagged && <button type="button" disabled={!activeCanEdit || !!savingKey} className="text-xs text-slate-300" onClick={() => setIssueDetails(current => ({ ...current, [issue.key]: { ...current[issue.key], flagged: false } }))}>Clear manual issue flag</button>}
                </fieldset>)}
                <button type="button" disabled={!activeCanEdit || !!savingKey || !activeIssues.length} onClick={() => void createWorkOrderFromDeficiency()} className="mt-3 rounded-lg border border-slate-600 px-3 py-2">Save &amp; review work orders</button>
                {issueLinks.filter(link => link.import_external_id.startsWith(pmIssueContext(activeTemplate.id, activeForm.periodStart, activeScope(activeTemplate, activeForm.scopeKey)))).map(link => <button type="button" className="block text-sm text-sky-300 mt-2" key={link.id} onClick={() => openLinkedWorkOrder(link.id)}>Open PM work order {link.display_id || link.id}{pmTicketClosed(link) && <span className="block text-xs text-slate-300">Ticket closed · inspection result retained</span>}</button>)}
              </section>

              {activeScopeEntry?.work_order_id && <button type="button" onClick={() => openLinkedWorkOrder(activeScopeEntry.work_order_id!)} className="rounded-lg border border-sky-500/30 bg-sky-950/25 px-3 py-2 text-sm font-semibold text-sky-200">Open linked work order{pmTicketClosed(issueLinks.find(link => link.id === activeScopeEntry.work_order_id)) && <span className="block text-xs text-slate-300">Ticket closed · inspection result retained</span>}</button>}

              {(activeHistory || activeTemplate.kind !== "room") && <details className="pm-prior-history rounded-lg border border-slate-800 p-3"><summary>Prior maintenance history</summary>{activeHistory && <p className="rounded-lg border border-emerald-500/30 p-3 text-sm text-emerald-200">Room completed historically: {activeHistory.completed_on || "Date unknown"}. {activeHistory.source_name} · {activeHistory.source_reference}. Only source-recorded item answers are shown. Historical completion does not assert an item passed; saving this form does not replace the historical completion.</p>}{activeTemplate.kind !== "room" && <PmSourceEvidence templateId={activeTemplate.id} />}</details>}
            </div>
            <footer className="pm-inspection-actions flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-4">
                <div className="pm-save-message">{error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}</div>
                <div className="pm-save-message">{message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 p-3 text-sm text-emerald-100">{message}</p>}</div>
                <button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => void saveActive(false)} className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-bold text-slate-200 disabled:opacity-40">{savingKey === "active-form" ? "Saving…" : "Save draft"}</button>
                <button type="button" disabled={!activeCanEdit || !!savingKey} onClick={() => void saveActive(true)} className="rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40">Mark complete</button>
            </footer>
          </section>
        </div>
      )}
      {monthlyAttention && <PmIssueDialog label="Monthly task needs attention" busy={!!savingKey} onDismiss={() => setMonthlyAttention(null)}><section className="w-full max-w-lg rounded-xl bg-slate-950 p-4 border border-red-500">
        <h2 className="font-bold">{monthlyAttention.template.checklist.find(item => item.id === monthlyAttention.itemId)?.label}</h2>
        <label className="block mt-2">Issue description<textarea disabled={!!savingKey} className="block w-full bg-slate-900 p-2" value={monthlyAttention.detail} onChange={event => setMonthlyAttention({ ...monthlyAttention, detail: event.target.value })} /></label>
        <label className="block mt-2">Location<select disabled={!!savingKey} className="block w-full bg-slate-900 p-2" value={monthlyAttention.locationId} onChange={event => setMonthlyAttention({ ...monthlyAttention, locationId: event.target.value })}><option value="">Select location</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <p className="mt-2 text-xs text-slate-400">Saving records attention and opens work-order confirmation. It does not create a work order.</p>
        {error && <p role="alert">{error}</p>}
        <button disabled={!!savingKey} onClick={() => setMonthlyAttention(null)} className="p-2">Cancel</button><button disabled={!!savingKey || !monthlyAttention.detail.trim()} className="p-2 text-red-200" onClick={() => void updateRoutine(monthlyAttention.template, monthlyAttention.period, monthlyAttention.itemId, "follow-up", monthlyAttention.detail, monthlyAttention.locationId)}>Save attention &amp; review</button>
      </section></PmIssueDialog>}
      {issueConfirmation && <PmIssueDialog label="Confirm PM work orders" busy={confirmingIssues} onDismiss={() => setIssueConfirmation(null)}><section aria-labelledby="pm-issues-title" className="w-full max-w-xl max-h-[90dvh] overflow-y-auto rounded-xl bg-slate-950 border border-slate-600 p-4">
        <h2 id="pm-issues-title" className="font-bold">Confirm PM work orders</h2>
        <p className="text-sm text-slate-300">Review each item, location and description. Confirm creates or reuses one linked order for each listed issue. Existing orders are not changed or closed.</p>
        {issueConfirmation.issues.map(issue => <div key={issue.key} className="border-t border-slate-700 mt-3 pt-2"><strong>{issue.label}</strong><p>{locations.find(location => location.id === issue.locationId)?.name || "Location required — return to form"}</p><p className="whitespace-pre-wrap">{issue.detail || "Issue description required — return to form"}</p>{issueResults[issue.key]?.error && <p role="alert" className="text-red-300">{issueResults[issue.key].error}</p>}{issueResults[issue.key]?.id && <button className="text-emerald-300" onClick={() => openLinkedWorkOrder(issueResults[issue.key].id!)}>Linked — open work order</button>}</div>)}
        <p className="text-xs text-slate-400 mt-3">Successful links remain if another issue fails. Retry checks each issue's existing link before creating anything.</p>
        {error && <p role="alert" className="text-red-300">{error}</p>}
        <footer className="sticky bottom-0 bg-slate-950 pt-3 flex gap-3"><button disabled={confirmingIssues} onClick={() => setIssueConfirmation(null)}>Back to PM</button><button disabled={confirmingIssues || issueConfirmation.issues.some(issue => !issue.locationId || !issue.detail.trim()) || issueConfirmation.issues.every(issue => issueResults[issue.key]?.id)} className="rounded bg-emerald-400 p-2 text-slate-950" onClick={() => void confirmIssueWorkOrders()}>{confirmingIssues ? "Confirming…" : "Confirm work orders / retry unresolved"}</button></footer>
      </section></PmIssueDialog>}
      {confirmingProposal && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/80">
          <section role="dialog" aria-modal="true" aria-labelledby="pm-confirm-title" className="pm-review-confirm cmpri-modal-shell border border-emerald-500/30 bg-slate-950 shadow-2xl">
            <p className="text-[11px] font-bold uppercase tracking-[.18em] text-emerald-300">Explicit reviewer confirmation</p>
            <h2 id="pm-confirm-title" className="mt-1 text-xl font-bold text-white">Confirm PM proposal</h2>
            <p className="mt-2 text-sm text-slate-300">This records the approval in CMPRI only. Google Sheets sync is disabled, so no spreadsheet changes will be made.</p>
            {confirmingProposal.proposed_cells.length > 0 ? (
              <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm">
                {confirmingProposal.proposed_cells.map((cell, index) => <li key={`${cell.sheet}-${cell.row}-${cell.column}-${index}`} className="flex flex-wrap justify-between gap-2 border-b border-slate-800 pb-2 last:border-0 last:pb-0">
                  <span className="text-slate-200">{cell.label} · {cell.sheet} row {cell.row}, column {cell.column}</span>
                  <span><span className="text-slate-500">{cell.expectedValue || "blank"}</span> → <strong className="text-emerald-200">{cell.proposedValue}</strong></span>
                </li>)}
              </ul>
            ) : <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-slate-300">This proposal contains PDF checklist notes and measurements but no mapped workbook cells.</p>}
            {confirmingProposal.proposed_cells.length > 0 && !canWriteLivePm && <p role="alert" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-sm text-amber-100">This proposal contains spreadsheet changes and cannot be approved while Google Sheets sync is disabled.</p>}
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
