"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { usePathname } from "next/navigation";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { authorizationHeaders, type CmpriClientSession } from "@/lib/auth/client-session";
import { SESSION_KEY } from "@/lib/auth/session-storage";
import { isRecognizedChiefEngineer } from "@/lib/server/roles";
import { invalidateCachedResources } from "@/lib/data-cache/browser";
import { practiceAskResponse } from "@/components/beginners-guide/ask-cmpri-practice";
import type { AskContext, AskRecordReference, AskResponse } from "@/lib/ask-cmpri/types";
import { clampWindowRect, moveWindowRect, RESIZE_EDGES, resizeWindowRect, type ResizeEdge, type WindowRect } from "@/lib/ui/desktop-windows";
import { animateWindowTelescope, captureWindowLauncher, currentWindowLauncher, type WindowLauncher } from "@/lib/ui/window-telescope";
import { workOrderMediaDigest } from "@/lib/work-order-media";
import { uploadWorkOrderAttachment } from "@/lib/work-order-attachment-upload";
import { AskCmpriAnswer } from "./AskCmpriAnswer";
import { ASK_MAX_ATTACHMENT_BYTES, ASK_MAX_FILES, AskCmpriFiles, isAskCmpriTicketMedia, readAskCmpriFileExcerpt, type AskCmpriFilesStatus, type AskCmpriLocalFile } from "./AskCmpriFiles";
import { AskCmpriAttachments, AskCmpriAttachmentDrafts, AskCmpriAttachmentDropIndicator, AskCmpriDownloadList, AskCmpriFileList, useAskCmpriAttachmentDrop } from "./AskCmpriAttachments";
import { askHistoryStorageChanged, deleteAskHistoryEntry, readAskHistory, savedAskTurn, toggleAskHistoryKept, updateAskHistoryEntry, type AskHistoryEntry, type AskTurn } from "./ask-history";
import { makeAskAttachmentRecovery, readAskAttachmentRecoveries, removeAskAttachmentRecovery, saveAskAttachmentRecovery, type AskAttachmentRecovery } from "./ask-attachment-recovery";
import { useAskCmpriLiveVoice as useAskCmpriVoice } from "./useAskCmpriLiveVoice";
import { createAskOriginalFileStore } from "./original-file-upload";
import { ASK_OPENAI_VOICES, DEFAULT_ASK_OPENAI_VOICE, askOpenAIVoice, type AskOpenAIVoice } from "../../lib/ask-cmpri/voices";
import "./ask-cmpri.css";

const examples = [
  "212 AC still out?",
  "Does 134 have a sofa bed?",
  "Which rooms have late checkouts?",
  "Where are the spare filters?",
  "What does this washer code mean?",
  "The toilet in 319 won’t flush.",
  "Which rooms have broken microwaves, and which models should be in those rooms?",
  "What do we do during a tornado?",
  "Where is the salt stored?",
  "Find the GE JES1072SHSS manual",
];
const views = [
  { id: "search", label: "Search", panel: "ask-cmpri-search-view" },
  { id: "history", label: "History", panel: "ask-cmpri-history-view" },
  { id: "files", label: "Files", panel: "ask-cmpri-files-view" },
] as const;
type View = typeof views[number]["id"];
type OpenDetail = { query?: string; voice?: boolean; opener?: HTMLElement; tab?: View | "staff" | "notepad"; noteId?: string; practice?: boolean; prompts?: string[] };
type NormalizedOpenDetail = Omit<OpenDetail, "tab"> & { tab?: View };
type Authorized = { headers: Record<string, string>; scope: string };
type Attachments = NonNullable<AskTurn["attachments"]>;
type Call = { id: string; active: boolean; origin: "launcher" | "modal"; disclose: boolean; scope?: string; ready?: Promise<Authorized> };
type Submission = { turn: AskTurn; voice: boolean; delegationId?: string; call?: Call; scope?: string; draft: File[] };
const noFileStatus: AskCmpriFilesStatus = { pending: 0, error: null };
const emptyAnswer: AskResponse = { title: "", summary: "" };
const desktop = () => matchMedia("(min-width: 701px)").matches;
const minSize = { width: 430, height: 278 };

