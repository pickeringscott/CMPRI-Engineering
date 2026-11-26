"use client";

import Script from "next/script";
import { useEffect, useId, useState, useSyncExternalStore, type MouseEventHandler, type ReactNode } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type { DashboardWeather } from "@/lib/weather/dashboard-weather";
import WeatherDialScene from "./WeatherDialScene";
import WeatherWidgetRadar from "./WeatherWidgetRadar";
import styles from "./weather-utilities.module.css";

type WeatherVisuals = {
  colorAt: (fahrenheit: number) => string;
  stops: ReadonlyArray<{ fahrenheit: number; color: string }>;
};

const REFRESH_INTERVAL = 10 * 60 * 1000;
const DESKTOP_WEATHER = "(min-width: 701px)";
const CENTER_X = 51.6, CENTER_Y = 49, RADIUS = 42.5;
const ARC_START = 210, ARC_SPAN = 300, HIGH_ANGLE = 321, LOW_ANGLE = 498;
const UNKNOWN_COLOR = "#373a40";
// At the full 225px size, one typographic point is 4/3 CSS pixels.
// Dilating the alpha applies the outline to both text and lines as the dial scales.
const LIGHT_INK_OUTLINE = (96 / 72) / (225 / 100);
const CENTRAL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour: "numeric", minute: "numeric", hourCycle: "h23",
});

function currentTimeAngle() {
  const parts = CENTRAL_CLOCK.formatToParts(new Date());
  const minutes = Number(parts.find(part => part.type === "hour")?.value) * 60
    + Number(parts.find(part => part.type === "minute")?.value);
  return ARC_START + minutes / 1440 * ARC_SPAN;
}

function onArc(angle: number, radius = RADIUS) {
  const radians = angle * Math.PI / 180;
  return { x: CENTER_X + radius * Math.sin(radians), y: CENTER_Y - radius * Math.cos(radians) };
}

function dialArc(visuals: WeatherVisuals | null, high: number | null, low: number | null) {
  const startColor = visuals && high !== null ? visuals.colorAt(0) : UNKNOWN_COLOR;
  const highColor = visuals && high !== null ? visuals.colorAt(high) : UNKNOWN_COLOR;
  const lowColor = visuals && low !== null ? visuals.colorAt(low) : UNKNOWN_COLOR;
  const temperatureStops = visuals && high !== null && low !== null && high > low
    ? visuals.stops.filter(stop => stop.fahrenheit > low && stop.fahrenheit < high).slice().reverse().map(stop => {
      const ratio = (high - stop.fahrenheit) / (high - low);
      return `${stop.color} ${HIGH_ANGLE - ARC_START + ratio * (LOW_ANGLE - HIGH_ANGLE)}deg`;
    }) : [];
  const stops = [
    `${startColor} 0deg`, `${highColor} ${HIGH_ANGLE - ARC_START}deg`, ...temperatureStops,
    `${lowColor} ${LOW_ANGLE - ARC_START}deg ${ARC_SPAN}deg`, `transparent ${ARC_SPAN}deg`,
  ];
  return { background: `conic-gradient(from ${ARC_START}deg, ${stops.join(", ")})`, startColor, highColor, lowColor };
}

