import { workOrderReferenceMatches } from "./work-order-reference.js";

const TEXT_FIELDS = ["display_id", "room", "issue", "asset_name", "category", "technician_name", "priority", "notes"] as const;
const STATUSES = ["Open", "In Progress", "Completed", "Done", "Pending Verification", "Closed", "Will Not Do"];

/** One to three digits are room numbers. Use WO# for a short ticket reference. */
export function workOrderSearch(query: string) {
  const value = query.trim();
  const room = value.match(/^room\s*#?\s*(\d+[a-z]?)$/i)?.[1]
    ?? value.match(/^(\d{1,3}[a-z]?)$/i)?.[1];
  if (room) return { kind: "room" as const, value: room.toLowerCase() };
  const reference = value.match(/^@?(?:(?:workorder_|WO\s*[#-]?\s*|work\s+order\s*#?\s*|#))?(\d+)$/i)?.[1];
  if (reference) return { kind: "reference" as const, value: reference };
  return { kind: "text" as const, value: value.toLowerCase() };
}

/** Match local fallback rows and unsaved drafts using the same room semantics as the API. */
export function matchesWorkOrderSearch(order: Record<string, unknown>, query: string) {
  const search = workOrderSearch(query);
  if (!search.value) return true;
  if (search.kind === "room") return String(order.room ?? "").trim().replace(/^room\s*#?\s*/i, "").toLowerCase() === search.value;
  if (search.kind === "reference") return workOrderReferenceMatches(order.display_id, search.value);
  return [...TEXT_FIELDS, "status"].some(field => String(order[field] ?? "").toLowerCase().includes(search.value));
}

/** Quoted PostgREST expressions preserve the separate hotel/reader/status predicates. */
export function workOrderSearchExpression(query: string) {
  const search = workOrderSearch(query);
  if (!search.value) return "";
  if (search.kind === "room") return [search.value, `Room ${search.value}`, `Room #${search.value}`, `Room#${search.value}`, `Room${search.value}`]
    .map(value => `room.ilike.${JSON.stringify(value)}`).join(",");
  if (search.kind === "reference") return `display_id.ilike.${JSON.stringify(`%${search.value}%`)}`;
  const pattern = JSON.stringify(`%${query.trim().replace(/[%_\\]/g, "\\$&")}%`);
  const expressions = TEXT_FIELDS.map(field => `${field}.ilike.${pattern}`);
  // status is a PostgreSQL enum, so it cannot use ILIKE directly.
  const statuses = STATUSES.filter(status => status.toLowerCase().includes(search.value));
  if (statuses.length) expressions.push(`status.in.(${statuses.map(status => JSON.stringify(status)).join(",")})`);
  return expressions.join(",");
}
