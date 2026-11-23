import { loyaltyRank, loyaltyTier } from "@/lib/loyalty-tier";

export type AskNativeFilter = {
  path: string;
  operator: "eq" | "ne" | "contains" | "notContains" | "in" | "gt" | "gte" | "lt" | "lte" | "exists" | "missing" | "tierAtLeast" | "tierAtMost";
  value?: unknown;
};
export type AskNativeQuery = {
  path?: string;
  filters?: AskNativeFilter[];
  match?: "all" | "any";
  sort?: { path: string; direction: "asc" | "desc"; type?: "auto" | "bonvoy" }[];
  fields?: string[];
  groupBy?: string;
  aggregate?: "count" | "sum" | "average" | "min" | "max" | "distinct";
  aggregatePath?: string;
  offset?: number;
  limit?: number;
};

const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Query only a snapshot already authorized by a native CMPRI handler. */
export function askNativeValue(value: unknown, path = ""): unknown {
  if (!path || path === "$") return value;
  const segments = path.replace(/^\$\.?/, "").replace(/\[(\d+|\*)\]/g, ".$1").split(".").filter(Boolean);
  if (segments.some(segment => forbidden.has(segment))) throw new Error("Invalid data field.");
  const at = (current: unknown, index: number): unknown => {
    if (index === segments.length) return current;
    const segment = segments[index];
    if (Array.isArray(current)) {
      if (/^\d+$/.test(segment)) return at(current[Number(segment)], index + 1);
      return current.flatMap(item => {
        const result = at(item, segment === "*" ? index + 1 : index);
        return result === undefined ? [] : Array.isArray(result) ? result : [result];
      });
    }
    if (!current || typeof current !== "object") return undefined;
    if (segment === "*") return Object.values(current).flatMap(item => at(item, index + 1) ?? []);
    return Object.hasOwn(current, segment) ? at((current as Record<string, unknown>)[segment], index + 1) : undefined;
  };
  return at(value, 0);
}

function comparable(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US");
  return JSON.stringify(value);
}

function comparison(left: unknown, right: unknown) {
  const a = comparable(left), b = comparable(right);
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true });
}

export function askNativeMatches(row: unknown, filter: AskNativeFilter): boolean {
  const found = askNativeValue(row, filter.path);
  const values = Array.isArray(found) ? found : [found];
  if (filter.operator === "exists") return values.some(value => comparable(value) !== null);
  if (filter.operator === "missing") return values.every(value => comparable(value) === null);
  const one = (value: unknown) => {
    const actual = comparable(value), expected = comparable(filter.value);
    switch (filter.operator) {
      case "eq": return actual === expected;
      case "ne": return actual !== expected;
      case "contains": return actual !== null && expected !== null && String(actual).includes(String(expected));
      case "notContains": return actual === null || expected === null || !String(actual).includes(String(expected));
      case "in": return Array.isArray(filter.value) && filter.value.some(item => comparable(item) === actual);
      case "gt": return actual !== null && expected !== null && comparison(value, filter.value) > 0;
      case "gte": return actual !== null && expected !== null && comparison(value, filter.value) >= 0;
      case "lt": return actual !== null && expected !== null && comparison(value, filter.value) < 0;
      case "lte": return actual !== null && expected !== null && comparison(value, filter.value) <= 0;
      // Unknown membership is never Base and never satisfies a tier threshold.
      case "tierAtLeast": return !!loyaltyTier(value) && !!loyaltyTier(filter.value) && loyaltyRank(value) >= loyaltyRank(filter.value);
      case "tierAtMost": return !!loyaltyTier(value) && !!loyaltyTier(filter.value) && loyaltyRank(value) <= loyaltyRank(filter.value);
      default: return false;
    }
  };
  return filter.operator === "ne" || filter.operator === "notContains" ? values.every(one) : values.some(one);
}

