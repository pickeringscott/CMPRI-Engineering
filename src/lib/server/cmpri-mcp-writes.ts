import "server-only";

import { NextRequest } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { normalizeMcpFeedbackInput, normalizeMcpWorkOrderUpdate } from "@/lib/ai/mcp-write-input";
import { prepareMcpPoolLogInput } from "@/lib/pool-log";
import { allows, type Capability } from "@/lib/server/access";
import type { McpIdentity } from "@/lib/server/cmpri-mcp";
import { roleKey } from "@/lib/server/roles";

type WriteAction = {
  action: string;
  description: string;
  capability?: Capability;
  anyOf?: Capability[];
  systemAdminOnly?: boolean;
};

const WRITE_ACTIONS: WriteAction[] = [
  { action: "work_orders.create", description: "Submit one or more CMPRI work orders, using the same validation and attribution as the CMPRI form.", capability: "submit" },
  { action: "work_orders.import", description: "Import validated CMPRI work orders from SafetyCulture or a spreadsheet.", capability: "edit_tickets" },
  { action: "room_operations.import", description: "Import a daily room-operations snapshot from CSV text or room-status/departures photos without manual steps. Supply report_date (YYYY-MM-DD, defaults to today) and either csv (the raw CSV text containing room rows) or rows array with room, stay_nights, reserved, checkout_date, checkout_time, room_status, arrival_date, arrival_time, guest_name, room_type, guest_code, and guest_arrival_date. Replaces the complete snapshot for that date atomically and automatically triggers Out of Order status and room move notifications. Only call when the user explicitly asks to import/save.", capability: "edit_tickets" },
  { action: "work_orders.update", description: "Edit an authorized work order by supplying its UUID as id, expected_revision from the latest work-order read, and editable fields. Fields may be flat or nested under changes, updates, or fields. Editable fields include notes, status, technician_name (assignment), category, issue, priority, asset_id, cost, hours, due_by, parts, and action_root_cause. Use the exact status 'In Progress' or 'Completed' when reopening a closed work order; reopening to Open is rejected. An In Progress order must have an assigned technician.", anyOf: ["edit_tickets", "review_tickets"] },
  { action: "work_orders.delete", description: "Delete a work order when your CMPRI role permits it. Include its UUID.", anyOf: ["edit_tickets", "close_tickets", "manage_users"] },
  { action: "work_order_drafts.create", description: "Create a CMPRI work-order draft.", capability: "submit" },
  { action: "work_order_drafts.update", description: "Update your CMPRI work-order draft using its current revision.", capability: "submit" },
  { action: "work_order_drafts.delete", description: "Delete a draft allowed by CMPRI draft ownership and supervisory policy.", capability: "submit" },
  { action: "assets.create", description: "Create equipment under CMPRI equipment-management validation.", capability: "manage_assets" },
  { action: "assets.update", description: "Update equipment under CMPRI equipment-management validation.", capability: "manage_assets" },
  { action: "engineering_catalog.create", description: "Create a supported CMPRI engineering catalog record.", capability: "manage_assets" },
  { action: "engineering_catalog.update", description: "Update a supported CMPRI engineering catalog record.", capability: "manage_assets" },
  { action: "engineering_operations.update", description: "Update a permitted CMPRI purchase or shipment operation.", capability: "operate_integrations" },
  { action: "integrations.email.scan", description: "Run the authorized mailbox scan and import eligible operational records into CMPRI.", capability: "operate_integrations" },
  { action: "integrations.room_ranker.sync", description: "Run the authorized CMPRI room-ranker synchronization.", capability: "operate_integrations", systemAdminOnly: true },
  { action: "room_ranker.update", description: "Update a supported CMPRI room-ranker record.", capability: "operate_integrations", systemAdminOnly: true },
  { action: "corporate_pm.update", description: "Write an allowed verified cell through CMPRI's Corporate PM integration.", capability: "operate_integrations", systemAdminOnly: true },
  { action: "pool_log.save", description: "Save pool readings. Required: date (YYYY-MM-DD, use the date from the pool read) and pool (exact active pool name such as Indoor Pool, or its id from the pool read). One water sample is taken per AM or PM test: every save must include that sample's pH (ph_am/ph_pm), bromine range (sanitizer_band_am/sanitizer_band_pm: 0, 1-2, 2-4, 3-6, 5-10, 7.5-15, 10-20), and where it was taken (sample_location_am/sample_location_pm: shallow or deep; sample_location applies to the sample in this save). CMPRI records the same reading for both shallow and deep. Daily checks are recorded once per day: temperature_f, flow_rate_gpm, main_drain_visible (true/false), and filter_backwashed (true/false). Before saving, read the log: read.status.daily_checks_missing lists any daily check still needed—ask the user for each one and include it; if none are missing, they may be omitted. Keep asking until every required value is provided before calling save. Saving the PM sample later adds it to the same day's log and never erases saved AM readings; do not resend values you did not collect. Only System Administrators can change a value that is already saved. Out-of-range readings (pH outside 7.2–7.8, bromine 0, 1–2, 7.5–15 or 10–20 ppm, main drain not visible, water above 104°F) mean the pool MUST BE CLOSED: tell the user clearly, and include closure_reason describing why it is closed and what was done. The response lists closure_reasons and warnings (such as flow below the required 48 GPM); always read them back to the user. requires_attention and closure_condition are optional true/false values. Chlorine and cyanuric-acid readings are not used. expected_revision is not needed. For an explicitly requested test entry, set test_entry: true; CMPRI adds 'Test entry' to remarks, but the sample and daily checks are still required. The pool name is resolved to the active facility id before saving.", capability: "operate_integrations" },
  { action: "feedback.submit", description: "Submit feedback to CMPRI. Provide feedback_type as Problem, Bug, or Suggestion and description. page_route is optional; if supplied it must be a site path starting with /. The MCP connection records /mcp when no valid site path is provided. Feedback type matching is case-insensitive.", capability: "submit_feedback" },
  { action: "feedback.review", description: "Review or update CMPRI feedback when permitted.", capability: "review_feedback" },
  { action: "feedback.delete", description: "Delete CMPRI feedback when permitted.", capability: "review_feedback" },
  { action: "profile.update", description: "Update your own CMPRI profile preferences or display name.", },
  { action: "users.create", description: "Create a CMPRI user under the current account-management policy.", capability: "manage_users" },
  { action: "users.update", description: "Update a CMPRI user under the current account-management policy.", capability: "manage_users" },
  { action: "users.delete", description: "Delete a CMPRI user under the current account-management policy.", capability: "manage_users" },
  { action: "rooms.update", description: "Update a CMPRI room or location.", capability: "manage_rooms" },
  { action: "enseo_assignments.update", description: "Update a validated batch of CMPRI Enseo assignments.", capability: "manage_assets" },
];

