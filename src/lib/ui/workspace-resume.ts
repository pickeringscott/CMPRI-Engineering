/** Device-local navigation only. Each screen continues to own its draft/outbox. */
export type WorkspaceIdentity = {
  userId: string;
  hotelId: string;
  role: string;
  secondaryRoles?: readonly string[];
  capabilities: readonly string[];
};
export type WorkspaceView = {
  key: string;
  href?: string;
  kind: "frame" | "list" | "approvals" | "pool-status";
};
export type WorkspaceState = {
  topHref: string | null;
  desktop: { views: WorkspaceView[]; zOrder: string[] };
  modals: { views: WorkspaceView[]; activeKey: string | null };
};
export type WorkspaceSnapshot = WorkspaceState & { version: 1; scope: string; savedAt: number };
export type WorkspaceOptions = {
  origin: string;
  /** Use the current session/authorized launchers, never the stored role. */
  isAllowed: (view: WorkspaceView) => boolean;
  now?: number;
  maxAgeMs?: number;
};
type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = ReadStorage & Pick<Storage, "setItem">;
type ClearStorage = Pick<Storage, "removeItem">;
const PREFIX = "cmpri:workspace:v1:";
export const WORKSPACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORD_LENGTH = 64 * 1024;
const MAX_VIEWS = 20;
const queryNames = new Set([
  "draft", "draftId", "reviewDraft", "date", "week", "template", "templateId",
  "periodStart", "tab", "view", "filter", "sort", "page", "workOrder", "order",
  "historyRecord", "weather", "route",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
}
function names(value: readonly string[] | undefined) {
  return [...new Set((value || []).filter(identifier))].sort();
}
function scope(identity: WorkspaceIdentity): string | null {
  if (!identity || !identifier(identity.userId) || !identifier(identity.hotelId) || !identifier(identity.role)
    || !Array.isArray(identity.capabilities) || (identity.secondaryRoles !== undefined && !Array.isArray(identity.secondaryRoles))) return null;
  return JSON.stringify([identity.userId, identity.hotelId, identity.role, names(identity.secondaryRoles), names(identity.capabilities)]);
}
export function workspaceIdentity(session: {
  user: { id: string; role: string; secondary_roles?: readonly string[] };
  hotelId: string;
  capabilities: readonly string[];
}): WorkspaceIdentity {
  return { userId: session.user.id, hotelId: session.hotelId, role: session.user.role,
    secondaryRoles: names(session.user.secondary_roles), capabilities: names(session.capabilities) };
}
export function workspaceStorageKey(identity: WorkspaceIdentity): string {
  return PREFIX + encodeURIComponent(identity.userId) + ":" + encodeURIComponent(identity.hotelId);
}

/** Omit transient frame tokens, OAuth parameters, fragments and arbitrary query text. */
export function normalizeWorkspaceHref(href: unknown, origin: string): string | null {
  if (typeof href !== "string" || !href || href.length > 4096 || /[\x00-\x1f\x7f\\]/.test(href)
    || href.startsWith("#")) return null;
  try {
    const base = new URL(origin);
    const url = new URL(href, base.origin);
    const decodedPath = decodeURIComponent(url.pathname);
    if (!/^https?:$/.test(base.protocol) || url.origin !== base.origin || url.username || url.password
      || !url.pathname.startsWith("/") || /%2f|%5c/i.test(url.pathname) || /[\x00-\x1f\x7f\\]/.test(decodedPath)
      || /^\/(?:api|auth|oauth|login|logout|sign-in|sign-out)(?:\/|$)/i.test(decodedPath)
      || /^\/_/.test(decodedPath) || url.pathname === "/") return null;
    const search = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!queryNames.has(key) || search.has(key) || !value || value.length > 160
        || !/^[\p{L}\p{N}_.:,/@+\- ]+$/u.test(value) || value.includes("://")) continue;
      if (key === "page" && !/^\d{1,6}$/.test(value)) continue;
      if (["date", "week", "periodStart"].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      if (key === "route" && !/^\/(?:engineering|technician|front-desk|work-orders)$/.test(value)) continue;
      if (key === "weather" && value !== "open") continue;
      if (key === "reviewDraft" && value !== "1") continue;
      search.append(key, value);
    }
    const query = search.toString();
    return url.pathname + (query ? "?" + query : "");
  } catch { return null; }
}

/** Resume once from a plain authorized landing; explicit URLs always win. */
export function workspaceResumeHref(
  saved: Pick<WorkspaceState, "topHref"> | null,
  currentHref: string,
  landing: string,
  options: WorkspaceOptions,
): string | null {
  if (!["/engineering", "/front-desk", "/technician", "/work-orders"].includes(landing)) return null;
  try {
    const current = new URL(currentHref, options.origin);
    if (current.origin !== new URL(options.origin).origin || current.pathname !== landing || current.search || current.hash) return null;
    const href = normalizeWorkspaceHref(saved?.topHref, options.origin);
    if (!href || href === current.pathname) return null;
    const candidate: WorkspaceView = { key: new URL(href, options.origin).pathname, href, kind: "frame" };
    return allowed(candidate, options) ? href : null;
  } catch { return null; }
}

