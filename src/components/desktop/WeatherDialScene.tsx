"use client";

import { useEffect, useRef } from "react";
import type { DashboardWeather } from "@/lib/weather/dashboard-weather";
import { mountDialScene } from "@/lib/weather/dial-scene-renderer";

const LATITUDE = 40.138080;
const LONGITUDE = -88.251416;
const DAY = 86_400_000;
const MINUTE = 60_000;
const SNOW_REFRESH = 10 * MINUTE;
const SNOW_MODEL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=snow_depth,temperature_2m&hourly=snowfall&past_hours=36&forecast_hours=1&timeformat=unixtime`;
const CENTRAL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
});

type Astronomy = typeof import("astronomy-engine");
type Scene = ReturnType<Parameters<typeof mountDialScene>[1]>;
type SnowModel = { time: number; depth: number | null; lastSnow: number; temperature: number | null };

function centralParts(time: number) {
  return Object.fromEntries(CENTRAL.formatToParts(time).map(({ type, value }) => [type, Number(value)]));
}

function centralMidnight(wallTime: number) {
  let time = wallTime;
  // Resolve midnight's own offset on the days when daylight saving time changes.
  for (let i = 0; i < 3; i++) {
    const { year, month, day, hour, minute, second } = centralParts(time);
    const difference = wallTime - Date.UTC(year, month - 1, day, hour, minute, second);
    time += difference;
    if (!difference) break;
  }
  return time;
}

function localDay(time: number, astronomy: Astronomy | null) {
  const { year, month, day } = centralParts(time);
  const wallTime = Date.UTC(year, month - 1, day);
  const dayOfYear = (wallTime - Date.UTC(year, 0, 1)) / DAY;
  const grow = Math.min(1, Math.max(0, (dayOfYear - 83) / 60));
  const shed = Math.min(1, Math.max(0, (311 - dayOfYear) / 43));
  const start = centralMidnight(wallTime);
  const end = centralMidnight(wallTime + DAY);
  const observer = astronomy && new astronomy.Observer(LATITUDE, LONGITUDE, 0);
  const crossing = (direction: number) => astronomy && observer
    ? astronomy.SearchRiseSet(astronomy.Body.Sun, observer, direction, new Date(start), (end - start) / DAY)?.date.getTime() ?? null
    : null;
  return {
    start, end, observer, sunrise: crossing(1), sunset: crossing(-1), leafCover: Math.min(grow, shed),
    season: month >= 12 || month < 3 ? "winter" : month < 6 ? "spring" : month < 9 ? "summer" : "autumn",
  };
}

function classify(data: DashboardWeather | null) {
  const label = [data?.condition, data?.icon].filter(Boolean).join(" ").toLowerCase().replaceAll("_", " ");
  const thunder = /thunder|tstm|\btsra\b/.test(label);
  const snow = /snow|flurr|blizzard|sleet|ice pellets|wintry mix/.test(label);
  const rain = /rain|drizzle|\bfzra\b/.test(label) || (!snow && /showers/.test(label)) || (thunder && !snow);
  const fog = /fog|mist|haze/.test(label);
  const strongWind = (data?.wind ?? 0) >= 35 || /windy|strong wind|dust storm/.test(label);
  const cloudCover = thunder || snow || rain ? 1 : fog || /overcast|\bovc\b/.test(label) ? .92
    : /mostly cloudy|\bbkn\b/.test(label) ? .78 : /partly cloudy|partly sunny|\bsct\b/.test(label) ? .45
      : /mostly sunny|mostly clear|few clouds|\bfew\b/.test(label) ? .18 : /cloudy/.test(label) ? .88
        : /clear|sunny|fair|\bskc\b/.test(label) ? .06 : null;
  return { thunder, snow, rain, fog, strongWind, cloudCover };
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readSnowModel(signal: AbortSignal): Promise<SnowModel | null> {
  const response = await fetch(SNOW_MODEL, { signal, cache: "no-store" });
  if (!response.ok) return null;
  const { current, hourly } = (await response.json()) as {
    current?: { time?: unknown; snow_depth?: unknown; temperature_2m?: unknown };
    hourly?: { time?: unknown[]; snowfall?: unknown[] };
  };
  const observed = number(current?.time);
  if (observed === null) return null;
  const time = observed * 1000;
  const temperature = number(current?.temperature_2m);
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const snowfall = Array.isArray(hourly?.snowfall) ? hourly.snowfall : [];
  const lastSnow = times.reduce<number>((latest, rawTime, i) => {
    const at = number(rawTime);
    return at !== null && at <= observed && (number(snowfall[i]) ?? 0) >= .1
      ? Math.max(latest, at * 1000) : latest;
  }, -Infinity);
  return { time, depth: number(current?.snow_depth), lastSnow, temperature: temperature === null ? null : temperature * 1.8 + 32 };
}

export default function WeatherDialScene({ data }: { data: DashboardWeather | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentData = useRef<DashboardWeather | null>(null);
  const refreshScene = useRef<(() => void) | null>(null);

  useEffect(() => {
    currentData.current = data;
    refreshScene.current?.();
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let astronomy: Astronomy | null = null;
    let day: ReturnType<typeof localDay> | null = null;
    let minute = -1;
    let sunAltitude: number | null = null;
    let moonAltitude = -10;
    let model: SnowModel | null = null;
    let lastObservedSnow = -Infinity;
    let lastModelRead = -Infinity;
    let request: AbortController | null = null;
    let disposed = false;
    let animation: ReturnType<typeof mountDialScene> | null = null;
    let weather: ReturnType<typeof classify> | null = null;
    let weatherData: DashboardWeather | null = null;

    function readScene(): Scene {
      const now = Date.now();
      const data = currentData.current;
      if (!weather || weatherData !== data) {
        weatherData = data;
        weather = classify(data);
        if (weather.snow) {
          const stamp = Date.parse(data?.observationTime ?? "");
          if (Number.isFinite(stamp) && stamp <= now) lastObservedSnow = Math.max(lastObservedSnow, stamp);
        }
      }
      if (!day || now < day.start || now >= day.end) day = localDay(now, astronomy);
      const currentMinute = Math.floor(now / MINUTE);
      if (astronomy && day.observer && currentMinute !== minute) {
        const date = new Date(now);
        const observer = day.observer;
        const engine = astronomy;
        const altitude = (body: Astronomy["Body"]["Sun" | "Moon"]) => {
          const equator = engine.Equator(body, date, observer, true, true);
          return engine.Horizon(date, observer, equator.ra, equator.dec).altitude;
        };
        sunAltitude = altitude(engine.Body.Sun);
        moonAltitude = altitude(engine.Body.Moon);
        minute = currentMinute;
      }
      const isDay = day.sunrise !== null && day.sunset !== null
        ? now >= day.sunrise && now < day.sunset : data?.isDaytime ?? true;
      const recentModel = model && now - model.time <= 60 * MINUTE && model.time <= now + 15 * MINUTE ? model : null;
      const freezing = (data?.current ?? recentModel?.temperature ?? 32) <= 34;
      const age = now - Math.max(lastObservedSnow, recentModel?.lastSnow ?? -Infinity);
      const freshSnow = weather.snow || (age >= 0 && age < (freezing ? 6 * 60 : 30) * MINUTE);
      const snowCover = (recentModel?.depth ?? 0) >= .005 || (freezing && freshSnow);
      return { ...weather, time: now, isDay, season: day.season, leafCover: day.leafCover,
        sunAltitude: sunAltitude ?? (isDay ? 22 : -16), moonAltitude,
        moonPhase: data?.moonAngle == null ? null : data.moonAngle / 360,
        snowCover, treeSnow: freshSnow && snowCover,
      };
    }

    const start = (engine: Astronomy | null) => {
      if (disposed) return;
      astronomy = engine;
      animation = mountDialScene(canvas, readScene);
      refreshScene.current = animation.wake;
    };
    void import("astronomy-engine").then(start, () => start(null));

    function refresh() {
      if (document.hidden) {
        if (request) {
          request.abort();
          request = null;
          lastModelRead = -Infinity;
        }
        return;
      }
      animation?.wake();
      if (Date.now() - lastModelRead < SNOW_REFRESH) return;
      lastModelRead = Date.now();
      const controller = new AbortController();
      request = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      void readSnowModel(signal).then(result => {
        if (!signal.aborted && result) {
          model = result;
          animation?.wake();
        }
      }).catch(() => {}).finally(() => { if (request === controller) request = null; });
    }

    refresh();
    const timer = window.setInterval(refresh, MINUTE);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      refreshScene.current = null;
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      animation?.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} width={225} height={225} aria-hidden="true" data-cmpri-weather-scene=""
    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}