function actionAllowed(identity: McpIdentity, action: WriteAction) {
  if (action.systemAdminOnly && roleKey(identity.principal.profile.role) !== "system_admin") return false;
  if (!action.capability && !action.anyOf) return true;
  if (action.capability) return allows(identity.principal, action.capability);
  return action.anyOf?.some((capability) => allows(identity.principal, capability)) ?? false;
}

export function availableMcpWriteActions(identity: McpIdentity) {
  return identity.canWrite ? WRITE_ACTIONS.filter((action) => actionAllowed(identity, action)) : [];
}

type Handler = (request: NextRequest) => Promise<Response>;

async function callApi(
  incoming: NextRequest,
  pathname: string,
  method: string,
  accessToken: string,
  input: Record<string, unknown>,
  handler: Handler,
) {
  const request = new NextRequest(new URL(pathname, incoming.nextUrl.origin), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(input) }),
  });
  const response = await handler(request);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export async function callMcpWriteAction(
  incoming: NextRequest,
  identity: McpIdentity,
  actionName: string,
  input: Record<string, unknown>,
) {
  if (!identity.canWrite) throw new Error("This ChatGPT connection has read-only access. Reconnect and approve read-and-write access.");
  const action = availableMcpWriteActions(identity).find((candidate) => candidate.action === actionName);
  if (!action) throw new Error("This action is not permitted for your current CMPRI role and permissions.");
  const bearer = incoming.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!bearer) throw new Error("The CMPRI authorization is missing.");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const withId = (base: string) => {
    if (!id || id.length > 120 || id.includes("/") || id === "." || id === "..") {
      throw new Error("A valid CMPRI record id is required for this action.");
    }
    return `${base}/${encodeURIComponent(id)}`;
  };

  switch (actionName) {
    case "work_orders.create": {
      const route = await import("@/app/api/work-orders/route");
      return callApi(incoming, "/api/work-orders", "POST", bearer, input, route.POST);
    }
    case "work_orders.import": {
      const route = await import("@/app/api/work-orders/import/route");
      return callApi(incoming, "/api/work-orders/import", "POST", bearer, input, route.POST);
    }
    case "room_operations.import": {
      const route = await import("@/app/api/room-operations/route");
      return callApi(incoming, "/api/room-operations", "POST", bearer, input, route.POST);
    }
    case "work_orders.update": {
      const route = await import("@/app/api/work-orders/[id]/route");
      const path = withId("/api/work-orders");
      const payload = normalizeMcpWorkOrderUpdate(input);
      return callApi(incoming, path, "PATCH", bearer, payload, (request) => route.PATCH(request, { params: Promise.resolve({ id }) }));
    }
    case "work_orders.delete": {
      const route = await import("@/app/api/work-orders/[id]/route");
      const path = withId("/api/work-orders");
      return callApi(incoming, path, "DELETE", bearer, input, (request) => route.DELETE(request, { params: Promise.resolve({ id }) }));
    }
    case "work_order_drafts.create":
    case "work_order_drafts.update":
    case "work_order_drafts.delete": {
      const route = await import("@/app/api/work-orders/drafts/route");
      const method = actionName.endsWith(".create") ? "POST" : actionName.endsWith(".update") ? "PATCH" : "DELETE";
      const handler = method === "POST" ? route.POST : method === "PATCH" ? route.PATCH : route.DELETE;
      const path = method === "DELETE" ? `/api/work-orders/drafts?id=${encodeURIComponent(id)}` : "/api/work-orders/drafts";
      return callApi(incoming, path, method, bearer, input, handler);
    }
    case "assets.create":
    case "assets.update": {
      const route = await import("@/app/api/assets/route");
      return callApi(incoming, "/api/assets", actionName.endsWith(".create") ? "POST" : "PATCH", bearer, input, actionName.endsWith(".create") ? route.POST : route.PATCH);
    }
    case "engineering_catalog.create":
    case "engineering_catalog.update": {
      const route = await import("@/app/api/engineering/catalog/route");
      return callApi(incoming, "/api/engineering/catalog", actionName.endsWith(".create") ? "POST" : "PATCH", bearer, input, actionName.endsWith(".create") ? route.POST : route.PATCH);
    }
    case "engineering_operations.update": {
      const route = await import("@/app/api/engineering/operations/route");
      return callApi(incoming, "/api/engineering/operations", "PATCH", bearer, input, route.PATCH);
    }
    case "integrations.email.scan": {
      const route = await import("@/app/api/integrations/email/scan/route");
      return callApi(incoming, "/api/integrations/email/scan", "POST", bearer, input, route.POST);
    }
    case "integrations.room_ranker.sync": {
      const route = await import("@/app/api/integrations/room-ranker/sync/route");
      return callApi(incoming, "/api/integrations/room-ranker/sync", "POST", bearer, input, route.POST);
    }
    case "room_ranker.update": {
      const route = await import("@/app/api/room-ranker/route");
      return callApi(incoming, "/api/room-ranker", "PATCH", bearer, input, route.PATCH);
    }
    case "corporate_pm.update": {
      const route = await import("@/app/api/corporate-pm/route");
      return callApi(incoming, "/api/corporate-pm", "PATCH", bearer, input, route.PATCH);
    }
    case "pool_log.save": {
      const { data: facilities, error } = await identity.admin.from("pool_facilities")
        .select("id, pool_name, facility_name")
        .eq("hotel_id", HOTEL_ID)
        .eq("active", true);
      if (error) throw new Error("Active pool facilities could not be loaded. Nothing was saved.");
      const payload = prepareMcpPoolLogInput(input, facilities || []);
      const route = await import("@/app/api/pool-log/route");
      return callApi(incoming, "/api/pool-log", "POST", bearer, payload, route.POST);
    }
    case "feedback.submit":
    case "feedback.review":
    case "feedback.delete": {
      const route = await import("@/app/api/feedback/route");
      const method = actionName.endsWith(".submit") ? "POST" : actionName.endsWith(".review") ? "PATCH" : "DELETE";
      const handler = method === "POST" ? route.POST : method === "PATCH" ? route.PATCH : route.DELETE;
      const path = method === "DELETE" ? `/api/feedback?id=${encodeURIComponent(id)}` : "/api/feedback";
      const payload = actionName === "feedback.submit" ? normalizeMcpFeedbackInput(input) : input;
      return callApi(incoming, path, method, bearer, payload, handler);
    }
    case "profile.update": {
      const route = await import("@/app/api/profile/route");
      return callApi(incoming, "/api/profile", "PATCH", bearer, input, route.PATCH);
    }
    case "users.create":
    case "users.update":
    case "users.delete": {
      const route = await import("@/app/api/users/route");
      const method = actionName.endsWith(".create") ? "POST" : actionName.endsWith(".update") ? "PATCH" : "DELETE";
      const handler = method === "POST" ? route.POST : method === "PATCH" ? route.PATCH : route.DELETE;
      return callApi(incoming, "/api/users", method, bearer, input, handler);
    }
    case "rooms.update": {
      const route = await import("@/app/api/rooms/route");
      return callApi(incoming, "/api/rooms", "PATCH", bearer, input, route.PATCH);
    }
    case "enseo_assignments.update": {
      const route = await import("@/app/api/enseo/assignments/route");
      return callApi(incoming, "/api/enseo/assignments", "PATCH", bearer, input, route.PATCH);
    }
    default:
      throw new Error("This CMPRI write action is not supported.");
  }
}