function temperatureInk(color: string) {
  const [red, green, blue] = [1, 3, 5].map(offset => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.179 ? "#000" : "#fff";
}

function WeatherDial({ data, onOpen }: { data: DashboardWeather | null; onOpen: MouseEventHandler<HTMLButtonElement> }) {
  const { t } = useUiLanguage();
  const [visuals, setVisuals] = useState<WeatherVisuals | null>(null);
  const [beadAngle, setBeadAngle] = useState(currentTimeAngle);
  const outlineId = `weather-outline-${useId().replaceAll(":", "")}`;
  const outline = `url(#${outlineId})`;
  const condition = data?.condition ?? null;
  useEffect(() => {
    const update = () => setBeadAngle(currentTimeAngle());
    const timer = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const high = data?.high ?? null, low = data?.low ?? null, current = data?.current ?? null;
  const bead = onArc(beadAngle);
  const arc = dialArc(visuals, high, low);
  const endpoints = [onArc(ARC_START), onArc(ARC_START + ARC_SPAN)];
  const markers = [
    { label: "H", position: onArc(HIGH_ANGLE), color: arc.highColor },
    { label: "L", position: onArc(LOW_ANGLE), color: arc.lowColor },
  ];
  const temperature = (value: number | null) => value === null ? "—" : `${Math.round(value)}°`;
  const precipitation = data?.precipitation == null ? "—" : `${Math.round(data.precipitation)}%`;
  const precipitationWidth = precipitation.length === 1 ? 5.5 : 4.6 + 3.5 * (precipitation.length - 1);
  const wind = data?.wind == null ? "—" : String(Math.round(data.wind));
  const details = [
    t("Open Weather", "Abrir clima"), current === null ? t("Observation unavailable", "Observación no disponible") : `${temperature(current)} · ${condition || t("Current conditions")}`,
    `${t("Forecast low")} ${temperature(low)} · ${t("Forecast high")} ${temperature(high)}`,
    `${t("Precipitation chance")} ${precipitation} · ${t("Wind")} ${wind} mph`,
  ].join("\n");

  return (
    <>
      <Script src="/previews/weather/weather-visuals.js" onReady={() => {
        setVisuals((window as Window & { cmpriWeatherVisuals?: WeatherVisuals }).cmpriWeatherVisuals ?? null);
      }} />
      <button type="button" className={styles.dial} data-cmpri-weather-dial="" data-cmpri-desktop-launch="/previews/cmpri-weather-preview.html"
        aria-label={details.replaceAll("\n", ". ")} aria-haspopup="dialog" title={details} onClick={onOpen}>
        <WeatherDialScene data={data} />
        <span className={styles.ring} style={{ background: arc.background }} aria-hidden="true" />
        <svg className={styles.artboard} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <defs>
            <filter id={outlineId} x="-8" y="-8" width="116" height="116" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feMorphology in="SourceAlpha" operator="dilate" radius={LIGHT_INK_OUTLINE} result="edge" />
              <feFlood floodColor="#101016" />
              <feComposite in2="edge" operator="in" />
              <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <circle cx={endpoints[0].x} cy={endpoints[0].y} r="3.5" fill={arc.startColor} />
          <circle cx={endpoints[1].x} cy={endpoints[1].y} r="3.5" fill={arc.lowColor} />
          {markers.map(({ label, position, color }) => <g key={label}>
            <circle cx={position.x} cy={position.y} r="4.2" fill={color} className={styles.markerOutline} />
            <text x={position.x} y={position.y + 2.2} fill={temperatureInk(color)} filter={temperatureInk(color) === "#fff" ? outline : undefined} className={styles.marker}>{label}</text>
          </g>)}
          <circle cx={bead.x} cy={bead.y} r="3.5" className={styles.currentBead} />
          <g filter={outline} data-cmpri-weather-light-ink="">
            <text x={CENTER_X} y="39.5" data-cmpri-current-temperature="" className={styles.temperature} textLength={temperature(current).length > 3 ? 33 : undefined} lengthAdjust="spacingAndGlyphs">{temperature(current)}</text>
            <g className={styles.secondary}>
              <g className={styles.drops} transform={`translate(${50 - precipitationWidth - 3.6} 57.8) scale(.43) translate(-20.5 -57.25)`} data-cmpri-precipitation-icon="">
                <path d="M18.2 53.9c1.5 2 2.6 3.5 2.6 5a2.6 2.6 0 0 1-5.2 0c0-1.5 1.1-3 2.6-5Z" />
                <path d="M23.9 51.9c.95 1.2 1.55 2.2 1.55 3.1a1.55 1.55 0 0 1-3.1 0c0-.9.6-1.9 1.55-3.1Z" />
                <path d="M23.9 57.9c.95 1.2 1.55 2.2 1.55 3.1a1.55 1.55 0 0 1-3.1 0c0-.9.6-1.9 1.55-3.1Z" />
              </g>
              <text x="50" y="57.8" className={styles.precipitation} data-cmpri-precipitation-value="" textLength={precipitationWidth} lengthAdjust="spacingAndGlyphs">{precipitation}</text>
              <text x="53.2" y="57.8" className={styles.wind} textLength={wind.length > 1 ? 14.6 : undefined} lengthAdjust="spacingAndGlyphs" data-cmpri-wind-value="">{wind}<tspan className={styles.windUnit}> MPH</tspan></text>
              <g transform="translate(71.6 57.8) scale(.78) translate(-75.1 -62.4)">
                <circle cx="75.1" cy="62.4" r="4.2" className={styles.windCircle} data-cmpri-wind-indicator="" />
                {data?.wind === 0 ? <circle cx="75.1" cy="62.4" r="1" className={styles.calm} /> : data?.bearing != null && data?.wind != null ? (
                  <path d="M75.1 60v4.8m-1.5-1.6 1.5 1.6 1.5-1.6" transform={`rotate(${data.bearing} 75.1 62.4)`} className={styles.windArrow} />
                ) : null}
              </g>
            </g>
          </g>
          <g className={styles.secondary}>
            <rect x="38" y="64" width="12" height="6" rx="3" fill={arc.lowColor} data-cmpri-low-temperature="" />
            <rect x="53.2" y="64" width="12" height="6" rx="3" fill={arc.highColor} data-cmpri-high-temperature="" />
            <text x="44" y="67" textLength={temperature(low).length > 3 ? 10.5 : undefined} lengthAdjust="spacingAndGlyphs" fill={temperatureInk(arc.lowColor)} filter={temperatureInk(arc.lowColor) === "#fff" ? outline : undefined} className={styles.extreme}>{temperature(low)}</text>
            <text x="59.2" y="67" textLength={temperature(high).length > 3 ? 10.5 : undefined} lengthAdjust="spacingAndGlyphs" fill={temperatureInk(arc.highColor)} filter={temperatureInk(arc.highColor) === "#fff" ? outline : undefined} className={styles.extreme}>{temperature(high)}</text>
          </g>
        </svg>
      </button>
    </>
  );
}

function WeatherTile({ onOpen }: { onOpen: MouseEventHandler<HTMLButtonElement> }) {
  const [data, setData] = useState<DashboardWeather | null>(null);

  useEffect(() => {
    let request: AbortController | null = null;
    let lastRead = 0;
    const refresh = () => {
      if (document.hidden) {
        request?.abort();
        lastRead = 0;
        return;
      }
      if (Date.now() - lastRead < REFRESH_INTERVAL) return;
      request?.abort();
      const read = new AbortController();
      request = read;
      lastRead = Date.now();
      fetch("/api/weather-preview?part=dashboard", { cache: "no-store", signal: read.signal })
        .then(async response => {
          if (!response.ok) throw new Error(`Weather request returned ${response.status}`);
          return (await response.json() as { dashboard?: DashboardWeather }).dashboard ?? null;
        })
        .then(weather => { if (!read.signal.aborted) setData(weather); })
        .catch(() => { if (!read.signal.aborted) setData(null); });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return <WeatherWidgetRadar><WeatherDial data={data} onOpen={onOpen} /></WeatherWidgetRadar>;
}

function subscribeToWeatherViewport(change: () => void) {
  const viewport = window.matchMedia(DESKTOP_WEATHER);
  viewport.addEventListener("change", change);
  return () => viewport.removeEventListener("change", change);
}

function readWeatherViewport() {
  return window.matchMedia(DESKTOP_WEATHER).matches;
}

export default function WeatherUtilities({ children, onOpen }: { children: ReactNode; onOpen?: MouseEventHandler<HTMLButtonElement> }) {
  const showWeather = useSyncExternalStore(subscribeToWeatherViewport, readWeatherViewport, () => false);
  return <div className={styles.utilities}>
    {onOpen && showWeather ? <WeatherTile onOpen={onOpen} /> : null}
    {children}
  </div>;
}
