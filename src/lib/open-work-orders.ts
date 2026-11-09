/** Shared synchronously across same-origin hosts, including embedded frames. */
type Entry = { owner: string; activate: () => void };
type RegistryWindow = Window & { __cmpriOpenWorkOrders?: Map<string, Entry> };

function registry(): Map<string, Entry> {
  let host: RegistryWindow = window;
  try {
    if (window.top && window.top.location.origin === window.location.origin) host = window.top as RegistryWindow;
  } catch { /* A cross-origin parent cannot share this registry. */ }
  return host.__cmpriOpenWorkOrders ||= new Map<string, Entry>();
}

export function claimWorkOrder(id: string, owner: string, activate: () => void): "claimed" | "existing" | "limit" {
  const entries = registry();
  const existing = entries.get(id);
  if (existing) { existing.activate(); return "existing"; }
  if (entries.size >= 5) return "limit";
  entries.set(id, { owner, activate });
  return "claimed";
}

export function releaseWorkOrder(id: string, owner: string) {
  const entries = registry();
  if (entries.get(id)?.owner === owner) entries.delete(id);
}
