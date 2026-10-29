/** Same-origin transport election. Messages are wakeups only, never credentials or data. */
type Bus = Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">;
type Locks = { request(name: string, options: { signal: AbortSignal }, callback: () => Promise<void>): Promise<unknown> };
type Options = {
  key: string;
  locks?: Locks;
  openBus?: (name: string) => Bus;
  start: (wake: () => void) => () => void | Promise<void>;
  wake: () => void;
  failed: () => void;
};
export function coordinateEventTransport(options: Options) {
  let closed = false;
  let bus: Bus | undefined;
  let run: { abort: AbortController; release: () => void } | undefined;
  let serial = Promise.resolve();
  try { if (options.locks) bus = options.openBus?.(options.key); } catch { /* Safe per-document fallback. */ }
  if (bus) bus.onmessage = event => {
    if (!closed && event.data && typeof event.data === "object"
      && Object.keys(event.data).length === 1 && (event.data as { type?: unknown }).type === "wake") options.wake();
  };
  function stop() {
    const previous = run; run = undefined;
    previous?.abort.abort(); previous?.release();
  }
  function setActive(active: boolean) {
    if (!active || closed) { stop(); return; }
    if (run) return;
    const abort = new AbortController();
    let release!: () => void;
    const ended = new Promise<void>(resolve => { release = resolve; });
    const current = { abort, release }; run = current;
    const lead = async () => {
      if (closed || abort.signal.aborted) return;
      const cleanup = options.start(() => {
        if (closed || abort.signal.aborted || run !== current) return;
        options.wake(); bus?.postMessage({ type: "wake" });
      });
      try { await ended; } finally { await cleanup(); }
    };
    // Browser termination releases the Web Lock. No expiring lease, lock stealing,
    // heartbeat, database polling or credentials stored in localStorage are needed.
    const work = bus && options.locks
      ? Promise.resolve().then(() => options.locks!.request(options.key, { signal: abort.signal }, lead))
      : (serial = serial.catch(() => {}).then(lead));
    void work.catch(error => {
      if (!closed && !abort.signal.aborted && error?.name !== "AbortError") {
        if (error?.name === "SecurityError" || error?.name === "NotSupportedError") {
          if (bus) bus.onmessage = null; bus?.close(); bus = undefined;
          void (serial = serial.catch(() => {}).then(lead)).catch(options.failed);
        } else {
          if (run === current) run = undefined;
          options.failed();
        }
      }
    });
  }
  return { setActive, close() { closed = true; stop(); if (bus) bus.onmessage = null; bus?.close(); } };
}