function focusAfterLayout(element: HTMLElement | null | undefined) {
  requestAnimationFrame(() => {
    if (element?.isConnected && !element.closest("[hidden],[inert]")) element.focus({ preventScroll: true });
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Ask CMPRI is unavailable. Try again.";
}

function storedUser(raw: string | null) {
  try {
    const value = JSON.parse(raw || "null") as { user?: { id?: string } } | null;
    return value?.user?.id;
  } catch { return undefined; }
}

function isCancelCommand(question: string) {
  return /^(?:please\s+)?(?:cancel(?: (?:that|it|the (?:change|proposal)))?|never\s*mind|don['’]?t (?:submit|send|save)(?: it| that)?|cancelar|cancela(?: eso)?|olv[ií]dalo)[.!?]*$/i.test(question.trim());
}

function recordPath(record: AskRecordReference) {
  if (record.kind === "module") {
    const screen = /^\/[a-z0-9][a-z0-9/_-]*(?:\?[^\s\\#]*)?$/i.test(record.id);
    const nativeHtml = /^\/previews\/cmpri-weather-preview\.html(?:\?[^\s\\#]*)?$/.test(record.id);
    if ((screen || nativeHtml) && !/^\/api(?:\/|\?|$)/i.test(record.id)) return record.id;
  }
  if (record.kind === "order") return "/work-orders/" + encodeURIComponent(record.id);
  if (record.kind === "asset") return "/management/equipment?asset=" + encodeURIComponent(record.id);
  if (record.kind === "roomRank") return "/engineering/room-ranking?room=" + encodeURIComponent(record.id);
  if (record.kind === "staffNote" || record.kind === "personalNote") return "/notepad?note=" + encodeURIComponent(record.id);
  return null;
}

function launchRecord(href: string, opener?: HTMLElement, openerRect?: DOMRect, title?: string) {
  window.dispatchEvent(new CustomEvent("cmpri-open-modal", {
    cancelable: true,
    detail: { href, title, origin: "ask-cmpri", opener, openerRect, clickedAt: Date.now() },
  }));
}

export default function AskCmpri() {
  const pathname = usePathname();
  const { language, t } = useUiLanguage();
  const [opened, setOpened] = useState(false);
  const [practice, setPractice] = useState(false);
  const [view, setView] = useState<View>("search");
  const [scope, setScope] = useState("");
  const [verified, setVerified] = useState(false);
  const [query, setQuery] = useState("");
  const [voiceName, setVoiceName] = useState<AskOpenAIVoice>(DEFAULT_ASK_OPENAI_VOICE);
  const [sample, setSample] = useState(examples[0]);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [history, setHistory] = useState<AskHistoryEntry[]>([]);
  const [expandedHistory, setExpandedHistory] = useState("");
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState("");
  const [manualLink, setManualLink] = useState<{ href: string; name: string }>();
  const [authProblem, setAuthProblem] = useState("");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [fileStatus, setFileStatus] = useState<AskCmpriFilesStatus>(noFileStatus);
  const [fileSelectionReset, setFileSelectionReset] = useState(0);
  const [focusFile, setFocusFile] = useState<{ id: string; file?: AskCmpriLocalFile }>();
  const [recoveries, setRecoveries] = useState<AskAttachmentRecovery[]>([]);
  const [recap, setRecap] = useState<string[]>([]);
  const [draftNote, setDraftNote] = useState("");
  const [reviewDraft, setReviewDraft] = useState(false);
  const [callEngaged, setCallEngaged] = useState(false);
  const [top, setTop] = useState(0);
  const [windowRect, setWindowRect] = useState<WindowRect | null>(null);
  const [visibleViewport, setVisibleViewport] = useState<{ top: number; height: number }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const draftField = useRef<HTMLTextAreaElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const launcher = useRef<WindowLauncher>(undefined);
  const openRef = useRef(false);
  const practiceRef = useRef(false);
  const viewRef = useRef<View>("search");
  const textRef = useRef("");
  const voiceNameRef = useRef<AskOpenAIVoice>(DEFAULT_ASK_OPENAI_VOICE);
  const voiceOwner = useRef("");
  const draftFilesRef = useRef<File[]>([]);
  const submittedQuery = useRef("");
  const authRef = useRef<Authorized>(undefined);
  const authBoundary = useRef(0);
  const authSerial = useRef(0);
  const acceptedAuthSerial = useRef(0);
  const turnsRef = useRef<AskTurn[]>([]);
  const historyRef = useRef<AskHistoryEntry[]>([]);
  const context = useRef<AskContext>(undefined);
  const pendingWorkOrderFiles = useRef<Attachments>([]);
  const conversationFiles = useRef(new Map<string, AskCmpriLocalFile>());
  const [originalFiles] = useState(createAskOriginalFileStore);
  const localFiles = useRef<{ scope: string; files: AskCmpriLocalFile[]; status: AskCmpriFilesStatus }>({ scope: "", files: [], status: noFileStatus });
  const callRef = useRef<Call>(undefined);
  const queuedVoice = useRef<Submission[]>([]);
  const historyGroups = useRef(new Map<string, string>());
  const noteEdited = useRef(false);
  const closing = useRef(false);
  const search = useRef<{ controller: AbortController; submission: Submission }>(null);
  const confirmation = useRef<AbortController>(null);
  const generation = useRef(0);
  const opening = useRef(0);
  const resize = useRef<{ edge: ResizeEdge; x: number; y: number; rect: WindowRect }>(null);
  const scrollForTurn = useRef("");
  const drag = useRef<{ x: number; y: number; rect: WindowRect }>(null);

  function showTurns(next: AskTurn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  function queryText(value: string) {
    textRef.current = value;
    setQuery(value);
  }

  function chooseVoice(value: string) {
    const selected = askOpenAIVoice(value);
    voiceNameRef.current = selected;
    setVoiceName(selected);
    if (voiceOwner.current) {
      try { window.localStorage.setItem(`cmpri:ask-live-voice:v1:${voiceOwner.current}`, selected); } catch { /* Voice choice still works for this session. */ }
    }
  }

  function updateDraftFiles(next: File[]) {
    draftFilesRef.current = next;
    setDraftFiles(next);
  }

  function currentView(next: View) {
    viewRef.current = next;
    setView(next);
  }

  function showHistory(entries: AskHistoryEntry[]) {
    historyRef.current = entries;
    setHistory(entries);
  }

  function storeTurn(turn: AskTurn, owner: string, group?: string, append = false) {
    if (practiceRef.current || authRef.current?.scope !== owner) return;
    const oldGroup = historyGroups.current.get(turn.id);
    const id = oldGroup || group || turn.id;
    showHistory(updateAskHistoryEntry(owner, id, (entry) => {
      if (!entry && (!append || oldGroup)) return;
      const recorded = savedAskTurn(turn);
      const existing = entry?.turns || [];
      return {
        id, date: Date.now(), kept: entry?.kept,
        question: group ? t("Voice transcript") : turn.question || t("Files attached"),
        context: context.current,
        turns: existing.some((item) => item.id === turn.id)
          ? existing.map((item) => item.id === turn.id ? recorded : item)
          : [...existing, recorded],
      };
    }));
    historyGroups.current.set(turn.id, id);
  }

  function updateTurn(id: string, change: Partial<AskTurn>, owner: string, group?: string) {
    const turn = turnsRef.current.find((item) => item.id === id);
    if (!turn) return;
    const newer = { ...turn, ...change };
    showTurns(turnsRef.current.map((item) => item.id === id ? newer : item));
    storeTurn(newer, owner, group);
  }

  function settleUnsent(submissions: Submission[], reason: string) {
    for (const submission of submissions) {
      const owner = submission.scope || submission.call?.scope;
      if (owner) updateTurn(submission.turn.id, { waiting: false, outcome: reason }, owner, submission.call?.id);
    }
  }

  function discardLocalFiles() {
    localFiles.current = { scope: "", files: [], status: noFileStatus };
    setFileStatus(noFileStatus);
    setFocusFile(undefined);
    setFileSelectionReset((value) => value + 1);
  }

  function clearSearch() {
    generation.current += 1;
    const active = search.current;
    active?.controller.abort();
    void originalFiles.clear();
    search.current = null;
    const queued = queuedVoice.current.splice(0);
    if (active?.submission.voice) queued.unshift(active.submission);
    settleUnsent(queued, t("This question was not sent."));
    context.current = undefined;
    pendingWorkOrderFiles.current = [];
    conversationFiles.current.clear();
    discardLocalFiles();
    historyGroups.current.clear();
    showTurns([]);
    setPending(false);
    setAlert("");
    setManualLink(undefined);
    updateDraftFiles([]);
    submittedQuery.current = "";
    queryText("");
  }

  function clearAccount() {
    void originalFiles.clear({ revokeFinalized: true });
    confirmation.current?.abort();
    authBoundary.current += 1;
    authRef.current = undefined;
    acceptedAuthSerial.current = authSerial.current;
    callRef.current = undefined;
    voice.stop();
    clearSearch();
    setVerified(false);
    setScope("");
    voiceOwner.current = "";
    voiceNameRef.current = DEFAULT_ASK_OPENAI_VOICE;
    setVoiceName(DEFAULT_ASK_OPENAI_VOICE);
    setCallEngaged(false);
    setRecap([]);
    setDraftNote("");
    setReviewDraft(false);
    setRecoveries([]);
    showHistory([]);
  }

  async function authorize(signal?: AbortSignal, expected?: string): Promise<Authorized> {
    const boundary = authBoundary.current;
    const serial = ++authSerial.current;
    const headers = await authorizationHeaders();
    const response = await fetch("/api/session", { headers, signal, cache: "no-store" });
    const session = await response.json().catch(() => null) as CmpriClientSession | null;
    if (signal?.aborted || boundary !== authBoundary.current) throw new DOMException("Session changed", "AbortError");
    if (!response.ok || !session?.user?.id || !session.hotelId || !session.user.role) {
      if (response.status === 401 || response.status === 403) clearAccount();
      throw new Error(t("Your CMPRI session is no longer authorized."));
    }
    if (!isRecognizedChiefEngineer(session.user)) {
      clearAccount();
      dismiss({ focus: false, animate: false, force: true });
      throw new Error(t("Ask CMPRI is available only to the Chief Engineer."));
    }
    const identity = session.hotelId + ":" + session.user.id;
    const owner = [identity, session.user.role, ...(session.user.secondary_roles || []).toSorted(),
      ...(session.capabilities || []).toSorted()].join(":");
    if (serial < acceptedAuthSerial.current && authRef.current?.scope !== owner) throw new DOMException("Session changed", "AbortError");
    if (authRef.current && authRef.current.scope !== owner) clearAccount();
    acceptedAuthSerial.current = serial;
    const authorized = { scope: owner, headers };
    authRef.current = authorized;
    if (voiceOwner.current !== identity) {
      let selected = DEFAULT_ASK_OPENAI_VOICE;
      try { selected = askOpenAIVoice(window.localStorage.getItem(`cmpri:ask-live-voice:v1:${identity}`)); } catch { /* Device storage may be unavailable. */ }
      voiceOwner.current = identity;
      voiceNameRef.current = selected;
      setVoiceName(selected);
    }
    setScope(owner);
    setVerified(true);
    setAuthProblem("");
    showHistory(readAskHistory(owner));
    if (expected && expected !== owner) throw new DOMException("Session changed", "AbortError");
    return authorized;
  }

  function sessionProblem(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    setVerified(false);
    discardLocalFiles();
    setAuthProblem(message(error));
  }

  async function send(auth: Authorized, body: object, signal?: AbortSignal): Promise<AskResponse> {
    const response = await fetch("/api/ask-cmpri", {
      method: "POST", body: JSON.stringify(body), headers: { ...auth.headers, "Content-Type": "application/json" },
      cache: "no-store", signal,
    });
    const result = await response.json().catch(() => null) as (AskResponse & { error?: string }) | null;
    if (!response.ok || !result || typeof result.title !== "string" || typeof result.summary !== "string") {
      if ((response.status === 401 || response.status === 403) && authRef.current?.scope === auth.scope) {
        if (response.status === 401) {
          clearAccount();
          setAuthProblem(t("Your CMPRI session is no longer authorized."));
        }
      }
      throw new Error(result?.error || result?.summary || t("Ask CMPRI is unavailable. Try again."));
    }
    return result;
  }

  function pickSample() {
    setSample(current => {
      const choices = examples.filter(example => example !== current);
      return choices[Math.floor(Math.random() * choices.length)];
    });
  }

  async function invalidateProposal(token: string, expected: string) {
    try {
      const auth = await authorize(undefined, expected);
      await send(auth, { confirmationToken: token, cancel: true });
    } catch {
      // The dialog has already disabled the action. The server also binds and expires tokens.
    }
  }

  function closeProposals(reason: string, owner = authRef.current?.scope) {
    const proposed = turnsRef.current.filter((turn) => turn.result.proposal);
    if (!owner) return;
    for (const turn of proposed) {
      updateTurn(turn.id, { result: { ...turn.result, proposal: undefined }, outcome: reason }, owner);
      void invalidateProposal(turn.result.proposal!.token, owner);
    }
  }

  function cancelProposal(turn: AskTurn, moveFocus = true) {
    const owner = authRef.current?.scope;
    const token = turnsRef.current.find((item) => item.id === turn.id)?.result.proposal?.token;
    if (!owner || !token || confirmation.current) return;
    context.current = context.current && { ...context.current, pending: undefined };
    pendingWorkOrderFiles.current = [];
    updateTurn(turn.id, { result: { ...turn.result, proposal: undefined }, outcome: t("Change cancelled.") }, owner);
    void invalidateProposal(token, owner);
    if (moveFocus) requestAnimationFrame(() => focusAfterLayout(document.getElementById(`ask-outcome-${turn.id}`)));
  }

  function captureTurn(submission: Submission, owner: string) {
    if (turnsRef.current.some((turn) => turn.id === submission.turn.id)) return;
    showTurns([...turnsRef.current, submission.turn]);
    storeTurn(submission.turn, owner, submission.call?.id, true);
    if (openRef.current && viewRef.current === "search") scrollForTurn.current = submission.turn.id;
  }

  function captureWords(words: string, interrupted = false, delegationId?: string) {
    const call = callRef.current;
    if (!call?.active || practiceRef.current) return;
    const turn = { id: crypto.randomUUID(), question: words, result: emptyAnswer, waiting: !interrupted,
      ...(interrupted ? { outcome: t("This question was not sent.") } : {}) };
    const submission = { turn, voice: true, delegationId, call, scope: call.scope, draft: [] };
    const accept = (owner: string) => {
      if (callRef.current !== call || authRef.current?.scope !== owner) return;
      submission.scope = owner;
      if (!call.active) Object.assign(turn, { waiting: false, outcome: t("This question was not sent.") });
      captureTurn(submission, owner);
      if (!turn.waiting) return;
      if (search.current || confirmation.current) {
        queuedVoice.current.push(submission);
      } else void runSubmission(submission);
    };
    if (call.scope) accept(call.scope);
    else void call.ready?.then((auth) => accept(auth.scope), () => {});
  }

  function callEnded() {
    const call = callRef.current;
    if (!call) return;
    call.active = false;
    const queued = queuedVoice.current.splice(0);
    if (search.current?.submission.voice && search.current.submission.call === call) {
      const active = search.current;
      active.controller.abort();
      search.current = null;
      setPending(false);
      queued.unshift(active.submission);
    }
    settleUnsent(queued, t("Call ended before Ask CMPRI answered."));
  }

  const voice = useAskCmpriVoice({
    onTranscript: (words, id) => captureWords(words, false, id),
    onInterruptedTranscript: (words) => captureWords(words, true),
    onEnd: callEnded,
    locale: language === "es" ? "es-US" : "en-US",
    connect: async (sdp, signal) => {
      const call = callRef.current;
      if (!call?.active) throw new DOMException("Call ended", "AbortError");
      await call.ready;
      if (signal.aborted || callRef.current !== call || !call.active) throw new DOMException("Call ended", "AbortError");
      const auth = await authorize(signal, call.scope);
      if (signal.aborted || callRef.current !== call || !call.active) throw new DOMException("Call ended", "AbortError");
      const history = turnsRef.current.filter(turn => !turn.waiting).slice(-6).flatMap(turn => [
        { role: "user" as const, text: turn.question.slice(0, 2000) },
        { role: "assistant" as const, text: (turn.result.summary || turn.outcome || "").slice(0, 2000) },
      ]).filter(item => item.text);
      const response = await fetch("/api/ask-cmpri/voice", {
        method: "POST", cache: "no-store", signal,
        headers: { ...auth.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sdp, voice: voiceNameRef.current, language, history }),
      });
      const result = await response.json().catch(() => null) as { sdp?: string; sessionId?: string; error?: string } | null;
      if (!response.ok || !result?.sdp) {
        if (response.status === 401 && authRef.current?.scope === auth.scope) clearAccount();
        throw new Error(result?.error || t("Live voice could not connect. Type your question to continue."));
      }
      return { sdp: result.sdp, sessionId: result.sessionId, history };
    },
  });

  function drainVoice() {
    if (search.current || confirmation.current) return;
    const next = queuedVoice.current.shift();
    if (!next) return;
    if (next.call?.active && callRef.current === next.call) void runSubmission(next);
    else settleUnsent([next, ...queuedVoice.current.splice(0)], t("This question was not sent."));
  }

  async function runSubmission(submission: Submission) {
    const { turn, call, draft, voice: fromVoice } = submission;
    if (fromVoice && (!call?.active || call !== callRef.current)) return;
    const controller = new AbortController();
    const serial = generation.current;
    search.current = { controller, submission };
    setPending(true);
    setAlert("");
    const cancellingProposal = isCancelCommand(turn.question) && turnsRef.current.some((item) => item.result.proposal);
    // A new request supersedes the previous review even when authorization,
    // attachment reading, or the next answer fails. Keep its context for edits.
    closeProposals(t(cancellingProposal ? "Change cancelled." : "Proposal closed."));
    if (cancellingProposal) {
      context.current = context.current && { ...context.current, pending: undefined };
      pendingWorkOrderFiles.current = [];
    }
    let auth: Authorized | undefined;
    const current = () => !controller.signal.aborted && serial === generation.current;
    try {
      auth = await authorize(controller.signal, submission.scope);
      if (!current() || (fromVoice && !call?.active)) return;
      submission.scope = auth.scope;
      captureTurn(submission, auth.scope);
      if (cancellingProposal) {
        updateTurn(turn.id, { waiting: false, outcome: t("Change cancelled.") }, auth.scope, call?.id);
        if (fromVoice && call?.active) voice.speak(t("Change cancelled."), submission.delegationId);
        return;
      }
      const chosen = localFiles.current.scope === auth.scope ? localFiles.current : undefined;
      if (chosen?.status.pending) throw new Error(t("Wait for the selected files to finish reading."));
      const previous = context.current;
      const newFiles = draft.map(file => ({ file, uploadId: crypto.randomUUID() }));
      const oldFiles = previous?.pending?.field === "create" ? pendingWorkOrderFiles.current : [];
      const requestFiles = [...oldFiles, ...newFiles];
      if (requestFiles.length > ASK_MAX_FILES) throw new Error(t("Select up to 20 files across Search and Files."));
      const excerpts = await Promise.all(newFiles.map(async ({ file, uploadId }) => {
        let text = "";
        if (file.type.startsWith("text/") || /\.(txt|md|csv|tsv|json|ya?ml|log|xml)$/i.test(file.name)) {
          try { text = await readAskCmpriFileExcerpt(file, controller.signal); } catch { /* The attachment metadata is still available. */ }
        }
        return { id: uploadId, name: file.name.slice(0, 255), type: file.type.slice(0, 120), size: file.size, text, original: file };
      }));
      const metadata = await Promise.all(requestFiles.filter(({ file }) => isAskCmpriTicketMedia(file)).map(async ({ file, uploadId }) => ({
        uploadId, name: file.name, type: file.type, size: file.size,
        ...(isAskCmpriTicketMedia(file) ? { sha256: await workOrderMediaDigest(file) } : {}),
      })));
      if (!current()) return;
      const essential = [...(chosen?.files || []), ...excerpts];
      if (essential.length > ASK_MAX_FILES) throw new Error(t("Select up to 20 files across Search and Files."));
      const selectedIds = new Set(essential.map(file => file.id));
      const selectedFiles = [...essential, ...[...conversationFiles.current.values()].filter(file => !selectedIds.has(file.id))].slice(0, ASK_MAX_FILES);
      const files: Omit<AskCmpriLocalFile, "original">[] = [];
      // Bound hashing/upload memory to one original at a time, including large native imports.
      for (const selected of selectedFiles) {
        const { original, ...metadata } = selected;
        const file: Omit<AskCmpriLocalFile, "original"> = metadata;
        if (original) file.file = await originalFiles.stage(original, auth.scope, authorize, controller.signal);
        if (!current()) return;
        files.push(file);
      }
      auth = await authorize(controller.signal, auth.scope);
      if (!current() || (fromVoice && !call?.active)) return;
      for (const file of selectedFiles) conversationFiles.current.set(file.id, file);
      const result = await send(auth, { question: turn.question, language, previous, files, attachments: metadata }, controller.signal);
      if (!current() || authRef.current?.scope !== auth.scope) return;
      context.current = result.context || context.current;
      pendingWorkOrderFiles.current = result.context?.pending?.field === "create" ? requestFiles : [];
      const attachments = result.proposal?.field === "create" ? requestFiles : newFiles;
      updateTurn(turn.id, { result, attachments, attachmentNames: attachments.map(({ file }) => file.name), waiting: false }, auth.scope, call?.id);
      if (draft.length) updateDraftFiles(draftFilesRef.current.filter(file => !draft.includes(file)));
      if (call?.active && !result.proposal && result.summary) {
        setRecap(currentRecap => currentRecap.includes(result.summary) ? currentRecap : [...currentRecap, result.summary].slice(-12));
        if (!noteEdited.current) setDraftNote(previousNote => [previousNote, "• " + result.summary].filter(Boolean).join("\n").slice(-3000));
      }
      if (fromVoice && call?.active) {
        const summary = result.summary || result.title;
        const detail = result.items?.find(item => item.text && item.text !== summary)?.text;
        const review = result.proposal ? (language === "es"
          ? "Es una propuesta; no se ha aplicado. Revisa la confirmación en Ask CMPRI. "
          : "This is a proposal; it has not been applied. Review the confirmation in Ask CMPRI. ") : "";
        voice.speak(review + [summary, detail].filter(Boolean).join(" ").slice(0, 500), submission.delegationId);
      }
      if (fromVoice && openRef.current && viewRef.current === "search" && (!textRef.current || textRef.current === submittedQuery.current)) {
        submittedQuery.current = turn.question;
        queryText(turn.question);
      }
    } catch (error) {
      if (current()) {
        const description = message(error);
        if (!auth) sessionProblem(error);
        else if (authRef.current?.scope === auth.scope) {
          updateTurn(turn.id, { waiting: false, outcome: description }, auth.scope, call?.id);
          if (fromVoice && call?.active) voice.speak(description, submission.delegationId);
        }
        setAlert(description);
      }
    } finally {
      if (search.current?.controller === controller) {
        search.current = null;
        setPending(false);
        drainVoice();
      }
    }
  }

  function answerInPractice(question: string) {
    if (!question.trim()) return;
    const result = practiceAskResponse(question, context.current);
    context.current = result.context;
    const turn = { id: crypto.randomUUID(), question, result: { ...result, proposal: undefined } };
    scrollForTurn.current = turn.id;
    showTurns([...turnsRef.current, turn]);
    queryText(question);
  }

  function submit(value: string, includeDraft = true) {
    const question = value.trim();
    if (practiceRef.current) {
      answerInPractice(question);
      return;
    }
    if ((!question && (!includeDraft || !draftFilesRef.current.length)) || voice.endFromText(question) || search.current || confirmation.current) return;
    if (includeDraft) opening.current += 1;
    const call = callRef.current?.active ? callRef.current : undefined;
    submittedQuery.current = question;
    if (question) queryText(question);
    const turn: AskTurn = { id: crypto.randomUUID(), question, result: emptyAnswer, waiting: true };
    void runSubmission({ turn, call, voice: false, scope: authRef.current?.scope, draft: includeDraft ? draftFilesRef.current.slice() : [] });
  }

  function startVoice(origin: Call["origin"]) {
    if (practiceRef.current || voice.active || confirmation.current) return;
    if (origin === "launcher") {
      closeProposals(t("Proposal closed."));
      clearSearch();
    }
    const call: Call = { id: crypto.randomUUID(), active: true, origin, disclose: origin === "launcher" };
    callRef.current = call;
    call.ready = authorize(undefined, authRef.current?.scope).then(auth => {
      if (callRef.current === call) call.scope = auth.scope;
      return auth;
    });
    void call.ready.catch(error => {
      if (callRef.current === call) {
        voice.stop();
        sessionProblem(error);
      }
    });
    noteEdited.current = false;
    setCallEngaged(true);
    setDraftNote("");
    setRecap([]);
    setReviewDraft(false);
    voice.start();
  }

  function activeTab(next: View) {
    if (practiceRef.current && next !== "search") return;
    opening.current += 1;
    currentView(next);
    if (results.current) results.current.scrollTop = 0;
  }

  function prepareOpen(detail: OpenDetail) {
    if (openRef.current) return;
    launcher.current = captureWindowLauncher(detail.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    openRef.current = true;
    setOpened(true);
    setTop(Math.ceil(document.querySelector<HTMLElement>("header.cmpri-dashboard-titlebar")?.getBoundingClientRect().bottom || 0));
    pickSample();
  }

  async function openVerified(detail: NormalizedOpenDetail, carry: boolean, auth: Authorized) {
    const ticket = ++opening.current;
    const recent = historyRef.current[0];
    currentView(detail.tab || "search");
    if (detail.tab === "history" && recent) setExpandedHistory(recent.id);
    if (detail.query) submit(detail.query, false);
    else if (!carry && detail.voice) startVoice("modal");
    if (!detail.voice) requestAnimationFrame(() => {
      if (ticket !== opening.current || !openRef.current || dialog.current?.querySelector('[aria-modal="true"]')) return;
      focusAfterLayout(viewRef.current === "search" ? field.current : document.getElementById(`ask-cmpri-${viewRef.current}-tab`));
    });
    const saved = await readAskAttachmentRecoveries(auth.scope);
    if (authRef.current?.scope === auth.scope && !practiceRef.current) setRecoveries(saved);
  }

  function showModal(request: OpenDetail, authorized?: Authorized) {
    if (closing.current || confirmation.current) return;
    const notebookRequest = request.tab === "staff" || request.tab === "notepad";
    // Old launch events now target the same independent Daily Work window.
    if (notebookRequest && !request.practice) {
      if (practiceRef.current) return;
      const opener = request.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
      const openerRect = opener?.getBoundingClientRect();
      dismiss({ focus: false, animate: false });
      launchRecord("/notepad" + (request.noteId ? "?note=" + encodeURIComponent(request.noteId) : ""), opener, openerRect, t("Notepad"));
      return;
    }
    if (!authorized || authRef.current?.scope !== authorized.scope) return;
    const detail: NormalizedOpenDetail = { ...request, tab: notebookRequest ? "search" : request.tab as View | undefined };
    if (detail.voice && !detail.practice && !openRef.current) {
      startVoice("launcher");
      return;
    }
    if (detail.practice) {
      closeProposals(t("Proposal closed."));
      voice.stop();
      clearSearch();
      practiceRef.current = true;
      setPractice(true);
      prepareOpen(detail);
      currentView("search");
      for (const prompt of detail.prompts || []) answerInPractice(prompt);
      if (detail.query) answerInPractice(detail.query);
      else queryText("");
      return;
    }
    if (practiceRef.current) return;
    const wasOpen = openRef.current;
    const carry = !!callRef.current?.disclose;
    if (!wasOpen) {
      setAuthProblem("");
      if (!carry) {
        closeProposals(t("Proposal closed."));
        clearSearch();
        setCallEngaged(false);
        setDraftNote("");
        setRecap([]);
        setReviewDraft(false);
      } else {
        callRef.current!.disclose = false;
        queryText("");
      }
      currentView(detail.tab || "search");
      prepareOpen(detail);
    }
    if (detail.query) {
      currentView("search");
      queryText(detail.query);
    }
    void openVerified(detail, carry, authorized).catch(sessionProblem);
    void voice.refreshMicrophone();
  }

  function dismiss({ focus = true, animate = true, force = false } = {}) {
    if (!openRef.current || closing.current) return;
    if (confirmation.current && !force) {
      setAlert(t("Wait for the confirmed change to finish saving."));
      return;
    }
    closing.current = true;
    const origin = launcher.current;
    const wasPractice = practiceRef.current;
    opening.current += 1;
    voice.stop();
    if (!wasPractice && !confirmation.current) closeProposals(t("Proposal closed."));
    clearSearch();
    setVerified(false);
    setAuthProblem("");
    const finish = () => {
      openRef.current = false;
      closing.current = false;
      dialog.current?.close();
      setOpened(false);
      practiceRef.current = false;
      setPractice(false);
      if (focus && origin) focusAfterLayout(currentWindowLauncher(origin));
    };
    const transition = animate ? animateWindowTelescope(dialog.current, origin, "close") : null;
    if (transition) void transition.finished.then(finish, finish);
    else finish();
  }

  const onOpen = useEffectEvent((event: Event) => {
    const detail = (event as CustomEvent<OpenDetail>).detail || {};
    if ((detail.tab === "staff" || detail.tab === "notepad") && !detail.practice) {
      showModal(detail);
      return;
    }
    void authorize(undefined, callRef.current?.scope ?? authRef.current?.scope)
      .then(auth => showModal(detail, auth))
      .catch(sessionProblem);
  });
  const onStop = useEffectEvent(() => voice.stop());
  const onSignOut = useEffectEvent(() => {
    clearAccount();
    dismiss({ focus: false, animate: false, force: true });
  });
  const onFocus = useEffectEvent(() => {
    if (!openRef.current || practiceRef.current || document.hidden) return;
    void authorize(undefined, authRef.current?.scope).catch(sessionProblem);
  });
  const onStorage = useEffectEvent((event: StorageEvent) => {
    if (event.key === SESSION_KEY && event.newValue !== event.oldValue) {
      const user = storedUser(event.newValue);
      if (!user || user !== storedUser(event.oldValue)) onSignOut();
      else onFocus();
      return;
    }
    const owner = authRef.current?.scope;
    if (owner && askHistoryStorageChanged(owner, event)) showHistory(readAskHistory(owner));
  });
  useEffect(() => {
    window.addEventListener("cmpri-ask-open", onOpen);
    window.addEventListener("cmpri-ask-stop-voice", onStop);
    window.addEventListener("cmpri-workspace-sign-out", onSignOut);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("cmpri-ask-open", onOpen);
      window.removeEventListener("cmpri-ask-stop-voice", onStop);
      window.removeEventListener("cmpri-workspace-sign-out", onSignOut);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  useEffect(() => () => {
    generation.current += 1;
    openRef.current = false;
    search.current?.controller.abort();
    confirmation.current?.abort();
    void originalFiles.clear();
  }, [originalFiles]);
  const onRoute = useEffectEvent(() => {
    if (openRef.current) dismiss({ focus: false, animate: false, force: true });
    else if (voice.active) voice.stop();
  });
  useEffect(() => { onRoute(); }, [pathname]);

  useLayoutEffect(() => {
    if (!opened || !dialog.current || dialog.current.open) return;
    dialog.current.showModal();
    animateWindowTelescope(dialog.current, launcher.current, "open");
    if (practice) focusAfterLayout(field.current);
  }, [opened, practice]);
  useEffect(() => {
    const launcherCall = callRef.current?.origin === "launcher" && !opened;
    window.dispatchEvent(new CustomEvent("cmpri-ask-state", { detail: {
      open: opened, voiceActive: voice.active && launcherCall, voiceDraft: "", voiceStatus: voice.status,
      voiceFallback: voice.typingFallback && launcherCall,
    } }));
  }, [opened, voice.active, voice.status, voice.typingFallback]);
  useLayoutEffect(() => {
    if (!opened || !field.current) return;
    field.current.style.height = "auto";
    field.current.style.height = Math.min(field.current.scrollHeight, 120) + "px";
  }, [opened, query, view]);
  useLayoutEffect(() => {
    const form = footer.current;
    if (!opened || !form) return;
    const observer = new ResizeObserver(() => dialog.current?.style.setProperty("--ask-footer-height", form.offsetHeight + "px"));
    observer.observe(form);
    return () => observer.disconnect();
  }, [opened, view]);
  useLayoutEffect(() => {
    if (view !== "search" || !results.current || !scrollForTurn.current) return;
    const turn = document.getElementById(`ask-turn-${scrollForTurn.current}`);
    if (!turn) return;
    const box = results.current.getBoundingClientRect();
    results.current.scrollTop += turn.getBoundingClientRect().top - box.top - 8;
    scrollForTurn.current = "";
  }, [opened, view, turns.length]);

  const acceptLocalFiles = useCallback((files: AskCmpriLocalFile[], status: AskCmpriFilesStatus = noFileStatus) => {
    if (!openRef.current || practiceRef.current || authRef.current?.scope !== scope) return;
    for (const old of localFiles.current.files) {
      if (files.some(file => file.id === old.id)) continue;
      // Submitted originals remain available to follow-ups and outstanding confirmations.
      if (conversationFiles.current.has(old.id)) continue;
      if (old.original && !confirmation.current) void originalFiles.remove(old.original);
    }
    localFiles.current = { scope, files, status };
    setFileStatus(status);
  }, [scope, originalFiles]);

  function addFiles(files: File[]) {
    if (!openRef.current || viewRef.current !== "search" || (!practiceRef.current && !verified) || confirmation.current) return;
    const valid = files.filter(file => file.size > 0 && file.size <= ASK_MAX_ATTACHMENT_BYTES);
    const combined = [...draftFilesRef.current, ...valid];
    if (valid.length !== files.length) setAlert(t("Attachments must be nonempty and no larger than 100 MB."));
    else if (combined.length + localFiles.current.files.length > ASK_MAX_FILES) setAlert(t("Select up to 20 files across Search and Files."));
    updateDraftFiles(combined.slice(0, Math.max(0, ASK_MAX_FILES - localFiles.current.files.length)));
  }
  const drop = useAskCmpriAttachmentDrop({ onSelect: addFiles, enabled: opened && view === "search" && (verified || practice) && !saving });

  function tabsKey(event: KeyboardEvent<HTMLDivElement>) {
    if (practiceRef.current) return;
    const index = views.findIndex(tab => tab.id === viewRef.current);
    const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1
      : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length
        : event.key === "ArrowRight" ? (index + 1) % views.length : -1;
    if (next < 0) return;
    event.preventDefault();
    activeTab(views[next].id);
    focusAfterLayout(document.getElementById(`ask-cmpri-${views[next].id}-tab`));
  }

  async function resume(entry: AskHistoryEntry) {
    if (confirmation.current || practiceRef.current) return;
    try {
      const auth = await authorize(undefined, scope);
      const fresh = readAskHistory(auth.scope).find(item => item.id === entry.id);
      if (!fresh || !openRef.current || viewRef.current !== "history") return;
      voice.stop();
      closeProposals(t("Proposal closed."));
      clearSearch();
      context.current = fresh.context;
      showTurns(fresh.turns.map(turn => turn.waiting ? { ...turn, waiting: false, outcome: t("No answer was recorded.") } : turn));
      submittedQuery.current = fresh.turns.at(-1)?.question || "";
      queryText(submittedQuery.current);
      activeTab("search");
      focusAfterLayout(field.current);
    } catch (error) { sessionProblem(error); }
  }

  async function changeHistory(entry: AskHistoryEntry, remove = false) {
    if (!verified || practiceRef.current) return;
    try {
      const auth = await authorize(undefined, scope);
      showHistory(remove ? deleteAskHistoryEntry(auth.scope, entry.id) : toggleAskHistoryKept(auth.scope, entry.id));
      setExpandedHistory(remove ? "" : entry.id);
      focusAfterLayout(document.getElementById(remove ? "ask-cmpri-history-tab" : `ask-history-keep-${entry.id}`));
    } catch (error) { sessionProblem(error); }
  }

  async function openRecord(record: AskRecordReference) {
    if (practiceRef.current) {
      if (record.kind === "order" && record.id.startsWith("guide-wo-")) {
        dismiss({ animate: false });
        window.dispatchEvent(new CustomEvent("cmpri-guide-open-work-order", { detail: { id: record.id } }));
      }
      return;
    }
    if (!verified || confirmation.current) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const openerRect = opener?.getBoundingClientRect();
    const registeredManual = record.kind === "file" && !!record.assetId;
    const manualWindow = registeredManual ? window.open("about:blank", "_blank") : null;
    if (manualWindow) manualWindow.opener = null;
    const originalGeneration = generation.current;
    try {
      const auth = await authorize(undefined, scope);
      if (!openRef.current) { manualWindow?.close(); return; }
      if (registeredManual) {
        setManualLink(undefined);
        setAlert("");
        try {
          const response = await fetch("/api/assets/documentation?asset_id=" + encodeURIComponent(record.assetId!), {
            headers: auth.headers, cache: "no-store",
          });
          const payload = await response.json().catch(() => null) as {
            error?: string; documents?: { id?: string; name?: string; url?: string | null }[];
          } | null;
          if (!response.ok) throw new Error(payload?.error || t("Could not open this equipment manual."));
          const document = payload?.documents?.find(item => item.id === record.id);
          if (!document?.url) throw new Error(t("This manual is no longer available for the selected equipment."));
          const url = new URL(document.url, window.location.origin);
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
            throw new Error(t("This manual has an unsupported document link."));
          }
          if (!openRef.current || authRef.current?.scope !== auth.scope || generation.current !== originalGeneration) {
            manualWindow?.close();
            return;
          }
          if (manualWindow && !manualWindow.closed) manualWindow.location.replace(url.href);
          else setManualLink({ href: url.href, name: document.name || record.label || t("Open manual") });
        } catch (error) {
          manualWindow?.close();
          if (openRef.current && authRef.current?.scope === auth.scope && generation.current === originalGeneration) setAlert(message(error));
        }
        return;
      }
      if (record.kind === "file") {
        setFocusFile({ id: record.id, file: conversationFiles.current.get(record.id) });
        activeTab("files");
        return;
      }
      const href = recordPath(record);
      if (!href) return;
      dismiss({ focus: false, animate: false });
      launchRecord(href, opener, openerRect, record.label);
    } catch (error) { manualWindow?.close(); sessionProblem(error); }
  }

  async function saveAttachments(batch: AskAttachmentRecovery, order: NonNullable<AskResponse["savedOrder"]>, signal: AbortSignal) {
    const files = new Map(batch.files.map(file => [file.uploadId, file.file]));
    if (files.size && (!order.attachmentToken || !order.attachments?.length)) {
      throw new Error(t("Ask CMPRI could not verify the saved work order’s attachments."));
    }
    for (const descriptor of order.attachments || []) {
      const file = files.get(descriptor.uploadId);
      if (!file) throw new Error(t("The original attachment is no longer available on this device."));
      const auth = await authorize(signal, batch.scope);
      const accessToken = auth.headers.Authorization.replace(/^Bearer /, "");
      const upload = await uploadWorkOrderAttachment(order.id, file, accessToken, descriptor.uploadId, { attachmentToken: order.attachmentToken, signal });
      if (!upload.ok) throw new Error(upload.message);
    }
  }

  async function confirmTurn(turn?: AskTurn, retry?: AskAttachmentRecovery) {
    if (!verified || practiceRef.current || confirmation.current || search.current || (!turn?.result.proposal && !retry)) return;
    if (turn && turnsRef.current.find(item => item.id === turn.id)?.result.proposal?.token !== turn.result.proposal?.token) return;
    const controller = new AbortController();
    const owner = scope;
    confirmation.current = controller;
    setSaving(true);
    setAlert("");
    let batch = retry;
    let confirmationAttempted = false;
    let nativeConfirmation = false;
    try {
      let auth = await authorize(controller.signal, owner);
      const proposal = turn?.result.proposal;
      const tokens = proposal?.token || batch?.token;
      if (!tokens) return;
      const photos = (turn?.attachments || []).filter(entry => isAskCmpriTicketMedia(entry.file));
      if (!batch && proposal?.field === "create" && photos.length) {
        batch = makeAskAttachmentRecovery({ id: turn!.id, scope: owner, token: tokens, files: photos });
        await saveAskAttachmentRecovery(batch);
        auth = await authorize(controller.signal, owner);
      }
      let result: AskResponse | undefined;
      if (!batch?.order) {
        confirmationAttempted = true;
        nativeConfirmation = proposal?.field === "cmpri" || tokens.startsWith("native.");
        result = await send(auth, { confirmationToken: tokens, ...(nativeConfirmation ? { previous: turn?.result.context || context.current } : {}), ...(retry ? { recover: true } : {}) }, controller.signal);
      }
      const savedOrder = result?.savedOrder || batch?.order;
      if (batch && savedOrder) {
        batch = { ...batch, order: savedOrder };
        await saveAskAttachmentRecovery(batch);
      }
      await authorize(controller.signal, owner);
      if (authRef.current?.scope !== owner || controller.signal.aborted) return;
      if (result?.context) context.current = result.context;
      if (turn && result) {
        const { proposal: _proposal, ...answer } = result;
        void _proposal;
        updateTurn(turn.id, { result: { ...answer, downloads: answer.downloads || turn.result.downloads }, outcome: undefined }, owner);
      }
      if (batch && savedOrder) {
        await saveAttachments(batch, savedOrder, controller.signal);
        await removeAskAttachmentRecovery(batch.scope, batch.id);
      }
      if (turn) focusAfterLayout(document.getElementById(`ask-turn-${turn.id}`));
    } catch (error) {
      if (authRef.current?.scope === owner) setAlert(message(error));
    } finally {
      // A failed/aborted batch can still have saved earlier operations. Refresh its native modules too.
      if (confirmationAttempted) {
        if (nativeConfirmation) await refreshProfilePreferences(owner, controller.signal).catch(() => {});
        await invalidateCachedResources(nativeConfirmation ? undefined : ["orders", "rooms", "reference"])
          .catch(() => { /* Cache recovery must not replace the confirmation result. */ });
      }
      if (confirmation.current === controller) {
        confirmation.current = null;
        setSaving(false);
        drainVoice();
      }
      if (authRef.current?.scope === owner) setRecoveries(await readAskAttachmentRecoveries(owner));
    }
  }

  async function refreshProfilePreferences(owner: string, signal: AbortSignal) {
    const auth = await authorize(signal, owner);
    const response = await fetch("/api/profile", { headers: auth.headers, cache: "no-store", signal });
    const payload = await response.json().catch(() => null) as {
      profile?: { id?: string }; profile_settings_available?: boolean;
      preferences?: { language?: string; appearance?: string };
    } | null;
    if (!response.ok || signal.aborted || authRef.current?.scope !== owner || payload?.profile?.id !== owner.split(":")[1]
      || payload.profile_settings_available === false || !payload.preferences
      || !["en", "es"].includes(payload.preferences.language || "") || !["light", "dark"].includes(payload.preferences.appearance || "")) return;
    // The native Profile screen uses this event to update language and theme across mounted windows.
    const event = { type: "cmpri-profile-preferences-updated", preferences: payload.preferences };
    window.parent.postMessage(event, window.location.origin);
    if (window.top !== window.parent) window.top?.postMessage(event, window.location.origin);
  }

  function startNew() {
    if (confirmation.current) return;
    field.current?.blur();
    closeProposals(t("Proposal closed."));
    clearSearch();
    pickSample();
    if (voice.active) voice.newTopic();
    else {
      setCallEngaged(false);
      setDraftNote("");
      setRecap([]);
      setReviewDraft(false);
    }
  }

  const desktopBounds = () => ({ width: window.innerWidth - 16, height: window.innerHeight - top - 16 });
  function readRect() {
    const bounds = dialog.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { x: bounds.left - 8, y: bounds.top - top - 8, width: bounds.width, height: bounds.height };
  }
  function startResize(event: PointerEvent<HTMLButtonElement>, edge: ResizeEdge) {
    const rect = readRect();
    if (!desktop() || !rect || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { edge, x: event.clientX, y: event.clientY, rect };
  }
  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    if (!resize.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const { edge, x, y, rect } = resize.current;
    setWindowRect(resizeWindowRect(rect, edge, event.clientX - x, event.clientY - y, desktopBounds(), minSize));
  }
  function keyboardResize(event: KeyboardEvent<HTMLButtonElement>) {
    const arrows = { ArrowUp: [0, -10], ArrowDown: [0, 10], ArrowLeft: [-10, 0], ArrowRight: [10, 0] };
    const change = arrows[event.key as keyof typeof arrows];
    const rect = readRect();
    if (!change || !rect || !desktop()) return;
    event.preventDefault();
    setWindowRect(resizeWindowRect(rect, "se", change[0], change[1], desktopBounds(), minSize));
  }
  useEffect(() => {
    if (!opened) return;
    const update = () => {
      const nextTop = Math.ceil(document.querySelector<HTMLElement>("header.cmpri-dashboard-titlebar")?.getBoundingClientRect().bottom || 0);
      setTop(nextTop);
      setWindowRect(rect => rect && desktop() ? clampWindowRect(rect, { width: innerWidth - 16, height: innerHeight - nextTop - 16 }, minSize) : null);
      const viewport = window.visualViewport;
      if (viewport && !desktop()) setVisibleViewport({ top: viewport.offsetTop, height: viewport.height });
      else setVisibleViewport(undefined);
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [opened]);

  const style = {
    "--ask-top": `${top}px`,
    ...(visibleViewport ? { "--ask-visible-top": `${visibleViewport.top}px`, "--ask-visible-height": `${visibleViewport.height}px` } : {}),
    ...(windowRect ? { "--ask-x": `${windowRect.x + 8}px`, "--ask-y": `${windowRect.y + top + 8}px`,
      "--ask-width": `${windowRect.width}px`, "--ask-height": `${windowRect.height}px` } : {}),
  } as CSSProperties;
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (!desktop() || event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, a"))) return;
    const rect = readRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, rect };
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const { x, y, rect } = drag.current;
    setWindowRect(moveWindowRect(rect, event.clientX - x, event.clientY - y, desktopBounds()));
  }

  const engaged = !!turns.length || voice.active || callEngaged;
  const canSearch = practice || verified;
  const working = pending || saving;
  const mic = <button type="button" className="ask-pill-icon ask-mic" aria-label={t("Start voice call")}
    aria-describedby="ask-cmpri-mic-tip" disabled={!verified || practice || saving}
    onFocus={() => { void voice.refreshMicrophone(); }} onPointerEnter={() => { void voice.refreshMicrophone(); }}
    onClick={() => startVoice("modal")}><i aria-hidden="true" /></button>;
  const askSample = <div className="ask-sample-question">
    <p>{t("Sample question")}</p>
    <button type="button" onClick={() => submit(sample)} disabled={(!canSearch && !authProblem) || working}>{t(sample)}</button>
  </div>;

  return <dialog ref={dialog} id="ask-cmpri" className="cmpri-ask cmpri-desktop-window" data-active="true" data-cmpri-modal-theme="true"
    data-positioned={windowRect ? "true" : undefined} aria-labelledby="ask-cmpri-title" style={style}
    onCancel={event => { event.preventDefault(); if (voice.active) voice.stop(); else dismiss(); }} {...drop.dropProps}>
    <header className="ask-titlebar cmpri-desktop-titlebar" onPointerDown={startDrag} onPointerMove={moveDrag} onLostPointerCapture={() => { drag.current = null; }}>
      <div className="cmpri-title-content" id="ask-cmpri-title" role="heading" aria-level={2}><i className="ask-gemini-mark" aria-hidden="true" />{t("Ask CMPRI")}</div>
      <div className="ask-title-actions">
        <div className="ask-tabs" role="tablist" aria-label={t("Ask CMPRI views")} onKeyDown={tabsKey}>
          {views.map(tab => <button type="button" role="tab" key={tab.id} id={`ask-cmpri-${tab.id}-tab`} aria-controls={tab.panel}
            aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} disabled={practice && tab.id !== "search"}
            onClick={() => activeTab(tab.id)}>{t(tab.label)}</button>)}
        </div>
        <button type="button" className="cmpri-desktop-close" aria-label={t("Close Ask CMPRI")} title={t("Close")} disabled={saving} onClick={() => dismiss()}>
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
    </header>
    {!practice && <AskCmpriFiles open={opened && verified} active={view === "files" && verified} scopeKey={scope}
      scopeError={authProblem} selectionReset={fileSelectionReset} focusFileId={focusFile?.id} focusExcerpt={focusFile?.file}
      onOpenFiles={() => activeTab("files")} onFilesChange={acceptLocalFiles} />}
    <div ref={results} className="ask-body" data-view={view} hidden={view === "files" && (verified || !authProblem)} tabIndex={0} aria-label={t("Ask CMPRI results")}>
      {authProblem && <div className="ask-request-status" role="alert">
        <p>{authProblem}</p>
        <button type="button" className="ask-quiet" onClick={() => void authorize(undefined, authRef.current?.scope)
          .then(auth => openVerified({ tab: "search" }, false, auth)).catch(sessionProblem)}>{t("Try again")}</button>
      </div>}
      {alert && !authProblem && <p className="ask-request-status" role="alert">{alert}</p>}
      {verified && manualLink && <p className="ask-request-status"><a className="ask-text-action" href={manualLink.href} target="_blank" rel="noopener noreferrer">{manualLink.name}</a></p>}
      {verified && recoveries.length > 0 && <section className="ask-recoveries" aria-label={t("Attachment recovery")}>
        {recoveries.map(batch => <div key={batch.id}>
          <p>{batch.order ? `${batch.order.displayId} · ${t("The work order was saved. Retry the attachment upload.")}` : t("Check whether the work order was saved before retrying its attachments.")}</p>
          <button type="button" className="ask-quiet" disabled={working} onClick={() => { void confirmTurn(undefined, batch); }}>
            {t(batch.order ? "Retry attachment upload" : "Check saved work order")}</button>
        </div>)}
      </section>}
      <div id="ask-cmpri-search-view" className="ask-search-view" role="tabpanel" aria-labelledby="ask-cmpri-search-tab" hidden={view !== "search"}>
        {(!canSearch || !turns.length) ? <div className="ask-welcome">
          <i className="ask-gemini-mark welcome-mark" aria-hidden="true" />
          <h3>{t("What can I help you find?")}</h3>
          <p>{t("Ask in your own words about CMPRI records you can access or manufacturer information. You can ask a follow-up or choose how to see the answer.")}</p>
        </div> : <div role="log" aria-label={t("Search conversation")} className="ask-thread">
          {turns.map(turn => <article className="ask-turn" id={`ask-turn-${turn.id}`} tabIndex={-1} key={turn.id}>
            {turn.question && <p className="ask-question">{turn.question}</p>}
            {!!turn.attachments?.length ? <AskCmpriFileList files={turn.attachments.map(entry => entry.file)} outgoing scopeKey={scope} locale={language} />
              : !!turn.attachmentNames?.length && <ul className="ask-sent-files" aria-label={t("Attachments")}>{turn.attachmentNames.map((name, i) => <li key={i}>{name}</li>)}</ul>}
            {turn.waiting ? <p className="ask-request-status" role="status">{t("Searching…")}</p> : <AskCmpriAnswer result={turn.result} openRecord={openRecord} />}
            {!practice && <AskCmpriDownloadList downloads={turn.result.downloads} scopeKey={scope} locale={language} authorize={authorize} />}
            {!practice && turn.result.proposal && <section className="ask-proposal">
              <h4>{turn.result.proposal.label}</h4>
              {turn.result.proposal.from && <p>{t("Current")} · {turn.result.proposal.from}</p>}
              <p>{t("Proposed")} · {turn.result.proposal.to}</p>
              {turn.result.proposal.effects?.map(effect => <p key={effect}>{effect}</p>)}
              <div className="ask-proposal-actions">
                <button type="button" className="ask-confirm" disabled={working} onClick={() => { void confirmTurn(turn); }}>
                  {turn.result.proposal.field === "create" && turn.result.context?.language === "es" ? "Confirmar y enviar"
                    : turn.result.proposal.field === "cmpri" ? (language === "es" ? "Confirmar cambio" : "Confirm change")
                      : t(turn.result.proposal.field === "create" ? "Confirm submission" : "Confirm edit")}
                </button>
                <button type="button" className="ask-quiet" disabled={working} onClick={() => cancelProposal(turn)}>{turn.result.context?.language === "es" ? "Cancelar" : t("Cancel")}</button>
              </div>
            </section>}
            {turn.outcome && <p id={`ask-outcome-${turn.id}`} tabIndex={-1} className="ask-outcome" role="status">{turn.outcome}</p>}
          </article>)}
        </div>}
      </div>
      <div id="ask-cmpri-history-view" className="ask-history-view" role="tabpanel" aria-labelledby="ask-cmpri-history-tab" hidden={view !== "history"}>
        <h3>{t("Saved searches")}</h3>
        <p>{t("Seven days in the device cache. Keep searches you want to return to.")}</p>
        {askSample}
        {verified && history.map(entry => <details key={entry.id} open={expandedHistory === entry.id} className="ask-history-entry"
          onToggle={event => {
            if (event.currentTarget.open) setExpandedHistory(entry.id);
            else setExpandedHistory(current => current === entry.id ? "" : current);
          }}>
          <summary>{entry.question}<time dateTime={new Date(entry.date).toISOString()}>{new Date(entry.date).toLocaleDateString(language)}{entry.kept ? " · " + t("Kept") : ""}</time></summary>
          {entry.turns.map(turn => <section className="ask-history-turn" key={turn.id}>
            {turn.question && <p className="ask-question">{turn.question}</p>}
            <AskCmpriAnswer result={turn.result} openRecord={openRecord} />
            <AskCmpriDownloadList downloads={turn.result.downloads} scopeKey={scope} locale={language} authorize={authorize} />
            {turn.attachmentNames?.map(name => <p key={name}>{name}</p>)}
            {(turn.outcome || turn.waiting) && <p>{turn.outcome || t("No answer was recorded.")}</p>}
          </section>)}
          <div className="ask-history-actions">
            <button type="button" className="ask-quiet" disabled={saving} onClick={() => { void resume(entry); }}>{t("Resume search")}</button>
            <button type="button" id={`ask-history-keep-${entry.id}`} className="ask-quiet" onClick={() => { void changeHistory(entry); }}>{t(entry.kept ? "Unkeep" : "Keep")}</button>
            <button type="button" className="ask-quiet" onClick={() => { void changeHistory(entry, true); }}>{t("Delete")}</button>
          </div>
        </details>)}
        {!history.length && <p>{t("Search something to start building your history.")}</p>}
      </div>
    </div>
    {view === "search" && <footer ref={footer} className="ask-footer">
      {verified && (voice.active || voice.typingFallback || reviewDraft) && <div className="ask-voice-panel">
        {(voice.active || voice.typingFallback) && <div className="ask-voice-meta"><strong>{t("Voice call")}</strong><span role="status">{voice.status}</span></div>}
        {voice.typingFallback && <button type="button" className="ask-text-action" onClick={() => focusAfterLayout(field.current)}>{t("Type a question")}</button>}
        {voice.draft && <p>{voice.draft}</p>}
        {voice.reply && <p aria-label={language === "es" ? "Respuesta hablada" : "Spoken reply"}>{voice.reply}</p>}
        <div className="ask-voice-columns">
          <section><h3>{t("Running summary")}</h3><div className="ask-recap" aria-live="polite">{recap.length ? recap.map(line => <p key={line}>{line}</p>) : <p>{t("Topics and findings appear as you talk.")}</p>}</div></section>
          <section><label htmlFor="ask-cmpri-draft-note">{t("Draft note")}</label>
            <textarea ref={draftField} id="ask-cmpri-draft-note" rows={2} placeholder={t("Notes from this call appear here.")} value={draftNote}
              onChange={event => { noteEdited.current = true; setDraftNote(event.target.value); }} />
          </section>
        </div>
      </div>}
      {verified && !voice.active && draftNote && <p className="ask-voice-panel ask-voice-meta" role="status">{t("Call ended. Draft note ready to review.")}
        <button type="button" className="ask-text-action" onClick={() => {
          setReviewDraft(!reviewDraft);
          if (!reviewDraft) requestAnimationFrame(() => focusAfterLayout(draftField.current));
        }}>{t(reviewDraft ? "Hide draft" : "View draft")}</button>
      </p>}
      {fileStatus.pending > 0 && <p className="ask-file-warning" role="status">{t("Reading selected files…")}</p>}
      {fileStatus.error && <p className="ask-file-warning" role="alert">{fileStatus.error}</p>}
      {canSearch && <AskCmpriAttachmentDrafts files={draftFiles} onRemove={index => updateDraftFiles(draftFilesRef.current.filter((_, i) => i !== index))} disabled={saving} locale={language} />}
      <form className="ask-search-pill" onSubmit={(event: FormEvent) => { event.preventDefault(); submit(textRef.current); }}>
        {engaged ? <button type="button" className="ask-pill-icon ask-new" aria-label={t(voice.active ? "New topic" : "New search")} disabled={saving} onClick={startNew}>+</button> : mic}
        <div className="ask-query-box"><i className="ask-gemini-mark" aria-hidden="true" />
          <label className="sr-only" htmlFor="ask-cmpri-query">{t("Ask CMPRI")}</label>
          <textarea ref={field} id="ask-cmpri-query" rows={1} maxLength={650} enterKeyHint="search" placeholder={t("Ask CMPRI")}
            value={canSearch || authProblem ? query : ""} disabled={saving} onChange={event => queryText(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(textRef.current); }
            }} />
        </div>
        <label className="ask-voice-picker" hidden={query.length > 0}>
          <span className="sr-only">{language === "es" ? "Voz de OpenAI" : "OpenAI voice"}</span>
          <select value={voiceName} disabled={!verified || practice || saving || voice.active} onChange={event => chooseVoice(event.target.value)}
            aria-label={language === "es" ? "Voz de OpenAI" : "OpenAI voice"}>
            {ASK_OPENAI_VOICES.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {voice.active ? <button className="ask-stop" type="button" onClick={voice.stop}><span aria-hidden="true" />{t("Stop")}</button> : engaged && mic}
        <AskCmpriAttachments onSelect={addFiles} disabled={!canSearch || saving} locale={language} />
        <button className="ask-search-control" type="submit" aria-label={t("Search")} title={t("Search")} disabled={working || !!fileStatus.pending}><i aria-hidden="true" /></button>
        <span id="ask-cmpri-mic-tip" className="ask-mic-tip" role="tooltip">{voice.microphone.text}</span>
      </form>
    </footer>}
    {drop.dragging && <AskCmpriAttachmentDropIndicator locale={language} />}
    <div className="ask-resize-boundaries">
      {RESIZE_EDGES.map(edge => <button key={edge} type="button" data-ask-resize={edge} tabIndex={edge === "se" ? 0 : -1}
        aria-hidden={edge !== "se" || undefined} aria-label={edge === "se" ? t("Resize Ask CMPRI with arrow keys") : undefined}
        onPointerDown={event => startResize(event, edge)} onPointerMove={moveResize} onLostPointerCapture={() => { resize.current = null; }}
        onKeyDown={edge === "se" ? keyboardResize : undefined} />)}
    </div>
  </dialog>;
}
