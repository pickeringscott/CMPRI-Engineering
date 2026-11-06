"use client";
import { createClient } from "@/lib/supabase/client";
import { eventRefresh } from "./refresh";

export type ResourceTopic = "orders" | "inbox" | "pool" | "rooms" | "feedback" | "session";
type Listener = { topics: readonly ResourceTopic[]; request: () => void };
const listeners = new Set<Listener>();
let shutdown: (() => void) | undefined;

function start() {
  const client = createClient();
  let active = true;
  let userId: string | null = null;
  let channel: ReturnType<typeof client.channel> | undefined;
  const invalidate = (topic?: ResourceTopic) => {
    if (document.hidden) return;
    for (const listener of listeners) if (!topic || listener.topics.includes(topic)) listener.request();
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
        const row = payload.new as { topic?: ResourceTopic };
        if (active && userId === nextId && row.topic) invalidate(row.topic);
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
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  return () => {
    active = false;
    subscription.unsubscribe();
    if (channel) void client.removeChannel(channel);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
  };
}

export function subscribeResources(topics: readonly ResourceTopic[], load: () => Promise<unknown>, initial = true) {
  const refresh = eventRefresh(load);
  const listener = { topics, request: refresh.request };
  listeners.add(listener);
  shutdown ??= start();
  if (initial) refresh.request();
  return () => {
    refresh.stop();
    listeners.delete(listener);
    if (!listeners.size) { shutdown?.(); shutdown = undefined; }
  };
}
