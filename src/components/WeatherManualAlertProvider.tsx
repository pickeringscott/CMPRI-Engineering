"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import WeatherManualAlertPresentation from "@/components/desktop/WeatherManualAlertPresentation";
import { createClient, getValidSession } from "@/lib/supabase/client";
import { armWeatherWarningSound, playWeatherWarningSound } from "@/lib/weather-warning-sound";
import { parseWeatherManualAlert, type WeatherManualAlert } from "@/lib/weather/manual-alert";
import styles from "./weather-manual-alert-provider.module.css";

type BulletinSnapshot = { alert: WeatherManualAlert | null; revision: string; publicationId: string | null; nwsActive: boolean };
type BulletinHosts = { bulletinHost: HTMLElement | null; wallpaperHost: HTMLElement | null };
type ManualAlertContext = {
  enabled: boolean;
  alert: WeatherManualAlert | null;
  preview: WeatherManualAlert | null;
  showPreview: (alert: WeatherManualAlert) => void;
  clearPreview: () => void;
  publish: (alert: WeatherManualAlert) => Promise<void>;
  deleteAlert: () => Promise<void>;
  registerHosts: (hosts: BulletinHosts) => () => void;
};

const ALERT_ENDPOINT = "/api/weather-preview/manual-alert";
const EMPTY: BulletinSnapshot = { alert: null, revision: "", publicationId: null, nwsActive: false };
const EMPTY_HOSTS: BulletinHosts = { bulletinHost: null, wallpaperHost: null };
const unavailable = () => { throw new Error("Manual weather alerts are unavailable."); };
const ManualAlerts = createContext<ManualAlertContext>({
  enabled: false, alert: null, preview: null, showPreview: unavailable, clearPreview: () => {},
  publish: async () => unavailable(), deleteAlert: async () => unavailable(), registerHosts: () => () => {},
});

async function bulletinResponse(response: Response): Promise<BulletinSnapshot> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof value?.error === "string" ? value.error : "Shared weather alerts are unavailable.");
  }
  if (typeof value?.revision !== "string" || value.revision.length > 200) {
    throw new Error("The weather alert response could not be read.");
  }
  const publicationId = typeof value.publicationId === "string" && value.publicationId.length <= 100 ? value.publicationId : null;
  return { alert: parseWeatherManualAlert(value.alert), revision: value.revision, publicationId, nwsActive: value.nwsActive === true };
}

export function useWeatherManualAlert() {
  return useContext(ManualAlerts);
}

export function useWeatherManualAlertHosts(bulletinHost: HTMLElement | null, wallpaperHost: HTMLElement | null) {
  const { registerHosts } = useWeatherManualAlert();
  useEffect(() => {
    if (bulletinHost) return registerHosts({ bulletinHost, wallpaperHost });
  }, [bulletinHost, wallpaperHost, registerHosts]);
}

