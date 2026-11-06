"use client";
import { useSyncExternalStore } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { subscribeResources } from "./browser";
export type PoolState = { hours_closed?: boolean; manual_closed?: boolean; closed: boolean; reason: string; revision: number; notifications: { id: string; reason: string }[] };
const empty = { state: null as PoolState | null, error: "" };
let snapshot = empty;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let generation = 0;
function publish(next: typeof empty) { snapshot = next; listeners.forEach(listener => listener()); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stop) {
    const current = ++generation;
    stop = subscribeResources(["pool", "inbox", "session"], async () => {
      try {
        const response = await fetch("/api/pool-status", { headers: await authorizationHeaders(), cache: "no-store" });
        if (!response.ok) throw new Error("Pool status unavailable");
        const state = await response.json();
        if (current === generation) publish({ state, error: "" });
      } catch (error) {
        if (current === generation) publish({ state: null, error: error instanceof Error ? error.message : "Pool unavailable" });
      }
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = undefined; generation++; snapshot = empty; }
  };
}
export function usePoolState() { return useSyncExternalStore(subscribe, () => snapshot, () => empty); }
export function updatePoolState(state: Partial<PoolState>) {
  if (snapshot.state) publish({ state: { ...snapshot.state, ...state }, error: "" });
}
