"use client";
import { useEffect, useRef } from "react";
import { subscribeResource } from "./browser";
import type { Resource } from "./resources";
/** Initial/on-open loading stays with the feature; only committed revisions cause refresh. */
export function useResourceChange(resource: Resource, refresh: () => void | Promise<unknown>) {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; });
  useEffect(() => subscribeResource(resource, reason => { if (reason === "reset") return; void Promise.resolve().then(() => latest.current()).catch(() => { window.dispatchEvent(new Event("cmpri:events-unavailable")); }); }), [resource]);
}

