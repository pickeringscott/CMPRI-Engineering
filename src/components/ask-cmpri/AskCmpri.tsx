"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { usePathname } from "next/navigation";
import StaffNotes from "@/components/StaffNotes";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { authorizationHeaders, loadCmpriSession } from "@/lib/auth/client-session";
import type { AskContext, AskRecordReference, AskResponse } from "@/lib/ask-cmpri/types";
import { clampWindowRect, RESIZE_EDGES, resizeWindowRect, type ResizeEdge, type WindowRect } from "@/lib/ui/desktop-windows";
import { animateWindowTelescope, captureWindowLauncher, currentWindowLauncher, type WindowLauncher } from "@/lib/ui/window-telescope";
import { uploadWorkOrderAttachment } from "@/lib/work-order-attachment-upload";
import { AskCmpriAnswer } from "./AskCmpriAnswer";
import { AskCmpriFiles, type AskCmpriLocalFile } from "./AskCmpriFiles";
import { AskCmpriAttachments, AskCmpriAttachmentDrafts, AskCmpriAttachmentDropIndicator, AskCmpriFileList, useAskCmpriAttachmentDrop } from "./AskCmpriAttachments";
import { readAskHistory, recordAskHistoryEntry, savedAskTurn, writeAskHistory, type AskHistoryEntry, type AskTurn } from "./ask-history";
import { useAskCmpriVoice } from "./useAskCmpriVoice";
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
  { id: "staff", label: "Staff Notes", panel: "ask-cmpri-staff-view" },
  { id: "history", label: "History", panel: "ask-cmpri-history-view" },
  { id: "files", label: "Files", panel: "ask-cmpri-files-view" },
] as const;
type View = typeof views[number]["id"];
type OpenDetail = { query?: string; voice?: boolean; opener?: HTMLElement };
const desktop = () => matchMedia("(min-width: 701px) and (hover: hover)").matches;
const minSize = { width: 430, height: 278 };
const textAttachment = /^(text\/|application\/(?:json|xml))/i;

