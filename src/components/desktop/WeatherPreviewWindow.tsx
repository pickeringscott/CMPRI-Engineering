"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DesktopWindow from "@/components/desktop/DesktopWindow";
import DesktopFrame from "@/components/desktop/DesktopFrame";
import type { DesktopBounds, WindowRect } from "@/lib/ui/desktop-windows";
import { armWeatherWarningSound, playWeatherWarningSound, stopWeatherWarningSound } from "@/lib/weather-warning-sound";
import styles from "./weather-preview-window.module.css";

type SafetyRecord = {
  id: string; key: string; event: string; headline: string; summary: string;
  description: string; officialInstruction: string; hotelInstruction: string;
  effective: number | null; expires: number | null; source: string | null;
  bulletinUrl: string | null; simulated: boolean; stale: boolean;
  sourceType: "official" | "forecast"; status: string; walkwayIceRisk: boolean;
};
type SafetyState = {
  status: string; checkedAt: number | null; source: string | null; error: string;
  alerts: SafetyRecord[]; notifications: SafetyRecord[]; autoOpenKeys: string[];
};
type Props = {
  windowKey: string; title: string; accentClass: string; src: string;
  rect: WindowRect; bounds: DesktopBounds; zIndex: number; active: boolean;
  onFocus: () => void; onClose: () => void; onRectCommit: (rect: WindowRect) => void;
  registerFrame: (frame: HTMLIFrameElement | null) => void;
  onOpen: (href: string, title: string) => void; onReturnToDesktop: () => void;
  visible: boolean; use24HourTime: boolean; bulletinHost: HTMLElement | null;
};

const EMPTY: SafetyState = { status: "unavailable", checkedAt: null, source: null, error: "", alerts: [], notifications: [], autoOpenKeys: [] };
// Preview-only page memory. Closing/reopening a Weather window must not reopen
// a dismissed, unchanged warning. Nothing is written to browser storage or DB.
const seenAutoOpens = new Set<string>();
const level = (value: SafetyRecord) => /warning$/i.test(value.event) ? "warning" : /watch$/i.test(value.event) ? "watch" : "advisory";
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown, limit = 16000) { return typeof value === "string" ? value.slice(0, limit) : ""; }
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function sourceUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "weather.gov" || url.hostname.endsWith(".weather.gov")) ? url.href : null; } catch { return null; }
}
function parseRecord(input: unknown): SafetyRecord | null {
  const value = object(input);
  if (!value || !string(value.id, 800) || !string(value.key, 1000) || !string(value.event, 160)) return null;
  return { id: string(value.id, 800), key: string(value.key, 1000), event: string(value.event, 160),
    headline: string(value.headline), summary: string(value.summary), description: string(value.description),
    officialInstruction: string(value.officialInstruction), hotelInstruction: string(value.hotelInstruction),
    effective: finite(value.effective), expires: finite(value.expires), source: sourceUrl(value.source), bulletinUrl: sourceUrl(value.bulletinUrl),
    simulated: value.simulated === true, stale: value.stale === true, sourceType: value.sourceType === "forecast" ? "forecast" : "official",
    status: string(value.status, 80), walkwayIceRisk: value.walkwayIceRisk === true };
}
function parseState(input: unknown): SafetyState | null {
  const value = object(input);
  if (!value || !Array.isArray(value.alerts) || !Array.isArray(value.notifications) || value.alerts.length > 200 || value.notifications.length > 100) return null;
  const records = (items: unknown[]) => items.map(parseRecord).filter((item): item is SafetyRecord => Boolean(item));
  return { status: string(value.status, 40), checkedAt: finite(value.checkedAt), source: sourceUrl(value.source), error: string(value.error, 2000),
    alerts: records(value.alerts), notifications: records(value.notifications),
    autoOpenKeys: Array.isArray(value.autoOpenKeys) ? value.autoOpenKeys.filter((key): key is string => typeof key === "string" && key.length <= 1000).slice(0, 200) : [] };
}

/** Used only for the preview Weather route; every other desktop window keeps
 * its existing frame, titlebar, notification behavior, and permissions. */
