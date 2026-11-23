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

const DESKTOP = "(min-width: 64rem)";
const REFRESH_INTERVAL = 10 * 60 * 1000;
const CENTER_X = 51.6, CENTER_Y = 49, RADIUS = 42.5;
const ARC_START = 210, ARC_SPAN = 300, HIGH_ANGLE = 321, LOW_ANGLE = 498;
const UNKNOWN_COLOR = "#373a40";

function onArc(angle: number) {
  const radians = angle * Math.PI / 180;
  return { x: CENTER_X + RADIUS * Math.sin(radians), y: CENTER_Y - RADIUS * Math.cos(radians) };
}

function dialArc(visuals: WeatherVisuals | null, high: number | null, low: number | null) {
  const highColor = visuals && high !== null ? visuals.colorAt(high) : UNKNOWN_COLOR;
  const lowColor = visuals && low !== null ? visuals.colorAt(low) : UNKNOWN_COLOR;
  const temperatureStops = visuals && high !== null && low !== null && high > low
    ? visuals.stops.filter(stop => stop.fahrenheit > low && stop.fahrenheit < high).slice().reverse().map(stop => {
      const ratio = (high - stop.fahrenheit) / (high - low);
      return `${stop.color} ${HIGH_ANGLE - ARC_START + ratio * (LOW_ANGLE - HIGH_ANGLE)}deg`;
    }) : [];
  const stops = [
    `${highColor} ${HIGH_ANGLE - ARC_START}deg`, ...temperatureStops,
    `${lowColor} ${LOW_ANGLE - ARC_START}deg ${ARC_SPAN}deg`, `transparent ${ARC_SPAN}deg`,
  ];
  return { background: `conic-gradient(from ${ARC_START}deg, ${stops.join(", ")})`, highColor, lowColor };
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
    conditionHost.current?.replaceChildren(...(visuals ? [visuals.condition(condition, { icon, isDaytime })] : []));
  }, [condition, icon, isDaytime, visuals]);

  const high = data?.high ?? null, low = data?.low ?? null, current = data?.current ?? null;
  const range = high !== null && low !== null && high > low && current !== null
    ? Math.min(1, Math.max(0, (high - current) / (high - low))) : 0.5;
  const bead = onArc(HIGH_ANGLE + range * (LOW_ANGLE - HIGH_ANGLE));
  const arc = dialArc(visuals, high, low);
  const endpoints = [onArc(ARC_START), onArc(ARC_START + ARC_SPAN)];
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
          <circle cx={endpoints[0].x} cy={endpoints[0].y} r="3.5" fill={arc.highColor} />
          <circle cx={endpoints[1].x} cy={endpoints[1].y} r="3.5" fill={arc.lowColor} />
          {current !== null && high !== null && low !== null ? <circle cx={bead.x} cy={bead.y} r="3.4" fill="white" /> : null}
          <text x="25" y="17.5" className={styles.marker}>H</text>
          <text x="79.5" y="81.5" className={styles.marker}>L</text>
          <text x={CENTER_X} y="35" className={styles.temperature}>{temperature(current)}</text>
          <path d="M34 39H69" className={styles.rule} />
          <text x={CENTER_X} y="46.7" className={styles.now}>{t("Now", "Ahora")}</text>
          <path d="M26 51q0 0 2.4 3.2a2.5 2.5 0 1 1-4.8 0Q26 51 26 51Zm5.8 2.7q0 0 1.7 2.2a1.8 1.8 0 1 1-3.4 0q1.7-2.2 1.7-2.2Z" className={styles.drops} />
          <text x="29" y="65" className={styles.precipitation}>{precipitation}</text>
          <text x="74" y="55.4" className={styles.wind}>{wind}</text>
          <text x="74" y="59.4" className={styles.windUnit}>mph</text>
          <circle cx="74.5" cy="64.5" r="4" className={styles.windCircle} />
          {data?.wind === 0 ? <circle cx="74.5" cy="64.5" r="1" className={styles.calm} /> : data?.bearing != null && data?.wind != null ? (
            <path d="M74.5 62v5m-1.5-1.6 1.5 1.6 1.5-1.6" transform={`rotate(${data.bearing} 74.5 64.5)`} className={styles.windArrow} />
          ) : null}
          <rect x="30" y="69.5" width="20" height="9.4" rx="4.7" className={styles.lozenge} />
          <rect x="53" y="69.5" width="20" height="9.4" rx="4.7" className={styles.lozenge} />
          <text x="40" y="76.3" className={styles.extreme}>{temperature(low)}</text>
          <text x="63" y="76.3" className={styles.extreme}>{temperature(high)}</text>
          {moon ? <g transform={`translate(${CENTER_X} 89.7)`}>
            <circle r="4.2" className={styles.moon} />
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