function allowed(view: WorkspaceView, options: WorkspaceOptions) {
  try { return options.isAllowed(view) === true; } catch { return false; }
}
function view(value: unknown, options: WorkspaceOptions): WorkspaceView | null {
  const row = record(value);
  if (row.kind === "frame") {
    const href = normalizeWorkspaceHref(row.href, options.origin);
    if (!href) return null;
    const url = new URL(href, options.origin);
    let key = url.pathname;
    const draftId = url.searchParams.get("draftId");
    if (url.pathname === "/work-orders" && url.searchParams.get("reviewDraft") === "1" && draftId
      && row.key === "work-order-draft:" + draftId) key = row.key;
    const result: WorkspaceView = { key, kind: "frame", href };
    return allowed(result, options) ? result : null;
  }
  const keys = { list: "work-order-list", approvals: "work-order-approvals", "pool-status": "pool-status" } as const;
  if (row.kind !== "list" && row.kind !== "approvals" && row.kind !== "pool-status") return null;
  const result: WorkspaceView = { key: keys[row.kind], kind: row.kind };
  return allowed(result, options) ? result : null;
}
function views(value: unknown, options: WorkspaceOptions): WorkspaceView[] {
  if (!Array.isArray(value)) return [];
  const result: WorkspaceView[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_VIEWS)) {
    const next = view(candidate, options);
    if (next && !seen.has(next.key)) { seen.add(next.key); result.push(next); }
  }
  return result;
}
function state(value: unknown, options: WorkspaceOptions): WorkspaceState {
  const row = record(value), desktop = record(row.desktop), modals = record(row.modals);
  const desktopViews = views(desktop.views, options), modalViews = views(modals.views, options);
  const desktopKeys = new Set(desktopViews.map(item => item.key)), modalKeys = new Set(modalViews.map(item => item.key));
  const zOrder = Array.isArray(desktop.zOrder)
    ? [...new Set(desktop.zOrder.filter((key): key is string => typeof key === "string" && desktopKeys.has(key)))].slice(0, MAX_VIEWS) : [];
  for (const item of desktopViews) if (!zOrder.includes(item.key)) zOrder.push(item.key);
  const topHref = normalizeWorkspaceHref(row.topHref, options.origin);
  const permittedTop = topHref && allowed({ key: new URL(topHref, options.origin).pathname, href: topHref, kind: "frame" }, options) ? topHref : null;
  return {
    topHref: permittedTop,
    desktop: { views: desktopViews, zOrder },
    modals: { views: modalViews, activeKey: typeof modals.activeKey === "string" && modalKeys.has(modals.activeKey) ? modals.activeKey : modalViews.at(-1)?.key || null },
  };
}

/** Call only after a fresh authorized account/property session has been obtained. */
export function readWorkspace(storage: ReadStorage, identity: WorkspaceIdentity, options: WorkspaceOptions): WorkspaceSnapshot | null {
  try {
    const expected = scope(identity);
    if (!expected) return null;
    const raw = storage.getItem(workspaceStorageKey(identity));
    if (!raw || raw.length > MAX_RECORD_LENGTH) return null;
    const row = record(JSON.parse(raw)), now = options.now ?? Date.now();
    const maxAge = Number.isFinite(options.maxAgeMs) && options.maxAgeMs! >= 0 ? Math.min(options.maxAgeMs!, WORKSPACE_MAX_AGE_MS) : WORKSPACE_MAX_AGE_MS;
    if (row.version !== 1 || row.scope !== expected || typeof row.savedAt !== "number" || !Number.isFinite(row.savedAt)
      || !Number.isFinite(now) || row.savedAt < 0 || row.savedAt > now || now - row.savedAt > maxAge) return null;
    return { version: 1, scope: expected, savedAt: row.savedAt, ...state(row, options) };
  } catch { return null; }
}

/** Hosts patch their own section; an omitted/undefined section preserves its prior value. */
export function saveWorkspace(storage: WriteStorage, identity: WorkspaceIdentity, patch: Partial<WorkspaceState>, options: WorkspaceOptions): boolean {
  try {
    const expected = scope(identity), now = options.now ?? Date.now();
    if (!expected || !Number.isFinite(now) || now < 0) return false;
    // A failed storage read must not overwrite a sibling host's saved section.
    const raw = storage.getItem(workspaceStorageKey(identity));
    const previous = readWorkspace({ getItem: () => raw }, identity, options);
    const merged = {
      topHref: patch.topHref === undefined ? previous?.topHref : patch.topHref,
      desktop: patch.desktop === undefined ? previous?.desktop : patch.desktop,
      modals: patch.modals === undefined ? previous?.modals : patch.modals,
    };
    const next: WorkspaceSnapshot = { version: 1, scope: expected, savedAt: now, ...state(merged, options) };
    const encoded = JSON.stringify(next);
    if (encoded.length > MAX_RECORD_LENGTH) return false;
    storage.setItem(workspaceStorageKey(identity), encoded);
    return true;
  } catch { return false; }
}

/** Intentionally removes only this workspace, never Notes or other unsynced drafts. */
export function clearWorkspace(storage: ClearStorage, identity: WorkspaceIdentity): boolean {
  try {
    if (!scope(identity)) return false;
    storage.removeItem(workspaceStorageKey(identity));
    return true;
  } catch { return false; }
}
