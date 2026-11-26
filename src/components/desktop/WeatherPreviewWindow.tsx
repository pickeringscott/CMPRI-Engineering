"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DesktopWindow from "@/components/desktop/DesktopWindow";
import DesktopFrame from "@/components/desktop/DesktopFrame";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { useTimeFormat } from "@/components/TimeFormatProvider";
import type { DesktopBounds, WindowRect } from "@/lib/ui/desktop-windows";
import { timeFormatOptions } from "@/lib/ui/time-format";
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
const MANUAL_TITLES = {
  notice: "Property weather notice",
  advisory: "Property weather advisory",
  watch: "Property weather watch",
  warning: "Property weather warning",
} as const;
type ManualAlert = {
  severity: keyof typeof MANUAL_TITLES;
  custom: boolean; text: string; override: boolean;
  color: string; textColor: string; expires: number;
};
type Props = {
  windowKey: string; title: string; accentClass: string; src: string;
  rect: WindowRect; bounds: DesktopBounds; zIndex: number; active: boolean;
  onFocus: () => void; onClose: () => void; onRectCommit: (rect: WindowRect) => void;
  registerFrame: (frame: HTMLIFrameElement | null) => void;
  onOpen: (href: string, title: string) => void; onReturnToDesktop: () => void;
  visible: boolean; bulletinHost: HTMLElement | null;
  canEditManualAlert?: boolean; wallpaperHost?: HTMLElement | null;
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
function parseManualAlert(input: unknown): ManualAlert | null {
  const value = object(input);
  if (!value || typeof value.severity !== "string" || !Object.hasOwn(MANUAL_TITLES, value.severity)) return null;
  const severity = value.severity as ManualAlert["severity"];
  const color = string(value.color, 8), textColor = string(value.textColor, 8);
  const hex = /^#[0-9a-f]{6}$/i;
  const text = string(value.text, 2000).trim();
  const custom = value.custom === true, override = value.override === true && severity !== "notice";
  const expires = finite(value.expires);
  if (expires === null || !Number.isFinite(new Date(expires).getTime()) || expires <= Date.now()
    || !hex.test(color) || !hex.test(textColor) || custom && !text) return null;
  return { severity, custom, text, override, color, textColor, expires };
}

/** Used only for the preview Weather route; every other desktop window keeps
 * its existing frame, titlebar, notification behavior, and permissions. */
export default function WeatherPreviewWindow(props: Props) {
  const { t } = useUiLanguage();
  const timeFormat = useTimeFormat();
  const [initialTimeFormat] = useState(timeFormat);
  const frameSrc = useMemo(() => {
    const url = new URL(props.src, "https://cmpri.invalid");
    url.searchParams.set("timeFormat", initialTimeFormat);
    return url.pathname + url.search + url.hash;
  }, [props.src, initialTimeFormat]);
  const central = useMemo(() => new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric",
    hour: timeFormat === "24h" ? "2-digit" : "numeric", minute: "2-digit", ...timeFormatOptions(timeFormat), timeZoneName: "short",
  }), [timeFormat]);
  const stamp = (value: number | null) => value === null ? t("Unavailable") : central.format(new Date(value));
  const [safety, setSafety] = useState<SafetyState>(EMPTY);
  const [manualPreview, setManualPreview] = useState<ManualAlert | null>(null);
  const [manualPublished, setManualPublished] = useState<ManualAlert | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [soundStatus, setSoundStatus] = useState<"idle" | "blocked" | "unavailable">("idle");
  const soundKey = useRef<string | null>(null);
  const blockedSounds = useRef(new Map<string, string>());
  const sampleEpoch = useRef(0);
  const snapshot = useRef<SafetyState>(EMPTY);
  const selected = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const wallpaperFrame = useRef<HTMLIFrameElement | null>(null);
  const manualAccess = useRef(props.canEditManualAlert === true);
  const returnToDesktop = useRef(props.onReturnToDesktop);
  const frameCleanup = useRef<(() => void) | null>(null);
  const registerRef = useRef(props.registerFrame);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(props.visible);
  const timeFormatRef = useRef(timeFormat);
  const token = new URL(props.src, "https://cmpri.invalid").searchParams.get("modalToken");
  useEffect(() => { registerRef.current = props.registerFrame; }, [props.registerFrame]);
  useEffect(() => { returnToDesktop.current = props.onReturnToDesktop; }, [props.onReturnToDesktop]);

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
        frame.contentWindow?.postMessage({ type: "cmpri-time-format-updated", timeFormat: timeFormatRef.current }, window.location.origin);
        frame.contentWindow?.postMessage({ type: "cmpri-weather-view-state", visible: visibleRef.current, modalToken: token }, window.location.origin);
        frame.contentWindow?.postMessage({ type: "cmpri-weather-safety-request-state", modalToken: token }, window.location.origin);
        frame.contentWindow?.postMessage({ type: "cmpri-weather-manual-alert-access", allowed: manualAccess.current, modalToken: token }, window.location.origin);
      };
      frame.addEventListener("load", request);
      frameCleanup.current = () => frame.removeEventListener("load", request);
    }
  }, [token]);

  useEffect(() => {
    timeFormatRef.current = timeFormat;
    send("cmpri-time-format-updated", { timeFormat });
    wallpaperFrame.current?.contentWindow?.postMessage({ type: "cmpri-time-format-updated", timeFormat }, window.location.origin);
  }, [timeFormat, send]);

  useEffect(() => {
    manualAccess.current = props.canEditManualAlert === true;
    send("cmpri-weather-manual-alert-access", { allowed: manualAccess.current });
  }, [props.canEditManualAlert, send]);

  useEffect(() => {
    if (!manualPreview && !manualPublished) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setManualPreview(current => current && current.expires <= now ? null : current);
      setManualPublished(current => current && current.expires <= now ? null : current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [manualPreview, manualPublished]);

  useEffect(() => {
    visibleRef.current = props.visible;
    send("cmpri-weather-view-state", { visible: props.visible });
  }, [props.visible, send]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = object(event.data), frame = frameRef.current;
      if (!data || !frame || !token || event.origin !== window.location.origin || event.source !== frame.contentWindow || data.modalToken !== token) return;
      if (data.type === "cmpri-weather-manual-alert-request-access") {
        send("cmpri-weather-manual-alert-access", { allowed: manualAccess.current });
      } else if (data.type === "cmpri-weather-manual-alert-submit") {
        if (!manualAccess.current || !visibleRef.current || (data.mode !== "preview" && data.mode !== "publish")) return;
        const alert = parseManualAlert(data.payload);
        if (!alert) return;
        if (data.mode === "preview") setManualPreview(alert);
        else {
          setManualPublished(alert.custom || alert.override ? alert : null);
          setManualPreview(null);
        }
        returnToDesktop.current();
      } else if (data.type === "cmpri-weather-safety-state") {
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
  const tickerLabel = (item: SafetyRecord) => (item.simulated ? t("SIMULATION") + " · " : item.stale ? t("LAST VERIFIED") + " · " : "") + t("{event} · expires {time}", { event: t(item.event), time: stamp(item.expires) });
  const tickerText = tickerAlerts.map(tickerLabel).join("     •     ");
  const ticker = tickerAlerts.length ? <button type="button" data-weather-alert-ticker data-level={tickerLevel} className={styles.ticker} aria-label={t("Open Guest Safety details: {details}", { details: tickerText })} onClick={() => openDetails((tickerAlerts.find(item => level(item) === "warning") || tickerAlerts[0]).key)}>
    <span className={styles.tickerTrack} style={{ animationDuration: Math.max(16, tickerText.length * .075) + "s" }}>
      {tickerAlerts.map(item => <span key={item.key} data-level={level(item)} className={styles.tickerItem}>{tickerLabel(item)}</span>)}
    </span>
  </button> : undefined;

  const manual = props.canEditManualAlert ? manualPreview ?? manualPublished : null;
  const manualScope = manualPreview ? "preview" : "publish";
  const manualText = manual?.custom ? manual.text : "";
  const manualTickerVisible = Boolean(manualText);
  useEffect(() => {
    const host = props.bulletinHost;
    const header = host?.parentElement?.querySelector<HTMLElement>(":scope > header.cmpri-dashboard-titlebar");
    if (!manualTickerVisible || !host || !header) return;
    const property = "--cmpri-active-weather-ticker-depth";
    const priorDepth = header.style.getPropertyValue(property);
    const menu = header.querySelector(".cmpri-header-v23.anchored-menu");
    const measure = () => {
      const depth = Math.ceil(host.getBoundingClientRect().height) + "px";
      if (header.style.getPropertyValue(property) === depth) return;
      header.style.setProperty(property, depth);
      menu?.dispatchEvent(new Event("cmpri-menu-placement"));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    return () => {
      observer.disconnect();
      if (priorDepth) header.style.setProperty(property, priorDepth);
      else header.style.removeProperty(property);
      menu?.dispatchEvent(new Event("cmpri-menu-placement"));
    };
  }, [manualTickerVisible, props.bulletinHost]);
  const wallpaperVisible = Boolean(manual?.override && props.wallpaperHost);
  useEffect(() => {
    if (!wallpaperVisible) return;
    const notify = () => window.dispatchEvent(new Event("cmpri-weather-wallpaper-change"));
    notify();
    return () => { notify(); };
  }, [wallpaperVisible]);

  return <>
    {props.bulletinHost && (ticker || manualText) ? createPortal(<>
      {ticker}
      {manual && manualText ? <section data-weather-alert-ticker data-weather-manual-alert-ticker={manualScope} role="status"
        className={styles.manualBulletin} style={{ background: manual.color, color: manual.textColor }}>
        <header className={styles.manualTitle}>
          <strong>{t(MANUAL_TITLES[manual.severity])}</strong>
          <span>{t(manualPreview ? "Private preview" : "Simulated publish")}</span>
          <time dateTime={new Date(manual.expires).toISOString()}>{t("Until")} {stamp(manual.expires)}</time>
        </header>
        <div className={`${styles.ticker} ${styles.manualTicker}`}>
          <span className={styles.tickerTrack} style={{ animationDuration: Math.max(16, manualText.length * .075) + "s" }}>{manualText}</span>
        </div>
      </section> : null}
    </>, props.bulletinHost) : null}
    {props.wallpaperHost && wallpaperVisible ? createPortal(<iframe ref={wallpaperFrame}
      className={styles.radarWallpaper} data-cmpri-weather-wallpaper title={t("Live radar desktop wallpaper")} allowFullScreen
      src={`/previews/cmpri-weather-preview.html?radarOnly=wallpaper&timeFormat=${initialTimeFormat}`}
      onLoad={() => wallpaperFrame.current?.contentWindow?.postMessage({
        type: "cmpri-time-format-updated", timeFormat: timeFormatRef.current,
      }, window.location.origin)} />, props.wallpaperHost) : null}
    <div hidden={!props.visible} data-weather-cached-window data-weather-visible={props.visible ? "true" : "false"} style={{ display: props.visible ? "contents" : "none" }}>
    <DesktopWindow windowKey={props.windowKey} title={t(props.title)} accentClass={props.accentClass} rect={props.rect} bounds={props.bounds} zIndex={props.zIndex} active={props.active} onFocus={props.onFocus} onClose={props.onClose} onRectCommit={props.onRectCommit}>
      <DesktopFrame src={frameSrc} title={t(props.title)} registerFrame={attachFrame} onFocus={props.onFocus} onOpen={props.onOpen} onReturnToDesktop={props.onReturnToDesktop} />
    </DesktopWindow>
    </div>
    {typeof document !== "undefined" ? createPortal(<dialog ref={dialogRef} data-weather-guest-safety-dialog data-level={currentRecord && record ? level(record) : "history"} data-fullscreen={fullScreen ? "true" : "false"} className={styles.dialog} aria-labelledby="weather-guest-safety-title" aria-describedby="weather-guest-safety-summary" onCancel={event => { event.preventDefault(); closeDetails(); }} onClose={() => { if (selected.current) closeDetails(); }}>
      <header className={styles.dialogHeader}><div><span className={styles.label} data-level={currentRecord && record ? level(record) : "history"}>{!currentRecord && record ? t("PAST NOTIFICATION") + " · " : ""}{record?.simulated ? t("SIMULATED GUEST SAFETY") : t("OFFICIAL NWS · GUEST SAFETY")}</span><h1 id="weather-guest-safety-title">{t("Guest Safety")}</h1></div><button type="button" data-weather-guest-safety-close className={styles.close} aria-label={t("Close Guest Safety")} onClick={closeDetails}>×</button></header>
      {record ? <main className={styles.dialogContent}>
        <p className={styles.context}>{!currentRecord ? t("Past notification · {status}. This is not the current alert state.", { status: t(record.status) }) + " " : ""}{record.simulated ? t("Simulation only · this message does not establish a current NWS warning or observed walkway condition.") : t("Official NWS alert applying to Residence Inn Champaign.")}{record.stale ? " " + t("The last alert check is stale or unavailable; current status is unverified.") : ""}</p>
        {soundStatus === "blocked" && currentRecord && level(record) === "warning" ? <p className={styles.soundStatus} data-weather-warning-sound="blocked">{t("Your browser paused warning sound.")} <button type="button" onClick={() => { const key = soundKey.current; if (key) void armWeatherWarningSound().then(() => { if (soundKey.current === key) playWarning(key); }); }}>{t("Enable warning sound")}</button></p> : soundStatus === "unavailable" && currentRecord ? <p className={styles.soundStatus} data-weather-warning-sound="unavailable">{t("Warning sound unavailable.")}</p> : null}
        <h2>{t(record.event)}</h2><p id="weather-guest-safety-summary" data-weather-official-summary className={styles.summary} translate="no">{record.summary}</p>
        <section className={styles.action}><h3>{t("Hotel action")}</h3><p data-weather-hotel-instruction>{t(record.hotelInstruction)}</p></section>
        <dl className={styles.times}><div><dt>{t("Effective / expected · Central")}</dt><dd>{stamp(record.effective)}</dd></div><div><dt>{t("Expires · Central")}</dt><dd>{stamp(record.expires)}</dd></div><div><dt>{t("Status")}</dt><dd>{t(record.status)}{record.stale ? " · " + t("unverified") : ""}</dd></div></dl>
        {record.description || record.officialInstruction ? <details className={styles.bulletin}><summary>{t("Official NWS bulletin text")}{record.simulated ? " · " + t("sample") : ""}</summary>{record.description ? <p translate="no">{record.description}</p> : null}{record.officialInstruction ? <p translate="no">{record.officialInstruction}</p> : null}</details> : null}
        {record.bulletinUrl ? <a href={record.bulletinUrl} target="_blank" rel="noopener noreferrer">{t("Read official NWS bulletin ↗")}</a> : <p className={styles.context}>{record.simulated ? t("Simulation · no official bulletin was issued by this example.") : t("Official bulletin link unavailable.")}</p>}
        <nav className={styles.otherAlerts} aria-label={t("Other active Guest Safety notifications")}>{safety.alerts.filter(item => item.key !== record.key).map(item => <button key={item.key} type="button" onClick={() => openDetails(item.key)}>{item.simulated ? t("Simulation") + " · " : ""}{t(item.event)}</button>)}</nav>
        <button type="button" className={styles.done} onClick={closeDetails}>{t("Close details")}</button>
      </main> : null}
    </dialog>, document.body) : null}
  </>;
}
