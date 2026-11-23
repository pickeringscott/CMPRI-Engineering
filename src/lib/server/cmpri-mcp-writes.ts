import { CMPRI_WRITE_ACTION_GUIDANCE } from "@/lib/ai/cmpri-operation-guidance";
import { canUseHoursMcp, saveHoursMcp } from './hours-tracker-mcp';
import "server-only";
import { hoursClockEnabled } from "@/lib/server/hours-clock-policy";

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
  { action: "hours_tracker.save_period", description: CMPRI_WRITE_ACTION_GUIDANCE["hours_tracker.save_period"] },
  { action: "hours_tracker.clock_in", description: CMPRI_WRITE_ACTION_GUIDANCE["hours_tracker.clock_in"] },
  { action: "hours_tracker.clock_out", description: CMPRI_WRITE_ACTION_GUIDANCE["hours_tracker.clock_out"] },
  { action: "work_orders.create", description: CMPRI_WRITE_ACTION_GUIDANCE["work_orders.create"], capability: "submit" },
  { action: "work_orders.import", description: CMPRI_WRITE_ACTION_GUIDANCE["work_orders.import"], capability: "edit_tickets" },
  { action: "room_operations.import", description: CMPRI_WRITE_ACTION_GUIDANCE["room_operations.import"], capability: "edit_tickets" },
  { action: "work_orders.update", description: CMPRI_WRITE_ACTION_GUIDANCE["work_orders.update"], anyOf: ["edit_tickets", "review_tickets"] },
  { action: "work_orders.delete", description: CMPRI_WRITE_ACTION_GUIDANCE["work_orders.delete"], anyOf: ["review_tickets", "close_tickets"] },
  { action: "work_order_drafts.update", description: CMPRI_WRITE_ACTION_GUIDANCE["work_order_drafts.update"], capability: "submit" },
  { action: "work_order_drafts.delete", description: CMPRI_WRITE_ACTION_GUIDANCE["work_order_drafts.delete"], capability: "submit" },
  { action: "assets.create", description: CMPRI_WRITE_ACTION_GUIDANCE["assets.create"], capability: "manage_assets" },
  { action: "assets.update", description: CMPRI_WRITE_ACTION_GUIDANCE["assets.update"], capability: "manage_assets" },
  { action: "engineering_catalog.create", description: CMPRI_WRITE_ACTION_GUIDANCE["engineering_catalog.create"], capability: "manage_assets" },
  { action: "engineering_catalog.update", description: CMPRI_WRITE_ACTION_GUIDANCE["engineering_catalog.update"], capability: "manage_assets" },
  { action: "engineering_operations.update", description: CMPRI_WRITE_ACTION_GUIDANCE["engineering_operations.update"], capability: "operate_integrations" },
  { action: "integrations.email.scan", description: CMPRI_WRITE_ACTION_GUIDANCE["integrations.email.scan"], capability: "operate_integrations" },
  { action: "corporate_pm.update", description: CMPRI_WRITE_ACTION_GUIDANCE["corporate_pm.update"], capability: "operate_integrations", systemAdminOnly: true },
  { action: "pool_log.save", description: CMPRI_WRITE_ACTION_GUIDANCE["pool_log.save"], capability: "operate_pool_log" },
  { action: "feedback.submit", description: CMPRI_WRITE_ACTION_GUIDANCE["feedback.submit"], capability: "submit_feedback" },
  { action: "feedback.review", description: CMPRI_WRITE_ACTION_GUIDANCE["feedback.review"], capability: "review_feedback" },
  { action: "feedback.delete", description: CMPRI_WRITE_ACTION_GUIDANCE["feedback.delete"], capability: "review_feedback" },
  { action: "profile.update", description: CMPRI_WRITE_ACTION_GUIDANCE["profile.update"], },
  { action: "users.create", description: CMPRI_WRITE_ACTION_GUIDANCE["users.create"], capability: "manage_users" },
  { action: "users.update", description: CMPRI_WRITE_ACTION_GUIDANCE["users.update"], capability: "manage_users" },
  { action: "rooms.update", description: CMPRI_WRITE_ACTION_GUIDANCE["rooms.update"], capability: "manage_rooms" },
  { action: "enseo_assignments.update", description: CMPRI_WRITE_ACTION_GUIDANCE["enseo_assignments.update"], capability: "manage_assets" },
];

function actionAllowed(identity: McpIdentity, action: WriteAction) {
  if (action.action === "hours_tracker.save_period") return canUseHoursMcp(identity);
  if (action.action.startsWith("hours_tracker.")) return hoursClockEnabled(identity.principal);
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
    case "hours_tracker.save_period": return { status: 200, body: await saveHoursMcp(identity, input) };
    case "hours_tracker.clock_in":
    case "hours_tracker.clock_out": {
      if ("action" in input) throw new Error("Do not override the clock action.");
      const route = await import("@/app/api/hours-tracker/clock/route");
      return callApi(incoming, "/api/hours-tracker/clock", "POST", bearer, { ...input, action: actionName.endsWith("clock_in") ? "clock_in" : "clock_out" }, route.POST);
    }
    case "work_orders.create": {
      const route = await import("@/app/api/work-orders/route");
      return callApi(incoming, "/api/work-orders", "POST", bearer, input, route.POST);
    }
    case "work_orders.import": {
      const route = await import("@/app/api/work-orders/import/route");
      return callApi(incoming, "/api/work-orders/import", "POST", bearer, input, route.POST);
    }
    case "room_operations.import": {
      if (input.source === "drive") {
        const { runDriveRoomReportImport } = await import("@/lib/server/drive-room-report-import");
        const drive = await import("@/app/api/room-operations/guest-reports/drive/route");
        const reports = await import("@/app/api/room-operations/guest-reports/route");
        return runDriveRoomReportImport(input,
          () => callApi(incoming, "/api/room-operations/guest-reports/drive", "GET", bearer, {}, drive.GET),
          (body) => callApi(incoming, "/api/room-operations/guest-reports", "POST", bearer, body, reports.POST));
      }
      if (Object.hasOwn(input, "images")) {
        throw new Error("Read the supplied photos in ChatGPT and submit verified report_data. Server-side image extraction is not supported by this connected import. Read room_operations for the import contract; validate_only: true checks without saving.");
      }
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
    case "work_order_drafts.update":
    case "work_order_drafts.delete": {
      const route = await import("@/app/api/work-orders/drafts/route");
      const method = actionName.endsWith(".update") ? "PATCH" : "DELETE";
      const handler = method === "PATCH" ? route.PATCH : route.DELETE;
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
      const method = actionName.endsWith(".update") ? "PATCH" : "DELETE";
      const handler = method === "PATCH" ? route.PATCH : route.DELETE;
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
