"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DesktopWindow from "@/components/desktop/DesktopWindow";
import DesktopFrame from "@/components/desktop/DesktopFrame";
import type { DesktopBounds, WindowRect } from "@/lib/ui/desktop-windows";
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
};

const EMPTY: SafetyState = { status: "unavailable", checkedAt: null, source: null, error: "", alerts: [], notifications: [], autoOpenKeys: [] };
// Preview-only page memory. Closing/reopening a Weather window must not reopen
// a dismissed, unchanged warning. Nothing is written to browser storage or DB.
const seenAutoOpens = new Set<string>();
const central = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const stamp = (value: number | null) => value === null ? "Unavailable" : central.format(new Date(value));
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
  const [safety, setSafety] = useState<SafetyState>(EMPTY);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const snapshot = useRef<SafetyState>(EMPTY);
  const selected = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  const registerRef = useRef(props.registerFrame);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const token = new URL(props.src, "https://cmpri.invalid").searchParams.get("modalToken");
  useEffect(() => { registerRef.current = props.registerFrame; }, [props.registerFrame]);

  const send = useCallback((type: string, extra: Record<string, unknown> = {}) => {
    frameRef.current?.contentWindow?.postMessage({ type, modalToken: token, ...extra }, window.location.origin);
  }, [token]);
  const openDetails = useCallback((key: string) => {
    const value = snapshot.current.notifications.find(item => item.key === key) || snapshot.current.alerts.find(item => item.key === key);
    if (!value) return;
    if (!selected.current) priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selected.current = key; setSelectedKey(key);
  }, []);
  const closeDetails = useCallback(() => {
    const key = selected.current;
    if (key) seenAutoOpens.add(key);
    selected.current = null; setSelectedKey(null);
    if (dialogRef.current?.open) dialogRef.current.close();
    send("cmpri-weather-safety-dismissed", { key });
    if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true });
  }, [send]);
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    frameCleanup.current?.(); frameCleanup.current = null;
    frameRef.current = frame; registerRef.current(frame);
    if (frame) {
      const request = () => frame.contentWindow?.postMessage({ type: "cmpri-weather-safety-request-state", modalToken: token }, window.location.origin);
      frame.addEventListener("load", request);
      frameCleanup.current = () => frame.removeEventListener("load", request);
    }
  }, [token]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = object(event.data), frame = frameRef.current;
      if (!data || !frame || !token || event.origin !== window.location.origin || event.source !== frame.contentWindow || data.modalToken !== token) return;
      if (data.type === "cmpri-weather-safety-state") {
        const next = parseState(data.payload); if (!next) return;
        const previous = snapshot.current;
        snapshot.current = next; setSafety(next);
        const oldSelected = previous.alerts.find(item => item.key === selected.current);
        if (oldSelected && !next.alerts.some(item => item.id === oldSelected.id && item.status === "active")) closeDetails();
        const candidates = next.autoOpenKeys.map(key => next.alerts.find(item => item.key === key)).filter((item): item is SafetyRecord => Boolean(item && !seenAutoOpens.has(item.key) && !item.stale && item.status === "active" && (item.simulated || next.status === "live") && (level(item) === "warning" && item.sourceType === "official" || item.simulated && item.walkwayIceRisk)));
        // One full-screen notice presents the whole active batch. Mark every
        // warning in that batch as handled so an unchanged response cannot
        // reopen another warning after the user dismisses the shared notice.
        if (candidates.length) { candidates.forEach(item => seenAutoOpens.add(item.key)); while (seenAutoOpens.size > 1000) seenAutoOpens.delete(seenAutoOpens.values().next().value!); openDetails(candidates[0].key); }
      } else if (data.type === "cmpri-weather-safety-open" && typeof data.key === "string") openDetails(data.key);
      else if (data.type === "cmpri-weather-safety-close") closeDetails();
      else if (data.type === "cmpri-weather-safety-reset-samples") Array.from(seenAutoOpens).forEach(key => { if (key.startsWith("SIM")) seenAutoOpens.delete(key); });
    }
    window.addEventListener("message", receive);
    send("cmpri-weather-safety-request-state");
    return () => { window.removeEventListener("message", receive); frameCleanup.current?.(); };
  }, [token, send, openDetails, closeDetails]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedKey && dialog && !dialog.open) { dialog.showModal(); dialog.querySelector<HTMLButtonElement>("[data-weather-guest-safety-close]")?.focus(); }
    else if (!selectedKey && dialog?.open) dialog.close();
  }, [selectedKey]);

  const record = safety.notifications.find(item => item.key === selectedKey) || safety.alerts.find(item => item.key === selectedKey);
  const fullScreen = Boolean(record && (level(record) === "warning" || record.walkwayIceRisk));
  const tickerAlerts = safety.alerts.filter(item => item.status === "active" && item.sourceType === "official" && ["warning", "watch"].includes(level(item)));
  const tickerLevel = tickerAlerts.some(item => level(item) === "warning") ? "warning" : "watch";
  const tickerText = tickerAlerts.map(item => (item.simulated ? "SIMULATION · " : item.stale ? "LAST VERIFIED · " : "") + item.event + " · expires " + stamp(item.expires)).join("     •     ");
  const ticker = tickerAlerts.length ? <button type="button" data-weather-alert-ticker data-level={tickerLevel} className={styles.ticker} aria-label={"Open Guest Safety details: " + tickerText} onClick={() => openDetails((tickerAlerts.find(item => level(item) === "warning") || tickerAlerts[0]).key)}>
    <span className={styles.tickerTrack} style={{ animationDuration: Math.max(20, tickerText.length * .09) + "s" }}>
      {tickerAlerts.map(item => <span key={item.key} data-level={level(item)} className={styles.tickerItem}>{item.simulated ? "SIMULATION · " : item.stale ? "LAST VERIFIED · " : ""}{item.event} · expires {stamp(item.expires)}</span>)}
    </span>
  </button> : undefined;

  return <>
    <DesktopWindow windowKey={props.windowKey} title={props.title} accentClass={props.accentClass} rect={props.rect} bounds={props.bounds} zIndex={props.zIndex} active={props.active} onFocus={props.onFocus} onClose={props.onClose} onRectCommit={props.onRectCommit} belowTitlebar={ticker}>
      <DesktopFrame src={props.src} title={props.title} registerFrame={attachFrame} onFocus={props.onFocus} onOpen={props.onOpen} onReturnToDesktop={props.onReturnToDesktop} />
    </DesktopWindow>
    {typeof document !== "undefined" ? createPortal(<dialog ref={dialogRef} data-weather-guest-safety-dialog data-fullscreen={fullScreen ? "true" : "false"} className={styles.dialog} aria-labelledby="weather-guest-safety-title" aria-describedby="weather-guest-safety-summary" onCancel={event => { event.preventDefault(); closeDetails(); }} onClose={() => { if (selected.current) closeDetails(); }}>
      <header className={styles.dialogHeader}><div><span className={styles.label} data-level={record ? level(record) : "advisory"}>{record?.simulated ? "SIMULATED GUEST SAFETY" : "OFFICIAL NWS · GUEST SAFETY"}</span><h1 id="weather-guest-safety-title">Guest Safety</h1></div><button type="button" data-weather-guest-safety-close className={styles.close} aria-label="Close Guest Safety" onClick={closeDetails}>×</button></header>
      {record ? <main className={styles.dialogContent}>
        <p className={styles.context}>{record.simulated ? "Simulation only · this message does not establish a current NWS warning or observed walkway condition." : "Official NWS alert applying to Residence Inn Champaign."}{record.stale ? " The last alert check is stale or unavailable; current status is unverified." : ""}</p>
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
