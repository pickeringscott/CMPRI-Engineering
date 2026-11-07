"use client";
import { createClient } from "@/lib/supabase/client";
import { eventRefresh } from "./refresh";
import { resourceViewVisible, watchResourceVisibility } from "./visibility";
import { invalidateCachedResources, reconcileDeviceDataCache } from "@/lib/data-cache/browser";

export type ResourceTopic = "orders" | "inbox" | "pool" | "rooms" | "feedback" | "session" | "reference";
type Listener = { topics: readonly ResourceTopic[]; request: () => void };
const listeners = new Set<Listener>();
let shutdown: (() => void) | undefined;

function start() {
  const client = createClient();
  let active = true;
  let userId: string | null = null;
  let channel: ReturnType<typeof client.channel> | undefined;
  const notify = (topics?: readonly string[]) => {
    if (document.hidden) return;
    for (const listener of listeners) if (!topics || listener.topics.some(topic => topics.includes(topic))) listener.request();
  };
  const invalidate = (topic?: ResourceTopic, revision?: number) => {
    if (topic) void invalidateCachedResources([topic], revision, false).then(() => notify([topic]));
    else if (!document.hidden) void reconcileDeviceDataCache().then(() => notify());
  };
  const connect = (nextId: string | null) => {
    if (!active || nextId === userId) return;
    userId = nextId;
    if (channel) void client.removeChannel(channel);
    channel = undefined;
    invalidate(); // Clear/reload state on identity changes, including sign-out.
    if (!nextId) return;
    channel = client.channel(`cmpri-resources:${nextId}:${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "cmpri_resource_signals", filter: `recipient_user_id=eq.${nextId}` }, payload => {
        const row = payload.new as { topic?: ResourceTopic; revision?: number };
        if (active && userId === nextId && row.topic) invalidate(row.topic, row.revision);
      }).subscribe(status => {
        // Catch up after initial subscribe and SDK reconnect; no periodic reads.
        if (active && userId === nextId && status === "SUBSCRIBED") invalidate();
      });
  };
  const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
    // Never await auth calls from inside the Supabase auth lock.
    queueMicrotask(() => connect(session?.user.id ?? null));
  });
  const wake = () => invalidate();
  const localChange = (event: Event) => notify((event as CustomEvent<{ topics?: string[] }>).detail?.topics);
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("cmpri-data-cache-invalidated", localChange);
  return () => {
    active = false;
    subscription.unsubscribe();
    if (channel) void client.removeChannel(channel);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("cmpri-data-cache-invalidated", localChange);
  };
}

export function subscribeResources(topics: readonly ResourceTopic[], load: () => Promise<unknown>, initial = true) {
  const refresh = eventRefresh(async () => { if (resourceViewVisible(window)) await load(); });
  const stopVisibility = watchResourceVisibility(window, refresh.request);
  // Same-origin modal frames reuse the host's connection; callbacks keep their own visibility gate.
  let parentSubscribe: typeof subscribeResources | undefined;
  try { if (window.parent !== window) parentSubscribe = (window.parent as ResourceWindow).__cmpriResources; } catch {}
  if (parentSubscribe) {
    const stopParent = parentSubscribe(topics, async () => { refresh.request(); }, initial);
    let stopped = false;
    const frame = window.frameElement;
    const observer = new MutationObserver(() => { if (frame && !frame.isConnected) stop(); });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      window.removeEventListener("pagehide", stop);
      stopVisibility(); refresh.stop(); stopParent();
    };
    observer.observe(window.parent.document, { childList: true, subtree: true });
    window.addEventListener("pagehide", stop);
    return stop;
  }
  const listener = { topics, request: refresh.request };
  listeners.add(listener);
  shutdown ??= start();
  if (initial) refresh.request();
  return () => {
    stopVisibility();
    refresh.stop();
    listeners.delete(listener);
    if (!listeners.size) { shutdown?.(); shutdown = undefined; }
  };
}

type ResourceWindow = Window & { __cmpriResources?: typeof subscribeResources };
if (typeof window !== "undefined") (window as ResourceWindow).__cmpriResources = subscribeResources;
