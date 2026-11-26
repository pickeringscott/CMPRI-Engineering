"use client";

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import styles from "./weather-widget-radar.module.css";

const TRAVEL_MS = 280;
const RADAR_SRC = "/previews/cmpri-weather-preview.html?radarOnly=widget";
const motionStyle = { "--radar-travel": `${TRAVEL_MS}ms` } as CSSProperties;

export default function WeatherWidgetRadar({ children }: { children: ReactNode }) {
  const { t } = useUiLanguage();
  const radarId = useId();
  const [expanded, setExpanded] = useState(false);
  const [frameMounted, setFrameMounted] = useState(false);

  useEffect(() => {
    if (expanded || !frameMounted) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : TRAVEL_MS;
    const close = window.setTimeout(() => setFrameMounted(false), delay);
    return () => window.clearTimeout(close);
  }, [expanded, frameMounted]);

  useEffect(() => {
    const closeForWallpaper = () => {
      if (!document.querySelector("[data-cmpri-weather-wallpaper]")) return;
      setExpanded(false);
      setFrameMounted(false);
    };
    window.addEventListener("cmpri-weather-wallpaper-change", closeForWallpaper);
    return () => window.removeEventListener("cmpri-weather-wallpaper-change", closeForWallpaper);
  }, []);

  const label = expanded ? t("Collapse radar", "Contraer radar") : t("Expand radar", "Expandir radar");
  return (
    <div className={styles.dock} style={motionStyle} data-cmpri-weather-widget="" data-expanded={expanded}>
      <div className={styles.dial} inert={frameMounted}>{children}</div>
      <div id={radarId} className={styles.radar} inert={!expanded}>
        {frameMounted ? <iframe className={styles.frame} src={RADAR_SRC} title={t("Weather radar", "Radar meteorológico")} /> : null}
      </div>
      <button type="button" className={styles.toggle} data-cmpri-weather-radar-toggle="" aria-expanded={expanded} aria-controls={radarId}
        aria-label={label} title={label} onClick={() => {
          if (!expanded) setFrameMounted(true);
          setExpanded(!expanded);
        }}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d={expanded ? "M3 5.5 8 10.5l5-5" : "M3 10.5 8 5.5l5 5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
