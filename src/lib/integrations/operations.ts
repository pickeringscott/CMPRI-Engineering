/** Shared, deterministic rules used by both manual updates and email ingestion. */
export const PURCHASE_STATUSES = ["Ordered", "Processing", "Backordered", "Partially Shipped", "Shipped", "In Transit", "Delivered", "Partially Received", "Received", "Installed / Used", "Complete", "Cancelled"];
export const SHIPMENT_STATUSES = ["Shipped", "In Transit", "Delivered", "Received", "Problem"];

export function mergedPurchaseStatus(existing?: string | null, incoming?: string | null) {
  const oldValue = String(existing || "").trim();
  const newValue = String(incoming || "").trim();
  if (!newValue) return oldValue || "Ordered";
  if (/^(cancelled|installed \/ used|complete)$/i.test(oldValue)) return oldValue;
  if (/^cancelled$/i.test(newValue)) return "Cancelled";
  const rank = (value: string) => PURCHASE_STATUSES.findIndex(status => status.toLowerCase() === value.toLowerCase());
  return rank(newValue) >= rank(oldValue) ? newValue : oldValue;
}

export function parentStatusFromShipments(statuses: string[], current: string) {
  if (/^(cancelled|installed \/ used|complete)$/i.test(current)) return current;
  const values = statuses.map(value => String(value || "").toLowerCase());
  if (!values.length) return current;
  // Known tracking numbers do not establish that every ordered item has arrived.
  // Only a manual order-level confirmation can establish full receipt.
  if (values.every(value => value === "received")) return current === "Received" ? "Received" : "Partially Received";
  if (values.some(value => value === "received")) return "Partially Received";
  if (values.every(value => value === "delivered")) return "Delivered";
  if (values.every(value => ["shipped", "in transit"].includes(value))) return values.includes("in transit") ? "In Transit" : "Shipped";
  if (values.some(value => ["shipped", "in transit", "delivered"].includes(value))) return "Partially Shipped";
  return current;
}

type WorkOrderCandidate = { id: string; room?: string | null; issue?: string | null; status?: string | null };
export function matchEnseoWorkOrder(rows: WorkOrderCandidate[], roomNumber?: string, endpoint?: string) {
  if (!roomNumber) return null;
  const matches = rows.filter(row => {
    if (/^(closed|completed?|duplicate|will not do|cancelled|canceled)$/i.test(row.status || "")) return false;
    if (String(row.room || "").match(/\b\d{3}(?=[AB]?\b)/i)?.[0] !== roomNumber) return false;
    const issue = String(row.issue || "");
    if (!/\b(enseo|stb|set[- ]?top|tv|television)\b/i.test(issue)) return false;
    const explicitEndpoint = `${row.room || ""} ${issue}`.match(/\b\d{3}[AB]\b/i)?.[0]?.toUpperCase();
    return !endpoint || !explicitEndpoint || explicitEndpoint === endpoint;
  });
  return matches.length === 1 ? matches[0].id : null;
}
