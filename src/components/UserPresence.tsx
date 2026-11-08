"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { HOTEL_ID } from "@/lib/constants";

const empty = new Set<string>();
let online = empty;
const listeners = new Set<() => void>();
function publish(value: Set<string>) {
  online = value;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Presence carries opaque identifiers only, never emails or profile data.
// This is a display signal and is never used to authorize access.
export async function presenceKey(id: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${HOTEL_ID}:${id}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function useOnlineUsers() {
  return useSyncExternalStore(subscribe, () => online, () => empty);
}

export default function UserPresence() {
  useEffect(() => {
    const client = createClient();
    let channel: RealtimeChannel | undefined;
    let owner = "";
    let generation = 0;
    let stopped = false;
    function clear() {
      if (channel) void client.removeChannel(channel);
      channel = undefined;
      owner = "";
      publish(empty);
    }
    async function connect(id?: string) {
      const version = ++generation;
      if (!id) { clear(); return; }
      if (id === owner && channel) return;
      clear();
      const key = await presenceKey(id);
      if (stopped || version !== generation) return;
      owner = id;
      const next = client.channel(`cmpri-online:${HOTEL_ID}`);
      channel = next;
      next.on("presence", { event: "sync" }, () => {
        if (channel !== next) return;
        const keys = Object.values(next.presenceState<{ key: string }>()).flat().map((entry) => entry.key).filter(Boolean);
        publish(new Set(keys));
      }).subscribe((status) => {
        if (channel !== next) return;
        if (status === "SUBSCRIBED") void next.track({ key });
        else publish(empty);
      });
    }
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      void connect(session?.user.id).catch(() => { clear(); });
    });
    const offline = () => publish(empty);
    window.addEventListener("offline", offline);
    return () => {
      stopped = true;
      generation++;
      data.subscription.unsubscribe();
      window.removeEventListener("offline", offline);
      clear();
    };
  }, []);
  return null;
}
