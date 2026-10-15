"use client";
import { useEffect, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { createClient } from "@/lib/supabase/client";
import { isInstalledMobileApp } from "@/lib/notifications/installed-mobile";
type Summary = { unread: number; unreadKeys: string[]; frontDesk: boolean; management: boolean; alertNow: boolean; hotelId: string };
export default function StaffNotesUnread() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (window.parent !== window) return;
    const client = createClient();
    let channel: ReturnType<typeof client.channel> | undefined;
    let stopped = false, previous = new Set<string>(), initialized = false;
    let audio: AudioContext | undefined;
    const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { mobile: boolean }; setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    const standalone = window.matchMedia("(display-mode: standalone)").matches || !!nav.standalone;
    const mobile = isInstalledMobileApp({ standalone, iosStandalone: nav.standalone, mobile: nav.userAgentData?.mobile, userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints });
    const desktop = standalone && !mobile;
    const unlock = () => { try { audio ??= new AudioContext(); void audio.resume().catch(() => {}); } catch {} };
    document.addEventListener("pointerdown", unlock); document.addEventListener("keydown", unlock);
    async function refresh() {
      try {
        const response = await fetch("/api/staff-notes?inbox=1", { headers: await authorizationHeaders(), cache: "no-store" });
        if (!response.ok) return;
        const value: Summary = await response.json();
        if (stopped) return;
        const allowed = value.frontDesk ? desktop : value.management || mobile;
        const hasNew = initialized && value.unreadKeys.some(key => !previous.has(key));
        previous = new Set(value.unreadKeys); initialized = true;
        setSummary(value); setVisible(allowed && value.alertNow);
        if (allowed && standalone) {
          try { if (value.unread && value.alertNow) await nav.setAppBadge?.(value.unread); else await nav.clearAppBadge?.(); } catch {}
        }
        if (hasNew && value.management && !value.frontDesk && value.alertNow && audio?.state === "running") {
          const oscillator = audio.createOscillator(), gain = audio.createGain();
          oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = 880;
          gain.gain.setValueAtTime(0.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
          oscillator.start(); oscillator.stop(audio.currentTime + 0.12);
        }
        if (!channel) {
          channel = client.channel(`staff-notes-unread-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "cmpri_staff_notes", filter: `hotel_id=eq.${value.hotelId}` }, () => void refresh())
            .subscribe(status => { if (status === "SUBSCRIBED") void refresh(); });
        }
      } catch { /* A signed-out page has no badge or alert authority. */ }
    }
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const { data: listener } = client.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") { setSummary(null); setVisible(false); previous.clear(); initialized = false; void nav.clearAppBadge?.().catch(() => {}); if (channel) void client.removeChannel(channel); channel = undefined; }
      else setTimeout(() => void refresh(), 0);
    });
    void refresh();
    document.addEventListener("visibilitychange", refreshVisible); window.addEventListener("online", refreshVisible); window.addEventListener("cmpri-staff-notes-read", refreshVisible);
    return () => { stopped = true; listener.subscription.unsubscribe(); if (channel) void client.removeChannel(channel); void audio?.close(); document.removeEventListener("pointerdown", unlock); document.removeEventListener("keydown", unlock); document.removeEventListener("visibilitychange", refreshVisible); window.removeEventListener("online", refreshVisible); window.removeEventListener("cmpri-staff-notes-read", refreshVisible); };
  }, []);
  if (!visible || !summary?.unread) return null;
  return <a href="/staff-notes" aria-label={`${summary.unread} unread staff notes`} className="fixed bottom-2 right-2 z-40 rounded-full border border-amber-400/50 bg-slate-950 px-2 py-1 text-xs text-amber-300">Staff Notes · {summary.unread}</a>;
}
