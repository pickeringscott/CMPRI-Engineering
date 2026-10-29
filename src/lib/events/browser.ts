"use client";
import { coordinateEventTransport } from "./cross-document";
import { createClient, getValidSession } from "@/lib/supabase/client";
import { HOTEL_ID } from "@/lib/constants";
import { changedResources, type Resource, type Revision } from "./resources";

type Listener = (reason: "initial" | "change" | "reset") => void;
const listeners = new Map<Resource, Set<Listener>>();
let revisions: Record<string,string> = {};
let identity = "";
let generation = 0;
let transport: ReturnType<typeof coordinateEventTransport> | undefined;
let suspended = false;
let authStop: (() => void) | undefined;
let controller: AbortController | undefined;
let running = false, dirty = false;
let queued = false;
const pending = new Set<Resource>();
function emit(resource: Resource, reason: "initial" | "change" | "reset") {
  for (const fn of listeners.get(resource) || []) fn(reason);
}
function flush() {
  if (document.hidden) return;
  for (const key of [...pending]) { pending.delete(key); emit(key, "change"); }
}
function queueSync() {
  dirty = true;
  if (document.hidden || suspended) return;
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; void synchronize(); });
}
async function synchronize() {
  if (running || !listeners.size || document.hidden || suspended) return;
  running = true;
  const version = generation;
  try {
    do {
      dirty = false;
      const session = await getValidSession();
      if (version !== generation) return;
      if (!session) { reset(); return; }
      if (identity && identity !== session.user.id) { reset(); queueSync(); return; }
      identity = session.user.id;
      if (!transport) {
        const user = identity;
        transport = coordinateEventTransport({
          key: "cmpri:events:v1:" + HOTEL_ID + ":" + user,
          locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
          openBus: typeof BroadcastChannel !== "undefined" ? name => new BroadcastChannel(name) : undefined,
          wake: queueSync,
          failed: () => window.dispatchEvent(new Event("cmpri:events-unavailable")),
          start: wake => {
            const owner = createClient();
            const channel = owner.channel("cmpri-events-" + crypto.randomUUID())
              .on("postgres_changes", { event: "*", schema: "public", table: "cmpri_event_signals", filter: "user_id=eq." + user }, wake)
              .subscribe(status => { if (status === "SUBSCRIBED") wake(); });
            return () => {
              // Freeze/pagehide must not hold the election lock waiting on a network ACK.
              // Only disconnect this SDK socket if no unrelated channel uses it.
              if (owner.getChannels().every(item => item === channel)) owner.realtime.disconnect();
              void owner.removeChannel(channel).catch(() => {});
            };
          },
        });
        transport.setActive(!document.hidden && !suspended);
      }
      controller = new AbortController();
      const response = await fetch("/api/events", { headers: { Authorization: "Bearer " + session.access_token }, cache: "no-store", signal: controller.signal });
      if (response.status === 401 || response.status === 403) { reset(); return; }
      if (!response.ok) throw new Error("Live update recovery unavailable");
      const result = await response.json() as { user_id: string; hotel_id: string; revisions: Revision[] };
      const current = await getValidSession();
      if (version !== generation || current?.user.id !== result.user_id || result.hotel_id !== HOTEL_ID) return;
      const first = !Object.keys(revisions).length;
      const delta = changedResources(revisions, result.revisions);
      revisions = delta.next;
      window.dispatchEvent(new Event("cmpri:events-ready"));
      // Subscribe-before-read plus initial reconciliation closes the mount/commit race.
      if (first) for (const key of listeners.keys()) emit(key, "initial");
      else for (const key of delta.changed) { pending.add(key); if (key === "rooms" || key === "room-operations") pending.add("work-orders"); }
      flush();
    } while (dirty && version === generation && listeners.size);
  } catch {
    // No discovery timer. SDK reconnect, network return or explicit user retry recovers.
    window.dispatchEvent(new Event("cmpri:events-unavailable"));
  } finally { running = false; controller = undefined; if (dirty && listeners.size) queueSync(); }
}
function reset() {
  generation++; controller?.abort(); revisions = {}; identity = ""; pending.clear();
  transport?.close(); transport = undefined;
  for (const key of listeners.keys()) emit(key, "reset");
}
function recover() { transport?.setActive(!document.hidden && !suspended); if (!document.hidden && !suspended) { flush(); queueSync(); } }
function suspend() { suspended = true; transport?.setActive(false); }
function resume() { suspended = false; recover(); }
export function subscribeResource(resource: Resource, listener: Listener) {
  if (!listeners.size) {
    suspended = false;
    const { data } = createClient().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (identity && session?.user.id && identity !== session.user.id)) reset();
      queueSync();
    });
    authStop = () => data.subscription.unsubscribe();
    window.addEventListener("online", recover);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", resume);
    document.addEventListener("freeze", suspend);
    document.addEventListener("resume", resume);
    document.addEventListener("visibilitychange", recover);
  }
  const set = listeners.get(resource) || new Set<Listener>();
  set.add(listener); listeners.set(resource, set);
  if (Object.keys(revisions).length) queueMicrotask(() => { if (set.has(listener)) listener("initial"); });
  queueSync();
  return () => {
    set.delete(listener); if (!set.size) listeners.delete(resource);
    if (!listeners.size) {
      authStop?.(); authStop = undefined;
      window.removeEventListener("online", recover);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("freeze", suspend);
      document.removeEventListener("resume", resume);
      document.removeEventListener("visibilitychange", recover);
      reset();
    }
  };
}
/** For explicit retry only. This checks revisions, never blindly refetches snapshots. */
export const recoverResourceEvents = queueSync;


/** Current opaque revision, for matching an acknowledged import without a second read. */
export function resourceRevision(resource: Resource) { return revisions[resource + ":*"]; }
