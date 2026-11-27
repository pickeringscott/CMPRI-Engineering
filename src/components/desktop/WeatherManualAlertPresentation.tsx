"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTimeFormat } from "@/components/TimeFormatProvider";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { timeFormatOptions } from "@/lib/ui/time-format";
import type { WeatherManualAlert } from "@/lib/weather/manual-alert";
import styles from "./weather-preview-window.module.css";

type Props = {
  alert: WeatherManualAlert | null;
  scope: "preview" | "publish";
  bulletinHost: HTMLElement | null;
  wallpaperHost: HTMLElement | null;
  attentionAlert?: WeatherManualAlert | null;
};

function titleInk(background: string) {
  const [red, green, blue] = [1, 3, 5].map(index => {
    const channel = parseInt(background.slice(index, index + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * red + .7152 * green + .0722 * blue > .179 ? "#000000" : "#ffffff";
}

export default function WeatherManualAlertPresentation({ alert, scope, bulletinHost, wallpaperHost, attentionAlert }: Props) {
  const { t } = useUiLanguage();
  const timeFormat = useTimeFormat();
  const [initialTimeFormat] = useState(timeFormat);
  const frame = useRef<HTMLIFrameElement>(null);
  const headingId = useId();
  const stamp = useMemo(() => new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", timeZoneName: "short",
    hour: timeFormat === "24h" ? "2-digit" : "numeric", minute: "2-digit", second: "2-digit",
    ...timeFormatOptions(timeFormat),
  }), [timeFormat]);
  const showBanner = Boolean(alert?.custom && alert.text && bulletinHost);
  const headingHost = showBanner ? bulletinHost?.parentElement?.querySelector<HTMLElement>(
    ":scope > header.cmpri-dashboard-titlebar > nav > [data-weather-advisory-heading-host]",
  ) : null;
  const showWallpaper = Boolean(alert?.override && wallpaperHost);
  const attention = attentionAlert ?? (scope === "publish" ? alert : null);
  const notepadLevel = attention?.attention && (attention.severity === "watch" || attention.severity === "warning") ? attention.severity : null;

  useEffect(() => {
    if (!showWallpaper) return;
    const notify = () => window.dispatchEvent(new Event("cmpri-weather-wallpaper-change"));
    notify();
    return () => { notify(); };
  }, [showWallpaper]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: "cmpri-time-format-updated", timeFormat }, window.location.origin);
  }, [timeFormat]);

  useEffect(() => {
    if (!notepadLevel) return;
    const root = document.documentElement;
    root.classList.add(styles.notepadAttention);
    root.dataset.cmpriWeatherNotepad = notepadLevel;
    return () => {
      root.classList.remove(styles.notepadAttention);
      delete root.dataset.cmpriWeatherNotepad;
    };
  }, [notepadLevel]);

  const heading = alert && showBanner ? <header className={styles.manualTitle} style={{ color: titleInk(alert.color) }}>
    {headingHost ? <span aria-hidden="true" className={styles.manualTitleBackdrop} style={{ backgroundColor: alert.color }} /> : null}
    <strong id={headingId}>{t("Property Advisory")}</strong>
    <time dateTime={new Date(alert.expires).toISOString()}>{t("Until")} {stamp.format(alert.expires)}</time>
  </header> : null;

  return <>
    {headingHost && heading ? createPortal(heading, headingHost) : null}
    {alert && showBanner && bulletinHost ? createPortal(
      <section data-weather-alert-ticker data-weather-manual-alert-ticker={scope} role="status"
        aria-labelledby={headingId}
        className={styles.manualBulletin} style={{ background: alert.color, color: alert.textColor }}>
        {headingHost ? null : heading}
        <div className={`${styles.ticker} ${styles.manualTicker}`}>
          <span key={alert.text} className={styles.tickerTrack}
            style={{ animationDuration: Math.max(20, alert.text.length * .09) + "s" }}>{alert.text}</span>
        </div>
      </section>, bulletinHost) : null}
    {showWallpaper && wallpaperHost ? createPortal(
      <iframe ref={frame} className={styles.radarWallpaper} data-cmpri-weather-wallpaper
        title={t("Live radar desktop wallpaper")} allowFullScreen
        src={`/previews/cmpri-weather-preview.html?radarOnly=wallpaper&timeFormat=${initialTimeFormat}`}
        onLoad={() => frame.current?.contentWindow?.postMessage(
          { type: "cmpri-time-format-updated", timeFormat }, window.location.origin,
        )} />, wallpaperHost) : null}
  </>;
}
