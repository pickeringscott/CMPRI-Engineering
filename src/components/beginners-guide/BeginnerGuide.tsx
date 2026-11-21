"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { profileIsChiefEngineer, roleKey } from "@/lib/server/roles";
import GuideFlowchart, { type GuidePhase } from "./GuideFlowchart";
import GuideWalkthrough, { type GuideAction } from "./GuideWalkthrough";
import "./beginners-guide.css";

type GuideUser = { id: string; name: string; role: string; displayRole?: string };
type GuideLesson = {
  key: string;
  title: string;
  purpose?: string;
  when?: string;
  actions: GuideAction[];
};
type GuideRole = {
  title: string;
  responsibility: string;
  shift: string;
  workflow: string;
  phases: GuidePhase[];
  lessons: GuideLesson[];
};
type GuideData = { roles: Partial<Record<string, GuideRole>> };
type Position = { stop: number; action: number };
type LaunchReason = "First app open" | "New Front Desk session" | "Reopened from the dashboard";

const WELCOME: Position = { stop: 0, action: 0 };
const ROLLOUT_END = Date.parse("2026-11-24T23:00:00-06:00");
const WORK_ORDER_HANDOFF = [
  ["Front Desk & Housekeeping", "Report what happened and add room access or turnover details."],
  ["Engineering", "Verify the issue, assign the work, and record the repair."],
  ["Property leadership", "Follow guest impact and help departments coordinate the next step."],
];
const openedInMemory = new Set<string>();
const sessionInMemory = new Set<string>();
let guideData: Promise<GuideData> | undefined;

function loadGuideData() {
  guideData ??= import("./guide-lessons.json").then(({ default: data }) => data as unknown as GuideData).catch((error: unknown) => {
    guideData = undefined;
    throw error;
  });
  return guideData;
}

function hasMarker(storage: "localStorage" | "sessionStorage", key: string, memory: Set<string>) {
  try {
    return window[storage].getItem(key) === "1" || memory.has(key);
  } catch {
    return memory.has(key);
  }
}

function setMarker(storage: "localStorage" | "sessionStorage", key: string, memory: Set<string>) {
  memory.add(key);
  try { window[storage].setItem(key, "1"); } catch { /* Storage can be unavailable in private browsing. */ }
}

