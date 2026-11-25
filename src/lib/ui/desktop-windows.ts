import { isNotepadPath } from "./notepad-navigation";
export type WindowRect = { x: number; y: number; width: number; height: number };
export type WindowSize = { width: number; height: number };
export type DesktopBounds = WindowSize;
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
export const MIN_WINDOW_SIZE: WindowSize = { width: 320, height: 200 };
/** Below this desktop width a window fills the desktop so it stays usable on phones. */
export const COMPACT_DESKTOP_WIDTH = 640;
const CASCADE_STEP = 28;
const CASCADE_SLOTS = 6;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function whole(value: number, fallback = 0) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function isRect(value: unknown): value is WindowRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]));
}

/** Keeps a window fully inside the desktop and no smaller than the minimum size the desktop allows. */
export function clampWindowRect(rect: WindowRect, bounds: DesktopBounds, min: WindowSize = MIN_WINDOW_SIZE): WindowRect {
  const desktopWidth = Math.max(0, Math.floor(bounds.width));
  const desktopHeight = Math.max(0, Math.floor(bounds.height));
  if (desktopWidth < COMPACT_DESKTOP_WIDTH) {
    return { x: 0, y: 0, width: desktopWidth, height: desktopHeight };
  }
  const width = clamp(whole(rect.width, min.width), Math.min(min.width, desktopWidth), desktopWidth);
  const height = clamp(whole(rect.height, min.height), Math.min(min.height, desktopHeight), desktopHeight);
  return {
    x: clamp(whole(rect.x), 0, desktopWidth - width),
    y: clamp(whole(rect.y), 0, desktopHeight - height),
    width,
    height,
  };
}

/** Centers a new window and cascades later windows so stacked windows stay distinguishable. */
export function defaultWindowRect(bounds: DesktopBounds, preferred: WindowSize, cascadeIndex = 0): WindowRect {
  // Compact desktops render every window full-size; keep a real desired size for when the desktop grows.
  if (bounds.width < COMPACT_DESKTOP_WIDTH) return { x: 0, y: 0, width: preferred.width, height: preferred.height };
  const width = Math.min(preferred.width, Math.round(bounds.width * 0.92));
  const height = Math.min(preferred.height, Math.round(bounds.height * 0.92));
  const offset = (Math.max(0, cascadeIndex) % CASCADE_SLOTS) * CASCADE_STEP;
  return clampWindowRect({
    x: Math.round((bounds.width - width) / 2) - CASCADE_STEP * 2 + offset,
    y: Math.round((bounds.height - height) / 3) + offset,
    width,
    height,
  }, bounds);
}

export function moveWindowRect(start: WindowRect, dx: number, dy: number, bounds: DesktopBounds): WindowRect {
  return clampWindowRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds);
}

/** Resizes from any edge or corner while the opposite edge stays anchored. */
export function resizeWindowRect(
  start: WindowRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  bounds: DesktopBounds,
  min: WindowSize = MIN_WINDOW_SIZE,
): WindowRect {
  const minWidth = Math.min(min.width, bounds.width);
  const minHeight = Math.min(min.height, bounds.height);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let { x, y, width, height } = start;
  if (edge.includes("e")) width = clamp(start.width + dx, minWidth, bounds.width - start.x);
  if (edge.includes("s")) height = clamp(start.height + dy, minHeight, bounds.height - start.y);
  if (edge.includes("w")) {
    x = clamp(start.x + dx, 0, right - minWidth);
    width = right - x;
  }
  if (edge.includes("n")) {
    y = clamp(start.y + dy, 0, bottom - minHeight);
    height = bottom - y;
  }
  return clampWindowRect({ x, y, width, height }, bounds, min);
}

export function raiseWindow(order: string[], key: string): string[] {
  return [...order.filter((entry) => entry !== key), key];
}

/** Record windows share the remembered size and position of their screen. */
export function windowLayoutKey(windowKey: string) {
  if (/^\/work-orders\/[^/]+$/.test(windowKey)) return "/work-orders/:id";
  return windowKey.split("?")[0];
}

export function desktopLayoutStorageKey(userId: string) {
  return `cmpri:desktop-window-layout:v1:${userId}`;
}

export function readDesktopLayouts(storage: StorageLike, userId: string): Record<string, WindowRect> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(desktopLayoutStorageKey(userId)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, rect]) => isRect(rect))) as Record<string, WindowRect>;
  } catch {
    return {};
  }
}

export function saveDesktopLayout(storage: StorageLike, userId: string, layoutKey: string, rect: WindowRect) {
  const layouts = { ...readDesktopLayouts(storage, userId), [layoutKey]: rect };
  try {
    storage.setItem(desktopLayoutStorageKey(userId), JSON.stringify(layouts));
  } catch {}
  return layouts;
}

/** Reuse an exact record window, never a different record on the same screen. */
export function desktopWindowKeyForHref(href: string, origin: string) {
  const url = new URL(href, origin);
  const parameter = url.pathname === "/management/equipment" ? "asset" : isNotepadPath(url.pathname) ? "note"
    : url.pathname === "/engineering/room-ranking" ? "room" : "";
  const id = parameter && url.searchParams.get(parameter);
  return id ? `${url.pathname}?${parameter}=${encodeURIComponent(id)}` : url.pathname;
}

export function isAskRecordRoute(href: string, origin: string) {
  if (!isDesktopRoute(href, origin)) return false;
  const url = new URL(href, origin);
  return /^\/work-orders\/[^/]+$/.test(url.pathname)
    || (url.pathname === "/management/equipment" && Boolean(url.searchParams.get("asset")))
    || (isNotepadPath(url.pathname) && Boolean(url.searchParams.get("note")))
    || url.pathname === "/engineering/room-ranker"
    || url.pathname === "/engineering/room-ranking";
}

export function refocusAssetWindow(frame: HTMLIFrameElement | undefined, href: string | undefined) {
  if (!frame || !href) return;
  const url = new URL(href, window.location.origin);
  const assetId = url.pathname === "/management/equipment" && url.searchParams.get("asset");
  const modalToken = url.searchParams.get("modalToken");
  if (assetId && modalToken) {
    frame.contentWindow?.postMessage({ type: "cmpri-open-asset", assetId, modalToken }, url.origin);
  }
}

export function isDesktopRoute(href: string, origin: string) {
  if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return false;
  try {
    const url = new URL(href, origin);
    return url.origin === origin
      && url.pathname !== "/api"
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/_");
  } catch {
    return false;
  }
}

export function desktopFrameHref(href: string, modalToken: string, origin: string) {
  const url = new URL(href, origin);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("modalToken", modalToken);
  return `${url.pathname}${url.search}${url.hash}`;
}
