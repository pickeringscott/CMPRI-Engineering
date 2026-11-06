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
function update(state: Partial<PoolState>) {
  if (snapshot.state) publish({ state: { ...snapshot.state, ...state }, error: "" });
}
type Store = { subscribe: typeof subscribe; read: () => typeof empty; update: typeof update };
const ownStore:Store={subscribe,read:()=>snapshot,update};
type PoolWindow=Window & {__cmpriPoolStore?:Store};
function currentStore():Store {
  if(typeof window==='undefined')return ownStore;
  try{if(window.parent!==window){const parent=(window.parent as PoolWindow).__cmpriPoolStore;if(parent)return parent}}catch{}
  return ownStore;
}
if(typeof window!=='undefined')(window as PoolWindow).__cmpriPoolStore=ownStore;
function subscribeCurrent(listener:()=>void){
  const store=currentStore(),stop=store.subscribe(listener);
  if(store===ownStore)return stop;
  // Removing an iframe need not unmount React. Release the host listener in either case.
  const frame=window.frameElement;let stopped=false;
  const observer=new MutationObserver(()=>{if(frame&&!frame.isConnected)cleanup()});
  const cleanup=()=>{if(stopped)return;stopped=true;observer.disconnect();window.removeEventListener('pagehide',cleanup);stop()};
  observer.observe(window.parent.document,{childList:true,subtree:true});window.addEventListener('pagehide',cleanup);return cleanup;
}
export function usePoolState() { return useSyncExternalStore(subscribeCurrent, () => currentStore().read(), () => empty); }
export function updatePoolState(state: Partial<PoolState>) { currentStore().update(state); }