export default function BeginnerGuide({ user }: { user: GuideUser }) {
  const role = user.displayRole === "Chief Engineer" || profileIsChiefEngineer({ role: user.role })
    ? "chief_engineer"
    : roleKey(user.role);
  const openedKey = "cmpri:beginners-guide:opened:" + user.id;
  const sessionKey = "cmpri:beginners-guide:session:" + user.id;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>(WELCOME);
  const [launchReason, setLaunchReason] = useState<LaunchReason>("Reopened from the dashboard");
  const [content, setContent] = useState<GuideRole | null>(null);
  const [loadError, setLoadError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const titleId = useId();

  const openGuide = useCallback((reason: LaunchReason) => {
    setMarker("localStorage", openedKey, openedInMemory);
    setMarker("sessionStorage", sessionKey, sessionInMemory);
    setPosition(WELCOME);
    setLaunchReason(reason);
    setLoadError(false);
    setOpen(true);
  }, [openedKey, sessionKey]);

  useEffect(() => {
    if (role === "unknown") return;
    const frame = requestAnimationFrame(() => {
      const firstOpen = !hasMarker("localStorage", openedKey, openedInMemory);
      const rolloutSession = role === "front_desk" && Date.now() < ROLLOUT_END &&
        !hasMarker("sessionStorage", sessionKey, sessionInMemory);
      if (firstOpen || rolloutSession) openGuide(firstOpen ? "First app open" : "New Front Desk session");
    });
    return () => cancelAnimationFrame(frame);
  }, [openGuide, openedKey, role, sessionKey]);

  useEffect(() => {
    function clearSession() {
      sessionInMemory.delete(sessionKey);
      try { window.sessionStorage.removeItem(sessionKey); } catch { /* Storage may be unavailable. */ }
    }
    window.addEventListener("cmpri-workspace-sign-out", clearSession);
    return () => window.removeEventListener("cmpri-workspace-sign-out", clearSession);
  }, [sessionKey]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadGuideData().then(data => {
      if (!active) return;
      setContent(data.roles[role] ?? null);
      setLoadError(!data.roles[role]);
    }).catch(() => {
      if (active) setLoadError(true);
    });
    return () => { active = false; };
  }, [open, role]);

  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    if (!dialog.current.open) dialog.current.showModal();
    title.current?.focus({ preventScroll: true });
  }, [content, open, position.stop]);

  useLayoutEffect(() => {
    const track = rail.current;
    const selected = track?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!track || !selected) return;
    track.scrollLeft += selected.getBoundingClientRect().left - track.getBoundingClientRect().left +
      (selected.offsetWidth - track.clientWidth) / 2;
  }, [position.stop, content]);

  useEffect(() => () => animation.current?.cancel(), []);

  function closeGuide() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  function dismiss() {
    if (animation.current) return;
    const windowElement = dialog.current;
    const link = trigger.current;
    if (!windowElement || !link || typeof windowElement.animate !== "function") {
      closeGuide();
      return;
    }
    const from = windowElement.getBoundingClientRect();
    const to = link.getBoundingClientRect();
    const x = to.left + to.width / 2 - (from.left + from.width / 2);
    const y = to.top + to.height / 2 - (from.top + from.height / 2);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    windowElement.dataset.dismissing = "";
    const moving = windowElement.animate([
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: "translate(" + x + "px, " + y + "px) scale(.09)", opacity: 0 },
    ], { duration: reduced ? 130 : 470, easing: "cubic-bezier(.55,.07,.75,.4)", fill: "forwards" });
    animation.current = moving;
    void moving.finished.then(() => {
      if (animation.current !== moving) return;
      animation.current = null;
      closeGuide();
    }).catch(() => undefined);
  }

  if (role === "unknown") return null;

  const lesson = position.stop >= 2 ? content?.lessons[position.stop - 2] : undefined;
  const phase = position.stop === 1 ? content?.phases[position.action] : undefined;
  const action = lesson?.actions[position.action];
  const stepsInStop = position.stop === 1 ? content?.phases.length ?? 0 : lesson?.actions.length ?? 0;
  const stops = ["Welcome", "Work Order Flowchart",
    ...(content?.lessons.map(item => item.key === "/work-orders" ? "Create a Work Order" : item.title) ?? [])];
  const firstName = user.name.trim().split(/\s+/)[0];
  const welcome = position.stop === 0;
  const lastStop = position.stop === stops.length - 1;
  const lastAction = position.action + 1 >= stepsInStop;

  function next() {
    if (!content || animation.current) return;
    if (!lastAction) {
      setPosition({ ...position, action: position.action + 1 });
    } else if (lastStop) {
      closeGuide();
    } else {
      setPosition({ stop: position.stop + 1, action: 0 });
    }
  }

  function back() {
    if (!content || animation.current) return;
    if (position.action) {
      setPosition({ ...position, action: position.action - 1 });
      return;
    }
    const stop = Math.max(position.stop - 1, 0);
    const last = stop === 1 ? content.phases.length : content.lessons[stop - 2]?.actions.length;
    setPosition({ stop, action: Math.max((last ?? 1) - 1, 0) });
  }

  function jump(stop: number) {
    if (content && !animation.current) setPosition({ stop, action: 0 });
  }

  return <>
    <button ref={trigger} type="button" className="cmpri-guide-launcher"
      onClick={() => openGuide("Reopened from the dashboard")} aria-haspopup="dialog" aria-expanded={open}>
      Beginner’s Guide
    </button>
    {open && <dialog
      ref={dialog}
      className="cmpri-beginners-guide"
      data-cmpri-guide-dialog
      data-guide-page={welcome ? "welcome" : phase ? "chart" : "lesson"}
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); dismiss(); }}
    >
      <header className="cmpri-guide-chrome">
        <span className="cmpri-guide-brand">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M2.5 4.5c2.6-.6 5.1-.2 7.5 1.6 2.4-1.8 4.9-2.2 7.5-1.6v10.2c-2.6-.6-5.1-.2-7.5 1.6-2.4-1.8-4.9-2.2-7.5-1.6zm7.5 1.6v10.2" />
          </svg>
          Beginner’s Guide
        </span>
        <div className="cmpri-guide-chrome-actions">
          <span>{welcome ? "Welcome" : phase ? "How CMPRI works" : "Walkthrough"}</span>
          <button type="button" className="cmpri-guide-close" aria-label="Close Beginner’s Guide" onClick={dismiss}>×</button>
        </div>
      </header>
      {!content && <div className="cmpri-guide-message" role="status">
        <h1 id={titleId} ref={title} tabIndex={-1}>Beginner’s Guide</h1>
        <p>{loadError ? "The guide couldn’t load. Close it and use Beginner’s Guide to try again." : "Loading your guide…"}</p>
      </div>}
      {content && welcome && <div className="cmpri-guide-welcome">
        <h1 id={titleId} ref={title} tabIndex={-1}>
          <span>Welcome to</span>
          <span>Residence Inn Champaign{firstName ? ", " + firstName : ""}</span>
        </h1>
        <p>We’re glad you’re here! Every clear guest report, room update, and repair note helps the next person pick up where you left off.</p>
        <p>This guide follows a Room 204 work order from the first report to the repair. You’ll see how your role connects with your teammates and where to find the tools you need.</p>
        <section className="cmpri-guide-handoff" aria-labelledby={titleId + "-handoff"}>
          <h2 id={titleId + "-handoff"}>One work order connects the team.</h2>
          <ul>
            {WORK_ORDER_HANDOFF.map(([department, description]) => <li key={department}>
              <strong>{department}</strong>
              <p>{description}</p>
            </li>)}
          </ul>
          <p className="cmpri-guide-example-ticket">WO#4218 · Room 204 · Bathroom sink drains slowly</p>
        </section>
        <details className="cmpri-guide-role">
          <summary>Your role in CMPRI · {content.title}</summary>
          <dl>
            <dt>What you’re responsible for</dt><dd>{content.responsibility}</dd>
            <dt>A typical shift</dt><dd>{content.shift}</dd>
            <dt>How your work helps the team</dt><dd>{content.workflow}</dd>
          </dl>
        </details>
        <p className="cmpri-guide-reopen">Reopen Beginner’s Guide anytime from the lower-left corner.</p>
      </div>}
      {phase && <div className="cmpri-guide-chart-page">
        <h1 id={titleId} ref={title} tabIndex={-1}>Your part in a work order</h1>
        <p>CMPRI keeps reports, repairs, inspections, and shift handoffs connected to the same work order.</p>
        <GuideFlowchart phase={phase} />
      </div>}
      {lesson && action && <div className="cmpri-guide-lesson-page">
        <h1 id={titleId} ref={title} tabIndex={-1}>{lesson.title}</h1>
        <GuideWalkthrough key={lesson.key} title={lesson.title} purpose={lesson.purpose} when={lesson.when} action={action}
          onTry={action.target && (!lastAction || !lastStop) ? next : undefined} />
      </div>}
      <footer className="cmpri-guide-footer">
        <div className="cmpri-guide-footer-controls">
          <p aria-live="polite">{content && (welcome ? launchReason : phase ? "Use Next to follow the work order." :
            lesson ? "Tool " + (position.stop - 1) + " of " + content.lessons.length + " · Action " +
              (position.action + 1) + " of " + stepsInStop : "")}</p>
          <div className="cmpri-guide-nav-buttons">
            {welcome
              ? <button type="button" className="cmpri-guide-quiet" onClick={dismiss}>Skip</button>
              : <button type="button" className="cmpri-guide-quiet" onClick={back}>Back</button>}
            <button type="button" className="cmpri-guide-primary" disabled={!content} onClick={next}>
              {welcome ? "Start Guide" : phase && lastAction ? "Start walkthrough" : lastStop && lastAction ? "Finish Guide" : "Next"}
            </button>
          </div>
        </div>
        {content && <nav className="cmpri-guide-progress" aria-label="Jump through the Beginner’s Guide">
          <input
            type="range" min={0} max={stops.length - 1} value={position.stop}
            aria-label="Walkthrough progress" aria-valuetext={stops[position.stop]}
            onChange={event => jump(Number(event.target.value))}
          />
          <div ref={rail} className="cmpri-guide-stops">
            {stops.map((stop, index) => <button key={index} type="button"
              aria-current={index === position.stop ? "step" : undefined} onClick={() => jump(index)}>
              {stop}
            </button>)}
          </div>
        </nav>}
      </footer>
    </dialog>}
  </>;
}
