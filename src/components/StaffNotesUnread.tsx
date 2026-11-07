"use client";
import { useEffect } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { createClient } from "@/lib/supabase/client";
import { isInstalledMobileApp } from "@/lib/notifications/installed-mobile";
import {subscribeResources} from '@/lib/events/browser';
import { invalidateCachedResources } from '@/lib/data-cache/browser';
import {publishStaffNotesSummary,expireStaffNotesFlag,type StaffNotesSummary} from '@/lib/staff-notes-unread';
export default function StaffNotesUnread() {
  useEffect(() => {
    if (window.parent !== window) return;
    const client = createClient();
    let channel: ReturnType<typeof client.channel> | undefined;
    let stopped = false, previous = new Set<string>(), initialized = false;
    let audio: AudioContext | undefined,expiry:ReturnType<typeof setTimeout>|undefined;
    let generation=0,requestSequence=0,channelOwner='';
    const publish=(value:StaffNotesSummary|null)=>{
      clearTimeout(expiry);publishStaffNotesSummary(value);
      if(value?.frontDesk&&value.nextFlagChangeAt)expiry=setTimeout(()=>publish(expireStaffNotesFlag(value)),Math.max(0,Date.parse(value.nextFlagChangeAt)-Date.now())+10);
    };
    publish(null);
    const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { mobile: boolean }; setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    const standalone = window.matchMedia("(display-mode: standalone)").matches || !!nav.standalone;
    const mobile = isInstalledMobileApp({ standalone, iosStandalone: nav.standalone, mobile: nav.userAgentData?.mobile, userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints });
    const desktop = standalone && !mobile;
    const unlock = () => { try { audio ??= new AudioContext(); void audio.resume().catch(() => {}); } catch {} };
    document.addEventListener("pointerdown", unlock); document.addEventListener("keydown", unlock);
    async function refresh() {
      const version=generation,sequence=++requestSequence;
      try {
        const response = await fetch("/api/staff-notes?inbox=1", { headers: await authorizationHeaders(), cache: "no-store" });
        if(stopped||version!==generation||sequence!==requestSequence)return;
        if (!response.ok) {if(response.status===401||response.status===403)publish(null);return;}
        const value: StaffNotesSummary = await response.json();
        if (stopped||version!==generation||sequence!==requestSequence) return;
        const owner=value.hotelId+':'+value.userId;
        if(channel&&owner!==channelOwner){void client.removeChannel(channel);channel=undefined;previous.clear();initialized=false}
        const allowed = value.frontDesk ? desktop : value.management || mobile;
        const hasNew = initialized && value.unreadKeys.some(key => !previous.has(key));
        previous = new Set(value.unreadKeys); initialized = true;
        publish(expireStaffNotesFlag(value));
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
          channelOwner=owner;
          channel = client.channel(`staff-notes-unread-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "cmpri_staff_notes", filter: `hotel_id=eq.${value.hotelId}` }, () => { void invalidateCachedResources(['notes','inbox']).then(refresh); })
            .subscribe(status => { if (status === "SUBSCRIBED") void refresh(); });
        }
      } catch { /* A signed-out page has no badge or alert authority. */ }
    }
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const { data: listener } = client.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") { generation++;publish(null); previous.clear(); initialized = false; void nav.clearAppBadge?.().catch(() => {}); if (channel) void client.removeChannel(channel); channel = undefined; }
      else {generation++;setTimeout(() => void refresh(), 0);}
    });
    const stopResources=subscribeResources(['inbox','session'],refresh,false);
    void refresh();
    document.addEventListener("visibilitychange", refreshVisible); window.addEventListener("online", refreshVisible); window.addEventListener("cmpri-staff-notes-read", refreshVisible);window.addEventListener("cmpri-staff-notes-posted", refreshVisible);
    return () => { stopped = true;generation++;clearTimeout(expiry);stopResources();publishStaffNotesSummary(null); listener.subscription.unsubscribe(); if (channel) void client.removeChannel(channel); void audio?.close(); document.removeEventListener("pointerdown", unlock); document.removeEventListener("keydown", unlock); document.removeEventListener("visibilitychange", refreshVisible); window.removeEventListener("online", refreshVisible); window.removeEventListener("cmpri-staff-notes-read", refreshVisible);window.removeEventListener("cmpri-staff-notes-posted", refreshVisible); };
  }, []);
  // The visual flag belongs to the existing Staff Notes action, never a floating link.
  return null;
}
