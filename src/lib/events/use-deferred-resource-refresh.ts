"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { subscribeResources, type ResourceTopic } from "./browser";

/** Refresh mounted readers after resource events, without replacing an active draft or queue. */
export function useDeferredResourceRefresh(
  topics: readonly ResourceTopic[],
  blocked: boolean,
  load: (isCurrent: () => boolean) => Promise<unknown>,
  context = "",
) {
  const state = useRef({ active: false, pending: false, running: false, generation: 0 });
  const canRefresh = useEffectEvent(() => !blocked);
  const refresh = useEffectEvent(async (): Promise<void> => {
    const current = state.current;
    if (!current.active || current.running || !current.pending || !canRefresh()) return;
    current.pending = false;
    current.running = true;
    const generation = current.generation;
    const isCurrent = () => current.active && current.generation === generation && canRefresh();
    try {
      await load(isCurrent);
    } catch {
      // The reader owns its error display. Retry on another event, never on a timer.
    } finally {
      current.running = false;
      if (current.active && generation !== current.generation) current.pending = true;
      if (current.active && current.pending) void refresh();
    }
  });

  useLayoutEffect(() => {
    state.current.generation++;
  }, [blocked, context]);

  useEffect(() => {
    const current = state.current;
    current.active = true;
    const stop = subscribeResources(topics, async () => {
      current.pending = true;
      await refresh();
    }, false);
    return () => {
      current.active = false;
      current.pending = false;
      current.generation++;
      stop();
    };
  }, [topics]);

  useEffect(() => { void refresh(); }, [blocked, context]);
}
