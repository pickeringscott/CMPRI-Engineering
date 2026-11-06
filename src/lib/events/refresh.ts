/** Coalesce bursts, but never lose an event received while a read is in flight. */
export function eventRefresh(load: () => Promise<unknown>, onError: (error: unknown) => void = () => {}) {
  let active = true;
  let running = false;
  let dirty = false;
  const run = async () => {
    if (!active || running) return;
    running = true;
    try {
      while (active && dirty) {
        dirty = false;
        try { await load(); } catch (error) { if (active) onError(error); }
      }
    } finally { running = false; }
  };
  return {
    request() { if (active) { dirty = true; queueMicrotask(() => void run()); } },
    stop() { active = false; dirty = false; },
  };
}
