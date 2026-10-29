"use client";
import { subscribeResource } from "@/lib/events/browser";
import { createClient, getValidSession } from "@/lib/supabase/client";
import { createSharedRefresh, type RefreshEvent, type RefreshResource } from "./shared-refresh";

let shared: ReturnType<typeof createSharedRefresh> | undefined;
let subscribers = 0;
let unsubscribeResources: (() => void)[] = [];
let unsubscribeAuth: (() => void) | undefined;

function service() {
  shared ??= createSharedRefresh({
    session: getValidSession,
    now: Date.now,
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: timer => window.clearTimeout(timer as number),
    request: async (resources, token, signal) => {
      const query = new URLSearchParams(resources.map(key => ["resource", key]));
      const response = await fetch(`/api/dashboard/refresh?${query}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
      });
      const payload = await response.json();
      if (!response.ok) throw Object.assign(new Error(payload.error || "Refresh temporarily unavailable."), { status: response.status });
      return payload;
    },
  });
  return shared;
}

export function subscribeDashboardRefresh(resource: RefreshResource, receive: (event: RefreshEvent) => void, userId?: string) {
  const refresh = service();
  if (!subscribers++) {
    const { data } = createClient().auth.onAuthStateChange(() => refresh.reset());
    unsubscribeAuth = () => data.subscription.unsubscribe();
    window.addEventListener("cmpri:dashboard-refresh", invalidateDashboardRefresh);
    unsubscribeResources = ["notifications","pool"].map(resource => subscribeResource(resource as "notifications" | "pool", reason => reason === "reset" ? refresh.reset() : refresh.invalidate([resource as RefreshResource])));
  }
  const unsubscribe = refresh.subscribe(resource, receive, userId);
  return () => {
    unsubscribe();
    if (!--subscribers) {
      unsubscribeResources.forEach(stop => stop()); unsubscribeResources = [];
      unsubscribeAuth?.();
      unsubscribeAuth = undefined;
      window.removeEventListener("cmpri:dashboard-refresh", invalidateDashboardRefresh);
    }
  };
}

export function invalidateDashboardRefresh() {
  shared?.invalidate();
}