function PreviewManualAlerts({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [preview, setPreview] = useState<WeatherManualAlert | null>(null);
  const [hosts, setHosts] = useState(EMPTY_HOSTS);
  const [fallbackBulletin, setFallbackBulletin] = useState<HTMLDivElement | null>(null);
  const [fallbackWallpaper, setFallbackWallpaper] = useState<HTMLDivElement | null>(null);
  const ownerRef = useRef<string | null>(null);
  const revision = useRef("");
  const publication = useRef<string | null>(null);
  const previewRevision = useRef(0);
  const currentRead = useRef<AbortController | null>(null);
  const sound = useRef<{ id: string; owner: string } | null>(null);

  const playSound = useCallback(async () => {
    const pending = sound.current;
    if (!pending || pending.owner !== ownerRef.current) return;
    const storageKey = `cmpri:weather-alert-sound:${pending.owner}`;
    try {
      if (window.sessionStorage.getItem(storageKey) === pending.id) {
        if (sound.current === pending) sound.current = null;
        return;
      }
    } catch { /* The in-memory sound helper still deduplicates playback. */ }
    const result = await playWeatherWarningSound(`manual-weather:${pending.id}`);
    if (sound.current !== pending || !["played", "duplicate"].includes(result)) return;
    sound.current = null;
    try { window.sessionStorage.setItem(storageKey, pending.id); } catch { /* Playback still succeeded. */ }
  }, []);

  const update = useCallback((next: BulletinSnapshot, account: string, keepPreview = false) => {
    if (ownerRef.current !== account) return;
    if (next.alert && next.publicationId && next.publicationId !== publication.current) {
      sound.current = { id: next.publicationId, owner: account };
      void playSound();
      if (!keepPreview) setPreview(null);
    } else if (!next.alert) {
      sound.current = null;
    }
    revision.current = next.revision;
    publication.current = next.publicationId;
    setSnapshot(current => current.revision === next.revision && current.nwsActive === next.nwsActive
      && Boolean(current.alert) === Boolean(next.alert) ? current : next);
    if (next.nwsActive) setPreview(null);
  }, [playSound]);

  useEffect(() => {
    if (window !== window.top) return;
    let active = true;
    const setAccount = (id: string | null) => {
      if (!active || ownerRef.current === id) return;
      currentRead.current?.abort();
      ownerRef.current = id;
      revision.current = "";
      publication.current = null;
      sound.current = null;
      setSnapshot(EMPTY);
      setPreview(null);
      setOwner(id);
    };
    const { data: auth } = createClient().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") setAccount(null);
      else setAccount(session?.user.id ?? null);
    });
    const signOut = () => setAccount(null);
    const unlock = () => {
      if (ownerRef.current) void armWeatherWarningSound().then(ready => { if (ready) void playSound(); });
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    window.addEventListener("cmpri-workspace-sign-out", signOut);
    return () => {
      active = false;
      auth.subscription.unsubscribe();
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
      window.removeEventListener("cmpri-workspace-sign-out", signOut);
    };
  }, [playSound]);

  useEffect(() => {
    if (!owner) return;
    let stopped = false;
    let retry: number | undefined;
    async function read() {
      if (stopped) return;
      const request = new AbortController();
      currentRead.current = request;
      let delay = 300;
      try {
        const session = await getValidSession();
        if (stopped || request.signal.aborted || session?.user.id !== owner) return;
        const query = revision.current ? `?revision=${encodeURIComponent(revision.current)}` : "";
        const response = await fetch(ALERT_ENDPOINT + query, {
          headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store", signal: request.signal,
        });
        if (response.status === 401 || response.status === 403) {
          if (!request.signal.aborted) update(EMPTY, owner);
          delay = 8000;
          return;
        }
        const next = await bulletinResponse(response);
        if (!request.signal.aborted) update(next, owner);
      } catch {
        if (!request.signal.aborted) delay = 4000;
      } finally {
        if (currentRead.current === request) currentRead.current = null;
        if (!stopped) retry = window.setTimeout(() => { void read(); }, delay);
      }
    }
    const wake = () => {
      if (document.hidden) return;
      if (currentRead.current) currentRead.current.abort();
      else {
        window.clearTimeout(retry);
        void read();
      }
    };
    void read();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      currentRead.current?.abort();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [owner, update]);

  const expireAt = Math.min(snapshot.alert?.expires ?? Infinity, preview?.expires ?? Infinity);
  useEffect(() => {
    if (!Number.isFinite(expireAt)) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setPreview(current => current && current.expires <= now ? null : current);
      setSnapshot(current => {
        if (!current.alert || current.alert.expires > now) return current;
        sound.current = null;
        return { ...current, alert: null };
      });
    }, Math.min(Math.max(1, expireAt - Date.now() + 5), 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [expireAt]);

  const mutate = useCallback(async (method: "POST" | "DELETE", alert?: WeatherManualAlert) => {
    const privateRevision = previewRevision.current;
    const session = await getValidSession();
    if (!session || ownerRef.current !== session.user.id) throw new Error("Sign in to manage the shared weather alert.");
    const response = await fetch(ALERT_ENDPOINT, {
      method, cache: "no-store", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: alert ? JSON.stringify(alert) : undefined,
    });
    const next = await bulletinResponse(response);
    if (ownerRef.current !== session.user.id) return;
    currentRead.current?.abort();
    const newerPreview = previewRevision.current !== privateRevision;
    update(next, session.user.id, newerPreview);
    if (!newerPreview) setPreview(null);
  }, [update]);

  const registerHosts = useCallback((registered: BulletinHosts) => {
    setHosts(registered);
    return () => setHosts(current => current === registered ? EMPTY_HOSTS : current);
  }, []);
  const showPreview = useCallback((next: WeatherManualAlert) => {
    if (!ownerRef.current) throw new Error("Sign in to preview a weather alert.");
    if (snapshot.nwsActive) throw new Error("An official NWS alert is active.");
    previewRevision.current++;
    setPreview(next);
  }, [snapshot.nwsActive]);
  const context = useMemo<ManualAlertContext>(() => ({
    enabled: true, alert: snapshot.alert, preview, showPreview,
    clearPreview: () => setPreview(null), publish: next => mutate("POST", next), deleteAlert: () => mutate("DELETE"), registerHosts,
  }), [snapshot.alert, preview, showPreview, mutate, registerHosts]);
  const active = snapshot.nwsActive ? null : preview ?? snapshot.alert;
  return <ManualAlerts.Provider value={context}>
    {active && !hosts.bulletinHost ? <div ref={setFallbackBulletin} className="sticky top-0 z-[200] shrink-0" /> : null}
    {active?.override && !hosts.wallpaperHost ? <div ref={setFallbackWallpaper} className={styles.wallpaperHost} /> : null}
    {children}
    <WeatherManualAlertPresentation alert={active} attentionAlert={snapshot.alert} scope={preview ? "preview" : "publish"}
      bulletinHost={hosts.bulletinHost ?? fallbackBulletin} wallpaperHost={hosts.wallpaperHost ?? fallbackWallpaper} />
  </ManualAlerts.Provider>;
}

export default function WeatherManualAlertProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  return enabled ? <PreviewManualAlerts>{children}</PreviewManualAlerts> : children;
}
