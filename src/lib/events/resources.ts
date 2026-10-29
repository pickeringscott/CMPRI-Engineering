/** Payload-free invalidation domains. Actual reads retain their existing authorization. */
export const RESOURCES = ["work-orders","notifications","mentions","pool","room-operations","feedback","documents","staff-notes","profile","access","drafts","catalog","purchasing","enseo","employment","hours","winter","rooms","users","pm","gss","drive","phone-test","room-ranker"] as const;
export type Resource = typeof RESOURCES[number];
export type Revision = { resource: Resource; scope: string; revision: string };
export function changedResources(previous: Record<string,string>, rows: Revision[]) {
  const next: Record<string,string> = {};
  const changed = new Set<Resource>();
  for (const row of rows) {
    const key = row.resource + ":" + row.scope;
    next[key] = row.revision;
    if (previous[key] !== row.revision) changed.add(row.resource);
  }
  return { next, changed };
}

