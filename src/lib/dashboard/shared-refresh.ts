/** One scheduler per browser document; no persisted or cross-tab user data. */
export type RefreshResource = "notifications" | "pool";
export type RefreshSession = { access_token: string; user: { id: string } };
export type RefreshEvent = { data?: unknown; error?: string; reset?: boolean };
type Result = { status: number; data: unknown };
type Listener = { receive: (event: RefreshEvent) => void; userId?: string };
type Dependencies = {
  session: () => Promise<RefreshSession | null>;
  request: (resources: RefreshResource[], token: string, signal: AbortSignal) => Promise<Partial<Record<RefreshResource, Result>>>;
  now: () => number;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
};

export function createSharedRefresh(deps: Dependencies) {
  const listeners: Record<RefreshResource, Set<Listener>> = { notifications: new Set(), pool: new Set() };
  const due: Record<RefreshResource, number> = { notifications: 0, pool: 0 };
  const intervals = { notifications: Infinity, pool: Infinity };
  let timer: unknown;
  let controller: AbortController | undefined;
  let running = false;
  let generation = 0;
  let identity: string | undefined;
  const keys = () => (Object.keys(listeners) as RefreshResource[]).filter(key => listeners[key].size);
  const emit = (key: RefreshResource, event: RefreshEvent, userId?: string) => {
    for (const listener of listeners[key]) {
      if (event.reset || !listener.userId || listener.userId === userId) listener.receive(event);
    }
  };
  function arm() {
    if (timer !== undefined) deps.cancel(timer);
    timer = undefined;
    const active = keys();
    if (!running && active.length && active.some(key => Number.isFinite(due[key]))) timer = deps.schedule(() => { timer = undefined; void run(); }, Math.max(0, Math.min(...active.map(key => due[key])) - deps.now()));
  }
  function invalidate(resources?: RefreshResource[]) {
    generation++;
    controller?.abort();
    for (const key of keys()) if (!Array.isArray(resources) || resources.includes(key)) due[key] = 0;
    arm();
  }
  function reset() {
    identity = undefined;
    for (const key of keys()) emit(key, { reset: true });
    invalidate();
  }
  async function run() {
    if (running || !keys().length) return;
    running = true;
    const version = generation;
    const requested = keys().filter(key => due[key] <= deps.now());
    controller = new AbortController();
    // A stalled refresh cannot hold every widget indefinitely.
    const timeout = deps.schedule(() => controller?.abort(), 15000);
    let userId: string | undefined;
    try {
      const session = await deps.session();
      if (version !== generation) return;
      if (!session) { identity = undefined; for (const key of keys()) emit(key, { reset: true, error: "Sign in again to continue." }); return; }
      userId = session.user.id;
      // Exact token scope also invalidates on refresh, logout/relogin, and account change.
      if (identity !== session.access_token) {
        for (const key of keys()) emit(key, { reset: true });
        identity = session.access_token;
      }
      const result = await deps.request(requested, session.access_token, controller.signal);
      const current = await deps.session();
      if (version !== generation || current?.access_token !== session.access_token) {
        if (version === generation) reset();
        return;
      }
      for (const key of requested) {
        const item = result[key];
        if (!item || item.status < 200 || item.status >= 300) {
          const detail = item?.data as { error?: string } | undefined;
          emit(key, { error: detail?.error || "Refresh temporarily unavailable.", reset: item?.status === 401 || item?.status === 403 }, userId);
        } else emit(key, { data: item.data }, userId);
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (version === generation) for (const key of requested) emit(key, { error: error instanceof Error ? error.message : "Refresh temporarily unavailable.", reset: status === 401 || status === 403 }, userId);
    } finally {
      deps.cancel(timeout);
      controller = undefined;
      // Align deadlines to the same one-second clock so normal request latency
      // does not drift pool refreshes into separate authentication requests.
      if (version === generation) for (const key of requested) due[key] = Math.floor(deps.now() / 1000) * 1000 + intervals[key];
      running = false;
      arm();
    }
  }
  return {
    subscribe(key: RefreshResource, receive: Listener["receive"], userId?: string) {
      const listener = { receive, userId };
      const first = !listeners[key].size;
      listeners[key].add(listener);
      if (first) due[key] = 0;
      // New subscribers join the next shared result; no per-component request.
      arm();
      return () => {
        listeners[key].delete(listener);
        if (!keys().length) { generation++; controller?.abort(); identity = undefined; }
        arm();
      };
    },
    invalidate,
    reset,
  };
}