function focusAfterLayout(element: HTMLElement | null | undefined) {
  requestAnimationFrame(() => {
    if (element?.isConnected && !element.closest("[hidden],[inert]")) element.focus({ preventScroll: true });
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Ask CMPRI is unavailable. Try again.";
}

function recordPath(record: AskRecordReference) {
  if (record.kind === "order") return "/work-orders/" + encodeURIComponent(record.id);
  if (record.kind === "asset") return "/management/equipment?asset=" + encodeURIComponent(record.id);
  if (record.kind === "roomRank") return "/engineering/room-ranker";
  if (record.kind === "personalNote") return "/notes";
  return null;
}

export default function AskCmpri() {
  const pathname = usePathname();
  const { language, t } = useUiLanguage();
  const [opened, setOpened] = useState(false);
  const [view, setView] = useState<View>("search");
  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [sample, setSample] = useState(examples[0]);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [history, setHistory] = useState<AskHistoryEntry[]>([]);
  const [expandedHistory, setExpandedHistory] = useState("");
  const [pending, setPending] = useState(false);
  const [alert, setAlert] = useState("");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [localFiles, setLocalFiles] = useState<AskCmpriLocalFile[]>([]);
  const [recap, setRecap] = useState<string[]>([]);
  const [draftNote, setDraftNote] = useState("");
  const [reviewDraft, setReviewDraft] = useState(false);
  const [top, setTop] = useState(0);
  const [windowRect, setWindowRect] = useState<WindowRect | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const launcher = useRef<WindowLauncher>(undefined);
  const scopeRef = useRef("");
  const turnsRef = useRef<AskTurn[]>([]);
  const historyRef = useRef<AskHistoryEntry[]>([]);
  const context = useRef<AskContext>(undefined);
  const pendingWorkOrderFiles = useRef<NonNullable<AskTurn["attachments"]>>([]);
  const callId = useRef<string>(undefined);
  const callSurface = useRef<"launcher" | "modal">("modal");
  const spokenCall = useRef(false);
  const queuedVoice = useRef<string[]>([]);
  const noteEdited = useRef(false);
  const closing = useRef(false);
  const openRef = useRef(false);
  const request = useRef<AbortController>(null);
  const generation = useRef(0);
  const resize = useRef<{ edge: ResizeEdge; x: number; y: number; rect: WindowRect }>(null);

  function showTurns(next: AskTurn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  function storeHistory(entries: AskHistoryEntry[]) {
    historyRef.current = entries;
    setHistory(entries);
    if (scopeRef.current) writeAskHistory(scopeRef.current, entries);
  }

  function clearThread() {
    generation.current++;
    request.current?.abort();
    request.current = null;
    queuedVoice.current = [];
    context.current = undefined;
    pendingWorkOrderFiles.current = [];
    showTurns([]);
    setPending(false);
    setAlert("");
    setDraftFiles([]);
    setQuery("");
  }

  async function authorizedScope() {
    const session = await loadCmpriSession();
    const identity = session.hotelId + ":" + session.user.id;
    const historyScope = [identity, session.user.role, ...(session.user.secondary_roles || []).toSorted(),
      ...(session.capabilities || []).toSorted()].join(":");
    if (historyScope !== scopeRef.current) {
      if (scopeRef.current) clearThread();
      scopeRef.current = historyScope;
      setLocalFiles([]);
      historyRef.current = readAskHistory(historyScope);
      setHistory(historyRef.current);
    }
    setScope(identity);
    return identity;
  }

  function pickSample() {
    setSample(current => {
      const choices = examples.filter(example => example !== current);
      return choices[Math.floor(Math.random() * choices.length)];
    });
  }

  function saveTurn(turn: AskTurn, voiceTurn: boolean) {
    const id = (voiceTurn && callId.current) || turn.id;
    const old = historyRef.current.find(entry => entry.id === id);
    const entry = recordAskHistoryEntry({
      id, question: voiceTurn ? t("Voice transcript") : turn.question,
      context: context.current, kept: old?.kept,
      turns: voiceTurn ? [...(old?.turns || []), savedAskTurn(turn)].slice(-40) : [savedAskTurn(turn)],
    });
    storeHistory([entry, ...historyRef.current.filter(item => item.id !== id)]);
  }

  async function send(body: object, signal: AbortSignal): Promise<AskResponse> {
    const headers = await authorizationHeaders();
    const response = await fetch("/api/ask-cmpri", {
      method: "POST", body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" },
      cache: "no-store", signal,
    });
    const result = await response.json().catch(() => null) as (AskResponse & { error?: string }) | null;
    if (!response.ok || !result || typeof result.title !== "string" || typeof result.summary !== "string") {
      throw new Error(result?.error || result?.summary || t("Ask CMPRI is unavailable. Try again."));
    }
    return result;
  }

  async function submit(value: string, voiceTurn = false) {
    const question = value.trim();
    const files = voiceTurn ? [] : draftFiles;
    if (!question && !files.length) return;
    if (voice.endFromText(question)) return;
    if (request.current) {
      if (voiceTurn) queuedVoice.current.push(question);
      return;
    }
    const controller = new AbortController();
    const serial = generation.current;
    request.current = controller;
    setPending(true);
    setAlert("");
    try {
      await authorizedScope();
      if (serial !== generation.current) return;
      const previous = context.current;
      const newFiles = files.map(file => ({ file, uploadId: crypto.randomUUID() }));
      const workOrderDraft = previous?.pending?.field === "create" ? pendingWorkOrderFiles.current : [];
      const requestFiles = [...workOrderDraft, ...newFiles].slice(0, 8);
      const excerpts = await Promise.all(files.filter(file => textAttachment.test(file.type) || /\.(txt|csv|md|log)$/i.test(file.name))
        .map(async file => ({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, text: await file.slice(0, 4096).text() })));
      const result = await send({
        question, language, previous, files: [...localFiles, ...excerpts].slice(0, 8),
        attachments: requestFiles.map(({ file }) => ({ name: file.name, type: file.type, size: file.size })),
      }, controller.signal);
      if (serial !== generation.current) return;
      context.current = result.context || context.current;
      pendingWorkOrderFiles.current = result.context?.pending?.field === "create" ? requestFiles : [];
      const attachments = result.proposal?.field === "create" ? requestFiles : newFiles;
      const turn: AskTurn = { id: crypto.randomUUID(), question, result, attachments, attachmentNames: attachments.map(({ file }) => file.name) };
      showTurns([...turnsRef.current, turn]);
      saveTurn(turn, voiceTurn);
      if (voiceTurn) {
        setRecap(previous => [...previous, result.summary].slice(-12));
        if (!noteEdited.current) setDraftNote(previous => [previous, result.summary].filter(Boolean).join("\n").slice(-3000));
        if (spokenCall.current) voice.speak(result.summary);
      } else {
        setDraftFiles([]);
        setQuery(question);
      }
      if (openRef.current && (!voiceTurn || view === "search")) setView("search");
    } catch (error) {
      if (!controller.signal.aborted) {
        setAlert(message(error));
        if (voiceTurn && spokenCall.current) voice.speak(message(error));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
        const nextVoice = queuedVoice.current.shift();
        if (nextVoice && !controller.signal.aborted) void submit(nextVoice, true);
      }
    }
  }

  const voice = useAskCmpriVoice({ onTranscript: text => { void submit(text, true); }, locale: language === "es" ? "es-US" : "en-US" });

  function startVoice(origin: "launcher" | "modal") {
    if (voice.active) return;
    if (origin === "launcher") clearThread();
    callSurface.current = origin;
    spokenCall.current = origin === "launcher";
    callId.current = crypto.randomUUID();
    noteEdited.current = false;
    setDraftNote("");
    setRecap([]);
    setReviewDraft(false);
    voice.start();
  }

  function showModal(detail: OpenDetail) {
    if (closing.current) return;
    if (detail.voice && !openRef.current) {
      startVoice("launcher");
      return;
    }
    const continuedCall = voice.active && callSurface.current === "launcher";
    if (continuedCall) callSurface.current = "modal";
    if (!openRef.current) {
      launcher.current = captureWindowLauncher(detail.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
      setScope("");
      openRef.current = true;
      setOpened(true);
      setTop(Math.ceil(document.querySelector<HTMLElement>("header.cmpri-dashboard-titlebar")?.getBoundingClientRect().bottom || 0));
      pickSample();
      if (!continuedCall && detail.query) clearThread();
    }
    if (detail.query) {
      setQuery(detail.query);
      setView("search");
      void submit(detail.query);
    } else if (continuedCall) {
      setView("search");
      void authorizedScope().catch(error => { if (openRef.current) setAlert(message(error)); });
    } else {
      const opening = generation.current;
      void authorizedScope().then(() => {
        if (generation.current === opening && openRef.current) {
          const recent = historyRef.current[0];
          setView(recent ? "history" : "search");
          if (recent) setExpandedHistory(recent.id);
        }
      }).catch(error => { if (openRef.current) setAlert(message(error)); });
    }
    if (detail.voice) startVoice("modal");
    voice.refreshMicrophone();
  }

  function dismiss({ focus = true, animate = true } = {}) {
    if (!openRef.current || closing.current) return;
    closing.current = true;
    const origin = launcher.current;
    const finish = () => {
      openRef.current = false;
      closing.current = false;
      dialog.current?.close();
      setOpened(false);
      if (focus && origin) focusAfterLayout(currentWindowLauncher(origin));
    };
    request.current?.abort();
    queuedVoice.current = [];
    pendingWorkOrderFiles.current = [];
    if (context.current?.pending) context.current = undefined;
    if (turnsRef.current.some(turn => turn.result.proposal)) {
      showTurns(turnsRef.current.map(turn => turn.result.proposal
        ? { ...turn, result: { ...turn.result, proposal: undefined }, outcome: t("Proposal closed.") } : turn));
    }
    voice.stop();
    const transition = animate ? animateWindowTelescope(dialog.current, origin, "close") : null;
    if (transition) void transition.finished.then(finish, finish);
    else finish();
  }

  const onOpen = useEffectEvent((event: Event) => showModal((event as CustomEvent<OpenDetail>).detail || {}));
  const onStop = useEffectEvent(() => voice.stop());
  const onSignOut = useEffectEvent(() => {
    clearThread();
    historyRef.current = [];
    scopeRef.current = "";
    setScope("");
    setHistory([]);
    setLocalFiles([]);
    voice.stop();
    dismiss({ focus: false, animate: false });
  });
  useEffect(() => {
    window.addEventListener("cmpri-ask-open", onOpen);
    window.addEventListener("cmpri-ask-stop-voice", onStop);
    window.addEventListener("cmpri-workspace-sign-out", onSignOut);
    return () => {
      window.removeEventListener("cmpri-ask-open", onOpen);
      window.removeEventListener("cmpri-ask-stop-voice", onStop);
      window.removeEventListener("cmpri-workspace-sign-out", onSignOut);
    };
  }, []);
  const onRoute = useEffectEvent(() => {
    if (openRef.current) dismiss({ focus: false, animate: false });
    else if (voice.active) voice.stop();
  });
  useEffect(() => { onRoute(); }, [pathname]);

  useLayoutEffect(() => {
    if (!opened || !dialog.current || dialog.current.open) return;
    dialog.current.showModal();
    animateWindowTelescope(dialog.current, launcher.current, "open");
    if (desktop()) field.current?.focus({ preventScroll: true });
  }, [opened]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("cmpri-ask-state", { detail: {
      open: opened, voiceActive: voice.active && callSurface.current === "launcher",
      voiceDraft: callSurface.current === "launcher" ? voice.draft : "", voiceStatus: voice.status,
    } }));
  }, [opened, voice.active, voice.draft, voice.status]);
  useLayoutEffect(() => {
    if (!opened || !field.current) return;
    field.current.style.height = "auto";
    field.current.style.height = Math.min(field.current.scrollHeight, 120) + "px";
  }, [opened, query, view]);
  useLayoutEffect(() => {
    const form = footer.current;
    if (!opened || !form) return;
    const observer = new ResizeObserver(() => {
      dialog.current?.style.setProperty("--ask-footer-height", form.offsetHeight + "px");
    });
    observer.observe(form);
    return () => observer.disconnect();
  }, [opened, view]);
  useLayoutEffect(() => {
    if (view === "search" && results.current) results.current.scrollTop = results.current.scrollHeight;
  }, [view, turns.length]);

  const addFiles = useCallback((files: File[]) => {
    setDraftFiles(current => [...current, ...files.filter(file => file.size > 0 && file.size <= 100 * 1024 * 1024)].slice(0, 8));
  }, []);
  const drop = useAskCmpriAttachmentDrop({ onSelect: addFiles, enabled: opened && view === "search" });

  function selectTab(next: View) {
    setView(next);
    if (results.current) results.current.scrollTop = 0;
  }

  function tabsKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = views.findIndex(tab => tab.id === view);
    const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1
      : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length
        : event.key === "ArrowRight" ? (index + 1) % views.length : -1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(views[next].id);
    focusAfterLayout(document.getElementById("ask-cmpri-" + views[next].id + "-tab"));
  }

  function resume(entry: AskHistoryEntry) {
    clearThread();
    context.current = entry.context;
    showTurns(entry.turns);
    setQuery(entry.turns.at(-1)?.question || "");
    setView("search");
    focusAfterLayout(field.current);
  }

  function openRecord(record: AskRecordReference) {
    if (record.kind === "staffNote") {
      selectTab("staff");
      return;
    }
    const href = recordPath(record);
    if (!href) return;
    dismiss({ focus: false, animate: false });
    window.dispatchEvent(new CustomEvent("cmpri-open-modal", { detail: { href, title: record.label } }));
  }

  function updateTurn(id: string, change: Partial<AskTurn>) {
    const newer = turnsRef.current.map(turn => turn.id === id ? { ...turn, ...change } : turn);
    showTurns(newer);
    storeHistory(historyRef.current.map(entry => ({ ...entry, turns: entry.turns.map(turn => turn.id === id ? savedAskTurn({ ...turn, ...change }) : turn) })));
  }

  async function saveAttachments(turn: AskTurn, order: NonNullable<AskResponse["savedOrder"]>) {
    const photos = (turn.attachments || []).filter(entry => entry.file.type.startsWith("image/") || entry.file.type.startsWith("video/"));
    const headers = await authorizationHeaders();
    const accessToken = headers.Authorization.replace(/^Bearer /, "");
    for (const { file, uploadId } of photos) {
      const upload = await uploadWorkOrderAttachment(order.id, file, accessToken, uploadId);
      if (!upload.ok) throw new Error(upload.message);
    }
  }

  async function confirmTurn(turn: AskTurn) {
    if (request.current || (!turn.result.proposal && !turn.savedOrder)) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setAlert("");
    const serial = generation.current;
    let savedOrder = turn.savedOrder;
    try {
      const result = savedOrder ? turn.result : await send({ confirmationToken: turn.result.proposal?.token }, controller.signal);
      if (serial !== generation.current) return;
      savedOrder ||= result.savedOrder;
      const { proposal: _proposal, ...safe } = result;
      void _proposal;
      updateTurn(turn.id, { result: safe, outcome: undefined, savedOrder });
      if (savedOrder && turn.attachments?.length) await saveAttachments(turn, savedOrder);
      if (serial === generation.current) updateTurn(turn.id, { savedOrder: undefined, outcome: undefined });
    } catch (error) {
      if (!controller.signal.aborted && serial === generation.current) {
        if (savedOrder) updateTurn(turn.id, { savedOrder, outcome: t("The work order was saved. Retry the attachment upload.") });
        setAlert(message(error));
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
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
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [opened]);

  const style = {
    "--ask-top": `${top}px`,
    ...(windowRect ? { "--ask-x": `${windowRect.x + 8}px`, "--ask-y": `${windowRect.y + top + 8}px`,
      "--ask-width": `${windowRect.width}px`, "--ask-height": `${windowRect.height}px` } : {}),
  } as CSSProperties;
  const engaged = !!turns.length || voice.active;
  const mic = <button type="button" className="ask-pill-icon ask-mic" aria-label={t("Start voice call")}
    title={voice.microphone.text} onClick={() => startVoice("modal")}><i aria-hidden="true" /></button>;
  const askSample = <div className="ask-sample-question">
    <p>{t("Sample question")}</p>
    <button type="button" onClick={() => { void submit(sample); }} disabled={pending}>{sample}</button>
  </div>;

  return <dialog ref={dialog} id="ask-cmpri" className="cmpri-ask cmpri-desktop-window" data-active="true" data-cmpri-modal-theme="true"
    data-positioned={windowRect ? "true" : undefined} aria-labelledby="ask-cmpri-title" style={style}
    onCancel={event => { event.preventDefault(); if (voice.active) voice.stop(); else dismiss(); }} {...drop.dropProps}>
    {opened && <>
      <header className="ask-titlebar cmpri-desktop-titlebar">
        <div className="cmpri-title-content" id="ask-cmpri-title" role="heading" aria-level={2}><i className="ask-gemini-mark" aria-hidden="true" />{t("Ask CMPRI")}</div>
        <div className="ask-title-actions">
          <div className="ask-tabs" role="tablist" aria-label={t("Ask CMPRI views")} onKeyDown={tabsKey}>
            {views.map(tab => <button type="button" role="tab" key={tab.id} id={`ask-cmpri-${tab.id}-tab`} aria-controls={tab.panel}
              aria-selected={view === tab.id} tabIndex={view === tab.id ? 0 : -1} onClick={() => selectTab(tab.id)}>{t(tab.label)}</button>)}
          </div>
          <button type="button" className="cmpri-desktop-close" aria-label={t("Close Ask CMPRI")} title={t("Close")} onClick={() => dismiss()}>
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
      </header>
      <AskCmpriFiles open={opened} active={view === "files"} scopeKey={scope} onOpenFiles={() => selectTab("files")} onFilesChange={setLocalFiles} />
      <div ref={results} className="ask-body" data-view={view} hidden={view === "files"} tabIndex={0} aria-label={t("Ask CMPRI results")}>
        <div id="ask-cmpri-search-view" className="ask-search-view" role="tabpanel" aria-labelledby="ask-cmpri-search-tab" hidden={view !== "search"}>
          {(!scope || !turns.length) ? <div className="ask-welcome">
            <i className="ask-gemini-mark" aria-hidden="true" />
            <h3>{t("What can I help you find?")}</h3>
            <p>{t("Ask in your own words about CMPRI records you can access or manufacturer information. You can ask a follow-up or choose how to see the answer.")}</p>
            {askSample}
          </div> : <div role="log" aria-label={t("Search conversation")} className="ask-thread">
            {turns.map(turn => <article className="ask-turn" key={turn.id}>
              {turn.question && <p className="ask-question">{turn.question}</p>}
              {!!turn.attachments?.length ? <AskCmpriFileList files={turn.attachments.map(entry => entry.file)} outgoing locale={language} />
                : !!turn.attachmentNames?.length && <ul className="ask-sent-files" aria-label={t("Attachments")}>{turn.attachmentNames.map((name, i) => <li key={i}>{name}</li>)}</ul>}
              <AskCmpriAnswer result={turn.result} openRecord={openRecord} />
              {turn.result.proposal && <section className="ask-proposal">
                <h4>{turn.result.proposal.label}</h4>
                {turn.result.proposal.from && <p>{t("Current")} · {turn.result.proposal.from}</p>}
                <p>{t("Proposed")} · {turn.result.proposal.to}</p>
                <div className="ask-proposal-actions">
                  <button type="button" className="ask-confirm" disabled={pending} onClick={() => { void confirmTurn(turn); }}>
                    {turn.result.proposal.field === "create" && turn.result.context?.language === "es" ? "Confirmar y enviar" : t(turn.result.proposal.field === "create" ? "Confirm submission" : "Confirm edit")}
                  </button>
                  <button type="button" className="ask-quiet" disabled={pending} onClick={() => updateTurn(turn.id, { result: { ...turn.result, proposal: undefined }, outcome: t("Change cancelled.") })}>{turn.result.context?.language === "es" ? "Cancelar" : t("Cancel")}</button>
                </div>
              </section>}
              {turn.outcome && <p className="ask-outcome" role="status">{turn.outcome}</p>}
              {turn.savedOrder && <button type="button" className="ask-quiet" disabled={pending} onClick={() => { void confirmTurn(turn); }}>{t("Retry attachment upload")}</button>}
            </article>)}
          </div>}
          {pending && <p className="ask-request-status" role="status">{t("Searching…")}</p>}
          {alert && <p className="ask-request-status" role="alert">{alert}</p>}
        </div>
        <div id="ask-cmpri-staff-view" className="ask-staff-view" role="tabpanel" aria-labelledby="ask-cmpri-staff-tab" hidden={view !== "staff"}>
          {view === "staff" && scope && <StaffNotes />}
        </div>
        <div id="ask-cmpri-history-view" className="ask-history-view" role="tabpanel" aria-labelledby="ask-cmpri-history-tab" hidden={view !== "history"}>
          <h3>{t("Saved searches")}</h3>
          <p>{t("Seven days in the device cache. Keep searches you want to return to.")}</p>
          {askSample}
          {scope && history.map(entry => <details key={entry.id} open={expandedHistory === entry.id ? true : undefined} className="ask-history-entry">
            <summary>{entry.question}<time dateTime={new Date(entry.date).toISOString()}>{new Date(entry.date).toLocaleDateString(language)}{entry.kept ? " · " + t("Kept") : ""}</time></summary>
            {entry.turns.map(turn => <AskCmpriAnswer key={turn.id} result={turn.result} openRecord={openRecord} />)}
            <div className="ask-history-actions">
              <button type="button" className="ask-quiet" onClick={() => resume(entry)}>{t("Resume search")}</button>
              <button type="button" className="ask-quiet" onClick={() => storeHistory(historyRef.current.map(item => item.id === entry.id ? { ...item, kept: !item.kept } : item))}>{t(entry.kept ? "Unkeep" : "Keep")}</button>
              <button type="button" className="ask-quiet" onClick={() => storeHistory(historyRef.current.filter(item => item.id !== entry.id))}>{t("Delete")}</button>
            </div>
          </details>)}
          {!history.length && <p>{t("Search something to start building your history.")}</p>}
        </div>
      </div>
      {view === "search" && <footer ref={footer} className="ask-footer">
        {(voice.active || reviewDraft) && <div className="ask-voice-panel">
          {voice.active && <div className="ask-voice-meta"><strong>{t("Voice call")}</strong><span role="status">{voice.status}</span></div>}
          {voice.typingFallback && <button type="button" className="ask-text-action" onClick={() => focusAfterLayout(field.current)}>{t("Type a question")}</button>}
          {voice.draft && <p>{voice.draft}</p>}
          <div className="ask-voice-columns">
            <section><h3>{t("Running summary")}</h3><div className="ask-recap" aria-live="polite">{recap.length ? recap.map((line, i) => <p key={i}>{line}</p>) : <p>{t("Topics and findings appear as you talk.")}</p>}</div></section>
            <section><label htmlFor="ask-cmpri-draft-note">{t("Draft note")}</label>
              <textarea id="ask-cmpri-draft-note" rows={2} placeholder={t("Notes from this call appear here.")} value={draftNote} onChange={event => { noteEdited.current = true; setDraftNote(event.target.value); }} />
            </section>
          </div>
        </div>}
        {!voice.active && draftNote && <p className="ask-voice-panel ask-voice-meta" role="status">{t("Call ended. Draft note ready to review.")}
          <button type="button" className="ask-text-action" onClick={() => setReviewDraft(previous => !previous)}>{t(reviewDraft ? "Hide draft" : "View draft")}</button>
        </p>}
        <AskCmpriAttachmentDrafts files={draftFiles} onRemove={index => setDraftFiles(current => current.filter((_, i) => i !== index))} disabled={pending} locale={language} />
        <form className="ask-search-pill" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(query); }}>
          {engaged ? <button type="button" className="ask-pill-icon ask-new" aria-label={t(voice.active ? "New topic" : "New search")}
            onClick={() => { field.current?.blur(); clearThread(); pickSample(); if (voice.active) voice.newTopic(); else { setDraftNote(""); setRecap([]); setReviewDraft(false); } }}>+</button> : mic}
          <div className="ask-query-box"><i className="ask-gemini-mark" aria-hidden="true" />
            <label className="sr-only" htmlFor="ask-cmpri-query">{t("Ask CMPRI")}</label>
            <textarea ref={field} id="ask-cmpri-query" rows={1} maxLength={650} enterKeyHint="search" placeholder={t("Ask CMPRI")}
              value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(query); }
              }} />
          </div>
          {voice.active ? <button className="ask-stop" type="button" onClick={voice.stop}><span aria-hidden="true" />{t("Stop")}</button> : engaged && mic}
          <AskCmpriAttachments onSelect={addFiles} disabled={pending} locale={language} />
          <button className="ask-search-control" type="submit" aria-label={t("Search")} title={t("Search")} disabled={pending}><i aria-hidden="true" /></button>
        </form>
      </footer>}
      {drop.dragging && <AskCmpriAttachmentDropIndicator locale={language} />}
      <div className="ask-resize-boundaries">
        {RESIZE_EDGES.map(edge => <button key={edge} type="button" data-ask-resize={edge} tabIndex={edge === "se" ? 0 : -1}
          aria-hidden={edge !== "se" || undefined} aria-label={edge === "se" ? t("Resize Ask CMPRI with arrow keys") : undefined}
          onPointerDown={event => startResize(event, edge)} onPointerMove={moveResize} onLostPointerCapture={() => { resize.current = null; }}
          onKeyDown={edge === "se" ? keyboardResize : undefined} />)}
      </div>
    </>}
  </dialog>;
}
