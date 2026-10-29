"use client";
/** Coalesce simultaneous identical reads only; never retain authorization across requests. */
const inFlight = new Map<string, Promise<Response>>();
export function sharedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  if (method !== "GET" || init?.signal || typeof input !== "string" || !input.startsWith("/api/")) return fetch(input,init);
  const headers = new Headers(init?.headers);
  const key = JSON.stringify([input,[...headers.entries()].sort(),init?.credentials || "same-origin"]);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetch(input,init).finally(() => inFlight.delete(key));
    inFlight.set(key,pending);
  }
  return pending.then(response => response.clone());
}