function aggregateRows(rows: unknown[], query: AskNativeQuery) {
  if (!query.aggregate || query.aggregate === "count") return rows.length;
  const values = rows.flatMap(row => {
    const value = askNativeValue(row, query.aggregatePath || "");
    return Array.isArray(value) ? value : [value];
  });
  if (query.aggregate === "distinct") return [...new Map(values.filter(value => value !== undefined).map(value => [JSON.stringify(value), value])).values()];
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numbers.length) return null;
  if (query.aggregate === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (query.aggregate === "average") return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return numbers.reduce((a, b) => query.aggregate === "min" ? Math.min(a, b) : Math.max(a, b));
}

export function queryAskNativeSnapshot(snapshot: unknown, query: AskNativeQuery = {}) {
  const selected = askNativeValue(snapshot, query.path || "");
  if (selected === undefined) throw new Error("The requested field is not present in this CMPRI response. Inspect its available fields first.");
  const input = Array.isArray(selected) ? selected : [selected];
  const filters = query.filters || [];
  const matched = filters.length ? input.filter(row => query.match === "any"
    ? filters.some(filter => askNativeMatches(row, filter)) : filters.every(filter => askNativeMatches(row, filter))) : [...input];
  if (query.sort?.length) matched.sort((left, right) => {
    for (const sort of query.sort || []) {
      const a = askNativeValue(left, sort.path), b = askNativeValue(right, sort.path);
      const leftMissing = sort.type === "bonvoy" ? !loyaltyTier(a) : comparable(a) === null;
      const rightMissing = sort.type === "bonvoy" ? !loyaltyTier(b) : comparable(b) === null;
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      const compared = sort.type === "bonvoy" ? loyaltyRank(a) - loyaltyRank(b) : comparison(a, b);
      if (compared) return sort.direction === "desc" ? -compared : compared;
    }
    return 0;
  });
  const offset = Math.max(0, Math.trunc(query.offset || 0));
  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit || 50)));
  const page = matched.slice(offset, offset + limit);
  const groups = query.groupBy ? [...matched.reduce((map, row) => {
    const value = askNativeValue(row, query.groupBy), key = JSON.stringify(value ?? null);
    const group = map.get(key) || { value: value ?? null, rows: [] as unknown[] };
    group.rows.push(row); map.set(key, group); return map;
  }, new Map<string, { value: unknown; rows: unknown[] }>()).values()].map(group => ({ group: group.value, count: group.rows.length, value: aggregateRows(group.rows, query) })) : undefined;
  const rows = query.fields?.length ? page.map(row => Object.fromEntries(query.fields!.map(field => [field, askNativeValue(row, field) ?? null]))) : page;
  return {
    inputCount: input.length, matchedCount: matched.length, returnedCount: rows.length,
    offset, nextOffset: offset + rows.length < matched.length ? offset + rows.length : null,
    rows, ...(query.aggregate ? { aggregate: aggregateRows(matched, query) } : {}), ...(groups ? { groups } : {}),
    countingScope: "Counts describe this authorized native response before display pagination; honor the source API's own coverage and pagination metadata.",
  };
}

/** Join authorized snapshots without asking the model to guess matches. */
export function joinAskNativeRows(left: unknown[], right: unknown[], leftKey: string, rightKey: string, kind: "left" | "inner" = "inner") {
  const index = new Map<string, unknown[]>();
  const joinKey = (value: unknown) => {
    const normalized = comparable(value);
    return normalized === null ? null : String(normalized).replace(/^room\s+/i, "");
  };
  for (const row of right) {
    const key = joinKey(askNativeValue(row, rightKey));
    if (key !== null) index.set(key, [...(index.get(key) || []), row]);
  }
  return left.flatMap(row => {
    const key = joinKey(askNativeValue(row, leftKey));
    const matches = key === null ? [] : index.get(key) || [];
    return matches.length ? matches.map(match => ({ left: row, right: match })) : kind === "left" ? [{ left: row, right: null }] : [];
  });
}

export function describeAskNativeSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 3) return Array.isArray(value) ? { type: "array", count: value.length } : { type: typeof value };
  if (Array.isArray(value)) return { type: "array", count: value.length, sample: value.slice(0, 2).map(item => describeAskNativeSnapshot(item, depth + 1)) };
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, describeAskNativeSnapshot(item, depth + 1)]));
  return typeof value === "string" && value.length > 1200 ? value.slice(0, 1200) + " [more text available through the query tool]" : value;
}
