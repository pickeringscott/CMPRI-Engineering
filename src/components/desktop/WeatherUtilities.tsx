"use client";

import Script from "next/script";
import { useEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type { DashboardWeather } from "@/lib/weather/dashboard-weather";
import styles from "./weather-utilities.module.css";

type WeatherVisuals = {
  colorAt: (fahrenheit: number) => string;
  stops: ReadonlyArray<{ fahrenheit: number; color: string }>;
  condition: (description: string | null, options: { icon: string | null; isDaytime: boolean | null }) => SVGElement;
};

const DESKTOP = "(min-width: 701px)";
const REFRESH_INTERVAL = 10 * 60 * 1000;
const CENTER_X = 51.6, CENTER_Y = 49, RADIUS = 42.5;
const ARC_START = 210, ARC_SPAN = 300, HIGH_ANGLE = 321, LOW_ANGLE = 498;
const UNKNOWN_COLOR = "#373a40";

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

function moonLight(angle: number | null) {
  if (angle === null) return null;
  const radius = 4.2;
  const side = angle > 180 ? 0 : 1;
  const narrow = angle < 90 || angle > 270;
  const terminator = Math.abs(radius * Math.cos(angle * Math.PI / 180));
  return `M0 ${-radius}A${radius} ${radius} 0 0 ${side} 0 ${radius}A${terminator} ${radius} 0 0 ${narrow ? 1 - side : side} 0 ${-radius}Z`;
}

function WeatherDial({ data, onOpen }: { data: DashboardWeather | null; onOpen: MouseEventHandler<HTMLButtonElement> }) {
  const { t } = useUiLanguage();
  const [visuals, setVisuals] = useState<WeatherVisuals | null>(null);
  const conditionHost = useRef<HTMLSpanElement>(null);
  const condition = data?.condition ?? null;
  const icon = data?.icon ?? null;
  const isDaytime = data?.isDaytime ?? null;

  useEffect(() => {
    const drawing = visuals?.condition(condition, { icon, isDaytime });
    const cloud = drawing?.querySelector<SVGPathElement>(".wv-cloud:only-of-type");
    if (drawing?.dataset.condition === "cloud" && drawing.childElementCount === 2 && cloud) {
      cloud.setAttribute("d", "M22 35h-4a8 8 0 1 1 6-14m-5-3a14 14 0 0 1 27-2m-5 9a8 8 0 0 0-10 5m0 0a5 5 0 1 0-2 5h20a6 6 0 1 0-5-9");
    }
    conditionHost.current?.replaceChildren(...(drawing ? [drawing] : []));
  }, [condition, icon, isDaytime, visuals]);

  const high = data?.high ?? null, low = data?.low ?? null, current = data?.current ?? null;
  const range = high !== null && low !== null && high > low && current !== null
    ? Math.min(1, Math.max(0, (high - current) / (high - low))) : 0.5;
  const beadAngle = HIGH_ANGLE + range * (LOW_ANGLE - HIGH_ANGLE);
  const nearestMarker = Math.min(beadAngle - HIGH_ANGLE, LOW_ANGLE - beadAngle);
  const bead = onArc(beadAngle, nearestMarker < 13 ? RADIUS - 10 : RADIUS);
  const arc = dialArc(visuals, high, low);
  const endpoints = [onArc(ARC_START), onArc(ARC_START + ARC_SPAN)];
  const markers = [
    { label: "H", position: onArc(HIGH_ANGLE), color: arc.highColor },
    { label: "L", position: onArc(LOW_ANGLE), color: arc.lowColor },
  ];
  const moon = moonLight(data?.moonAngle ?? null);
  const temperature = (value: number | null) => value === null ? "—" : `${Math.round(value)}°`;
  const precipitation = data?.precipitation == null ? "—" : `${Math.round(data.precipitation)}%`;
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
        <span className={styles.ring} style={{ background: arc.background }} aria-hidden="true" />
        <svg className={styles.artboard} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <circle cx={endpoints[0].x} cy={endpoints[0].y} r="3.5" fill={arc.startColor} />
          <circle cx={endpoints[1].x} cy={endpoints[1].y} r="3.5" fill={arc.lowColor} />
          {markers.map(({ label, position, color }) => <g key={label}>
            <circle cx={position.x} cy={position.y} r="4.2" fill={color} className={styles.markerOutline} />
            <text x={position.x} y={position.y + 2.2} fill={temperatureInk(color)} className={styles.marker}>{label}</text>
          </g>)}
          {current !== null && high !== null && low !== null ? <circle cx={bead.x} cy={bead.y} r="3.5" className={styles.currentBead} /> : null}
          <text x={CENTER_X} y="35" className={styles.temperature}>{temperature(current)}</text>
          <path d="M34 39H69" className={styles.rule} />
          <text x={CENTER_X} y="46.7" className={styles.now}>{t("Now", "Ahora")}</text>
          <g className={styles.drops}>
            <path d="M18.2 53.9c1.5 2 2.6 3.5 2.6 5a2.6 2.6 0 0 1-5.2 0c0-1.5 1.1-3 2.6-5Z" />
            <path d="M23.9 51.9c.95 1.2 1.55 2.2 1.55 3.1a1.55 1.55 0 0 1-3.1 0c0-.9.6-1.9 1.55-3.1Z" />
            <path d="M23.9 57.9c.95 1.2 1.55 2.2 1.55 3.1a1.55 1.55 0 0 1-3.1 0c0-.9.6-1.9 1.55-3.1Z" />
          </g>
          <text x="27" y="61.1" className={styles.precipitation} textLength={precipitation.length > 3 ? 15 : undefined} lengthAdjust="spacingAndGlyphs">{precipitation}</text>
          <text x="75.1" y="55.8" className={styles.wind}>{wind}<tspan className={styles.windUnit}> mph</tspan></text>
          <circle cx="75.1" cy="62.4" r="4.2" className={styles.windCircle} />
          {data?.wind === 0 ? <circle cx="75.1" cy="62.4" r="1" className={styles.calm} /> : data?.bearing != null && data?.wind != null ? (
            <path d="M75.1 60v4.8m-1.5-1.6 1.5 1.6 1.5-1.6" transform={`rotate(${data.bearing} 75.1 62.4)`} className={styles.windArrow} />
          ) : null}
          <rect x="34" y="67.6" width="17.2" height="8.2" rx="4.1" fill={arc.lowColor} />
          <rect x="52.2" y="67.6" width="17.2" height="8.2" rx="4.1" fill={arc.highColor} />
          <text x="42.6" y="74.1" textLength={temperature(low).length > 3 ? 15 : undefined} lengthAdjust="spacingAndGlyphs" fill={temperatureInk(arc.lowColor)} className={styles.extreme}>{temperature(low)}</text>
          <text x="60.8" y="74.1" textLength={temperature(high).length > 3 ? 15 : undefined} lengthAdjust="spacingAndGlyphs" fill={temperatureInk(arc.highColor)} className={styles.extreme}>{temperature(high)}</text>
          {moon ? <g transform={`translate(${CENTER_X} 89.7)`}>
            <path d={moon} className={styles.moonLight} />
          </g> : null}
        </svg>
        <span className={styles.condition} ref={conditionHost} aria-hidden="true" />
      </button>
    </>
  );
}

function WeatherTile({ onOpen }: { onOpen: MouseEventHandler<HTMLButtonElement> }) {
  const [desktop, setDesktop] = useState(false);
  const [data, setData] = useState<DashboardWeather | null>(null);

  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!desktop) return;
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
  }, [desktop]);

  return desktop ? <WeatherDial data={data} onOpen={onOpen} /> : null;
}

export default function WeatherUtilities({ children, onOpen }: { children: ReactNode; onOpen?: MouseEventHandler<HTMLButtonElement> }) {
  return <div className={styles.utilities}>
    {onOpen ? <WeatherTile onOpen={onOpen} /> : null}
    {children}
  </div>;
}
