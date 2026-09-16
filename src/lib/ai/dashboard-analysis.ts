export const DASHBOARD_AI_ACTION = "refresh-engineering-dashboard";
export const MAX_AI_WORK_ORDERS = 20;

export type DashboardAISummary = { id: string; display_id: string; room: string; summary: string };
type SavedOrder = Record<string, unknown>;
type AnalysisDependencies<T> = {
  authenticate: () => Promise<T | null>;
  readSavedOrders: (context: T) => Promise<SavedOrder[]>;
  generate: (orders: SavedOrder[]) => Promise<string>;
};

const inactiveStatuses = new Set(["pending verification", "completed", "will not do", "duplicate", "closed", "cancelled", "canceled"]);
const text = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : "";

// This service accepts an explicit action, never draft issue/notes or a stored
// refresh token. Provider input comes exclusively from authenticated DB reads.
export async function refreshDashboardAnalysis<T>(body: unknown, dependencies: AnalysisDependencies<T>) {
  const context = await dependencies.authenticate();
  if (!context) return { status: 401, body: { error: "Unauthorized" } };
  if (!body || typeof body !== "object" || !("action" in body) || body.action !== DASHBOARD_AI_ACTION) {
    return { status: 400, body: { error: "Use Refresh AI on the Engineering Dashboard." } };
  }
  const savedOrders = await dependencies.readSavedOrders(context);
  const candidates = savedOrders.filter((order) =>
    typeof order.id === "string" && order.id &&
    !inactiveStatuses.has(text(order.status, 100).toLowerCase()) &&
    (text(order.issue, 1500) || text(order.notes, 2500))
  );
  const orders = candidates.slice(0, MAX_AI_WORK_ORDERS).map((order) => ({
    id: text(order.id, 100), display_id: text(order.display_id, 100),
    room: text(order.room, 100), asset_name: text(order.asset_name, 200),
    status: text(order.status, 100), priority: text(order.priority, 100),
    issue: text(order.issue, 1500), notes: text(order.notes, 2500),
  }));
  const limited = savedOrders.length > MAX_AI_WORK_ORDERS;
  if (!orders.length) return { status: 200, body: { ok: true, summaries: [], limited, generated_at: null } };

  const parsed: unknown = JSON.parse(await dependencies.generate(orders));
  if (!parsed || typeof parsed !== "object" || !("summaries" in parsed) || !Array.isArray(parsed.summaries)) {
    throw new Error("AI returned an invalid summary response.");
  }
  const byId = new Map<string, string>();
  const allowedIds = new Set(orders.map((order) => order.id));
  for (const item of parsed.summaries) {
    if (!item || typeof item.id !== "string" || !allowedIds.has(item.id) || byId.has(item.id) ||
      typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > 2000) {
      throw new Error("AI returned an invalid work-order summary.");
    }
    byId.set(item.id, item.summary.trim());
  }
  if (byId.size !== orders.length) throw new Error("AI did not summarize every requested work order.");
  const summaries: DashboardAISummary[] = orders.map((order) => ({
    id: order.id, display_id: order.display_id, room: order.room, summary: byId.get(order.id)!,
  }));
  return { status: 200, body: { ok: true, summaries, limited, generated_at: new Date().toISOString() } };
}