export default function WeatherPreviewWindow(props: Props) {
  const frameSrc = useMemo(() => {
    const url = new URL(props.src, "https://cmpri.invalid");
    url.searchParams.set("clock", props.use24HourTime ? "24" : "12");
    return url.pathname + url.search + url.hash;
  }, [props.src, props.use24HourTime]);
  const central = useMemo(() => new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    hourCycle: props.use24HourTime ? "h23" : "h12", timeZoneName: "short",
  }), [props.use24HourTime]);
  const stamp = (value: number | null) => value === null ? "Unavailable" : central.format(new Date(value));
  const [safety, setSafety] = useState<SafetyState>(EMPTY);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [soundStatus, setSoundStatus] = useState<"idle" | "blocked" | "unavailable">("idle");
  const soundKey = useRef<string | null>(null);
  const blockedSounds = useRef(new Map<string, string>());
  const sampleEpoch = useRef(0);
  const snapshot = useRef<SafetyState>(EMPTY);
  const selected = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  const registerRef = useRef(props.registerFrame);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(props.visible);
  const token = new URL(props.src, "https://cmpri.invalid").searchParams.get("modalToken");
  useEffect(() => { registerRef.current = props.registerFrame; }, [props.registerFrame]);

  const send = useCallback((type: string, extra: Record<string, unknown> = {}) => {
    frameRef.current?.contentWindow?.postMessage({ type, modalToken: token, ...extra }, window.location.origin);
  }, [token]);
  const openDetails = useCallback((key: string) => {
    const value = snapshot.current.alerts.find(item => item.key === key) || snapshot.current.notifications.find(item => item.key === key);
    if (!value) return;
    if (selected.current && selected.current !== key) { stopWeatherWarningSound(); soundKey.current = null; setSoundStatus("idle"); }
    if (!selected.current) priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selected.current = key; setSelectedKey(key);
    const blocked = blockedSounds.current.get(key);
    if (blocked && value.status === "active" && level(value) === "warning"
      && snapshot.current.alerts.some(item => item.key === key)) { soundKey.current = blocked; setSoundStatus("blocked"); }
  }, []);
  const closeDetails = useCallback(() => {
    const key = selected.current;
    if (key) seenAutoOpens.add(key);
    selected.current = null; setSelectedKey(null);
    stopWeatherWarningSound(); soundKey.current = null; setSoundStatus("idle");
    if (dialogRef.current?.open) dialogRef.current.close();
    send("cmpri-weather-safety-dismissed", { key });
    if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true });
  }, [send]);
  const playWarning = useCallback((key: string) => {
    const recordKey = selected.current;
    soundKey.current = key; setSoundStatus("idle");
    void playWeatherWarningSound(key).then(result => {
      if (soundKey.current === key) {
        if (result === "blocked" && recordKey && selected.current === recordKey) {
          blockedSounds.current.set(recordKey, key);
          while (blockedSounds.current.size > 200) blockedSounds.current.delete(blockedSounds.current.keys().next().value!);
        } else if (recordKey && result !== "canceled") blockedSounds.current.delete(recordKey);
        setSoundStatus(result === "blocked" ? "blocked" : result === "unavailable" ? "unavailable" : "idle");
      }
    });
  }, []);
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    frameCleanup.current?.(); frameCleanup.current = null;
    frameRef.current = frame; registerRef.current(frame);
    if (frame) {
      const request = () => {
        frame.contentWindow?.postMessage({ type: "cmpri-weather-view-state", visible: visibleRef.current, modalToken: token }, window.location.origin);
        frame.contentWindow?.postMessage({ type: "cmpri-weather-safety-request-state", modalToken: token }, window.location.origin);
      };
      frame.addEventListener("load", request);
      frameCleanup.current = () => frame.removeEventListener("load", request);
    }
  }, [token]);

  useEffect(() => {
    visibleRef.current = props.visible;
    send("cmpri-weather-view-state", { visible: props.visible });
  }, [props.visible, send]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = object(event.data), frame = frameRef.current;
      if (!data || !frame || !token || event.origin !== window.location.origin || event.source !== frame.contentWindow || data.modalToken !== token) return;
      if (data.type === "cmpri-weather-safety-state") {
        const next = parseState(data.payload); if (!next) return;
        const previous = snapshot.current;
        snapshot.current = next; setSafety(next);
        blockedSounds.current.forEach((_, key) => { if (!next.alerts.some(item => item.key === key && item.status === "active" && level(item) === "warning")) blockedSounds.current.delete(key); });
        const oldSelected = previous.alerts.find(item => item.key === selected.current);
        if (oldSelected) {
          const current = next.alerts.find(item => item.id === oldSelected.id && item.status === "active");
          if (!current) closeDetails();
          else if (current.key !== oldSelected.key) openDetails(current.key);
        } else if (selected.current && !next.notifications.some(item => item.key === selected.current)
          && !next.alerts.some(item => item.key === selected.current)) closeDetails();
        const candidates = next.autoOpenKeys.map(key => next.alerts.find(item => item.key === key)).filter((item): item is SafetyRecord => Boolean(item && !seenAutoOpens.has(item.key) && !item.stale && item.status === "active" && (item.simulated || next.status === "live") && (level(item) === "warning" && item.sourceType === "official" || item.simulated && item.walkwayIceRisk)));
        // One full-screen notice presents the whole active batch. Mark every
        // warning in that batch as handled so an unchanged response cannot
        // reopen another warning after the user dismisses the shared notice.
        if (candidates.length) { candidates.forEach(item => seenAutoOpens.add(item.key)); while (seenAutoOpens.size > 1000) seenAutoOpens.delete(seenAutoOpens.values().next().value!); const warning = candidates.find(item => level(item) === "warning"); openDetails((warning || candidates[0]).key); if (warning) playWarning((warning.simulated ? "sample:" + sampleEpoch.current + ":" : "") + warning.key); }
      } else if (data.type === "cmpri-weather-safety-open" && typeof data.key === "string") openDetails(data.key);
      else if (data.type === "cmpri-weather-safety-close") closeDetails();
      else if (data.type === "cmpri-weather-safety-reset-samples") { sampleEpoch.current++; blockedSounds.current.clear(); stopWeatherWarningSound(); soundKey.current = null; setSoundStatus("idle"); const keys = new Set(Array.isArray(data.keys) ? data.keys.filter((key): key is string => typeof key === "string" && key.length <= 1000).slice(0, 1000) : []); Array.from(seenAutoOpens).forEach(key => { if (key.startsWith("SIM") || keys.has(key)) seenAutoOpens.delete(key); }); }
      else if (data.type === "cmpri-weather-safety-clear-notifications") { blockedSounds.current.clear(); if (Array.isArray(data.keys)) data.keys.slice(0, 1000).forEach(key => { if (typeof key === "string" && key.length <= 1000) seenAutoOpens.add(key); }); closeDetails(); }
    }
    window.addEventListener("message", receive);
    send("cmpri-weather-safety-request-state");
    return () => { window.removeEventListener("message", receive); frameCleanup.current?.(); stopWeatherWarningSound(); };
  }, [token, send, openDetails, closeDetails, playWarning]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedKey && dialog && !dialog.open) { dialog.showModal(); dialog.querySelector<HTMLButtonElement>("[data-weather-guest-safety-close]")?.focus(); }
    else if (!selectedKey && dialog?.open) dialog.close();
  }, [selectedKey]);

  const record = safety.alerts.find(item => item.key === selectedKey) || safety.notifications.find(item => item.key === selectedKey);
  const currentRecord = Boolean(record && safety.alerts.some(item => item.key === record.key && item.status === "active"));
  const fullScreen = Boolean(currentRecord && record && (level(record) === "warning" || record.walkwayIceRisk));
  const tickerAlerts = safety.alerts.filter(item => item.status === "active" && item.sourceType === "official" && ["warning", "watch"].includes(level(item)));
  const tickerLevel = tickerAlerts.some(item => level(item) === "warning") ? "warning" : "watch";
  const tickerText = tickerAlerts.map(item => (item.simulated ? "SIMULATION · " : item.stale ? "LAST VERIFIED · " : "") + item.event + " · expires " + stamp(item.expires)).join("     •     ");
  const ticker = tickerAlerts.length ? <button type="button" data-weather-alert-ticker data-level={tickerLevel} className={styles.ticker} aria-label={"Open Guest Safety details: " + tickerText} onClick={() => openDetails((tickerAlerts.find(item => level(item) === "warning") || tickerAlerts[0]).key)}>
    <span className={styles.tickerTrack} style={{ animationDuration: Math.max(16, tickerText.length * .075) + "s" }}>
      {tickerAlerts.map(item => <span key={item.key} data-level={level(item)} className={styles.tickerItem}>{item.simulated ? "SIMULATION · " : item.stale ? "LAST VERIFIED · " : ""}{item.event} · expires {stamp(item.expires)}</span>)}
    </span>
  </button> : undefined;

  return <>
    {props.bulletinHost && ticker ? createPortal(ticker, props.bulletinHost) : null}
    <div hidden={!props.visible} data-weather-cached-window data-weather-visible={props.visible ? "true" : "false"} style={{ display: props.visible ? "contents" : "none" }}>
    <DesktopWindow windowKey={props.windowKey} title={props.title} accentClass={props.accentClass} rect={props.rect} bounds={props.bounds} zIndex={props.zIndex} active={props.active} onFocus={props.onFocus} onClose={props.onClose} onRectCommit={props.onRectCommit}>
      <DesktopFrame src={frameSrc} title={props.title} registerFrame={attachFrame} onFocus={props.onFocus} onOpen={props.onOpen} onReturnToDesktop={props.onReturnToDesktop} />
    </DesktopWindow>
    </div>
    {typeof document !== "undefined" ? createPortal(<dialog ref={dialogRef} data-weather-guest-safety-dialog data-level={currentRecord && record ? level(record) : "history"} data-fullscreen={fullScreen ? "true" : "false"} className={styles.dialog} aria-labelledby="weather-guest-safety-title" aria-describedby="weather-guest-safety-summary" onCancel={event => { event.preventDefault(); closeDetails(); }} onClose={() => { if (selected.current) closeDetails(); }}>
      <header className={styles.dialogHeader}><div><span className={styles.label} data-level={currentRecord && record ? level(record) : "history"}>{!currentRecord && record ? "PAST NOTIFICATION · " : ""}{record?.simulated ? "SIMULATED GUEST SAFETY" : "OFFICIAL NWS · GUEST SAFETY"}</span><h1 id="weather-guest-safety-title">Guest Safety</h1></div><button type="button" data-weather-guest-safety-close className={styles.close} aria-label="Close Guest Safety" onClick={closeDetails}>×</button></header>
      {record ? <main className={styles.dialogContent}>
        <p className={styles.context}>{!currentRecord ? "Past notification · " + record.status + ". This is not the current alert state. " : ""}{record.simulated ? "Simulation only · this message does not establish a current NWS warning or observed walkway condition." : "Official NWS alert applying to Residence Inn Champaign."}{record.stale ? " The last alert check is stale or unavailable; current status is unverified." : ""}</p>
        {soundStatus === "blocked" && currentRecord && level(record) === "warning" ? <p className={styles.soundStatus} data-weather-warning-sound="blocked">Your browser paused warning sound. <button type="button" onClick={() => { const key = soundKey.current; if (key) void armWeatherWarningSound().then(() => { if (soundKey.current === key) playWarning(key); }); }}>Enable warning sound</button></p> : soundStatus === "unavailable" && currentRecord ? <p className={styles.soundStatus} data-weather-warning-sound="unavailable">Warning sound unavailable.</p> : null}
        <h2>{record.event}</h2><p id="weather-guest-safety-summary" data-weather-official-summary className={styles.summary}>{record.summary}</p>
        <section className={styles.action}><h3>Hotel action</h3><p data-weather-hotel-instruction>{record.hotelInstruction}</p></section>
        <dl className={styles.times}><div><dt>Effective / expected · Central</dt><dd>{stamp(record.effective)}</dd></div><div><dt>Expires · Central</dt><dd>{stamp(record.expires)}</dd></div><div><dt>Status</dt><dd>{record.status}{record.stale ? " · unverified" : ""}</dd></div></dl>
        {record.description || record.officialInstruction ? <details className={styles.bulletin}><summary>Official NWS bulletin text{record.simulated ? " · sample" : ""}</summary>{record.description ? <p>{record.description}</p> : null}{record.officialInstruction ? <p>{record.officialInstruction}</p> : null}</details> : null}
        {record.bulletinUrl ? <a href={record.bulletinUrl} target="_blank" rel="noopener noreferrer">Read official NWS bulletin ↗</a> : <p className={styles.context}>{record.simulated ? "Simulation · no official bulletin was issued by this example." : "Official bulletin link unavailable."}</p>}
        <nav className={styles.otherAlerts} aria-label="Other active Guest Safety notifications">{safety.alerts.filter(item => item.key !== record.key).map(item => <button key={item.key} type="button" onClick={() => openDetails(item.key)}>{item.simulated ? "Simulation · " : ""}{item.event}</button>)}</nav>
        <button type="button" className={styles.done} onClick={closeDetails}>Close details</button>
      </main> : null}
    </dialog>, document.body) : null}
  </>;
}
