import type { WorkOrderListFilter } from "../components/WorkOrderFilters";
import type { WorkOrderSort } from "./work-order-sort";

export type WorkOrderListPreferences = { filter: WorkOrderListFilter; sort: WorkOrderSort; query: string; page: number };
export const DEFAULT_WORK_ORDER_LIST_PREFERENCES: WorkOrderListPreferences = { filter: "all", sort: "default", query: "", page: 0 };
const FILTERS = ["all", "pending", "open", "progress", "priority", "overdue", "completed", "closed"];
const SORTS = ["default", "tier-high", "tier-low", "created-newest", "created-oldest", "due-earliest", "due-latest"];
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function preferenceKey(scope?: string) {
  return scope && scope.length <= 300 ? `cmpri:work-order-list:v1:${encodeURIComponent(scope)}` : null;
}

function normalize(value: unknown): WorkOrderListPreferences {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    filter: FILTERS.includes(String(data.filter)) ? data.filter as WorkOrderListFilter : "all",
    sort: SORTS.includes(String(data.sort)) ? data.sort as WorkOrderSort : "default",
    query: typeof data.query === "string" ? data.query.slice(0, 200) : "",
    page: Number.isSafeInteger(data.page) && Number(data.page) >= 0 && Number(data.page) <= 100000 ? Number(data.page) : 0,
  };
}

/** Navigation preferences only; no work-order records or credentials are stored here. */
export function readWorkOrderListPreferences(storage: PreferenceStorage, scope?: string): WorkOrderListPreferences {
  const key = preferenceKey(scope);
  if (!key) return { ...DEFAULT_WORK_ORDER_LIST_PREFERENCES };
  try {
    const raw = storage.getItem(key);
    return raw && raw.length <= 4096 ? normalize(JSON.parse(raw)) : { ...DEFAULT_WORK_ORDER_LIST_PREFERENCES };
  } catch { return { ...DEFAULT_WORK_ORDER_LIST_PREFERENCES }; }
}

export function saveWorkOrderListPreferences(storage: PreferenceStorage, scope: string | undefined, preferences: WorkOrderListPreferences) {
  const key = preferenceKey(scope);
  if (!key) return;
  try { storage.setItem(key, JSON.stringify(normalize(preferences))); } catch { /* The list remains usable when device storage is unavailable. */ }
}
