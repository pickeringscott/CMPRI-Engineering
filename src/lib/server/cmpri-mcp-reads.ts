import "server-only";

import { NextRequest } from "next/server";
import { allows } from "@/lib/server/access";
import type { McpIdentity } from "@/lib/server/cmpri-mcp";
import { canViewRoomRanker } from "@/lib/room-ranker-access";
import { roleKey } from "@/lib/server/roles";

const DASHBOARD_VIEWS = [
  "work_orders",
  "rooms",
  "room_operations",
  "purchasing",
  "corporate_pm",
  "pool_log",
  "maintenance_reference",
] as const;

const READ_VIEW_CAPABILITIES = {
  equipment: "manage_assets",
  asset_documentation: "manage_assets",
  engineering_catalog: "manage_assets",
  enseo_assignments: "manage_assets",
  work_order_drafts: "submit",
  feedback: "review_feedback",
  users: "manage_users",
} as const;

export function availableMcpReadViews(identity: McpIdentity) {
  const views = [
    ...(identity.readAllWorkOrders ? DASHBOARD_VIEWS : []),
    ...(canViewRoomRanker(identity.principal) ? ["room_ranker"] as const : []),
    ...(identity.readAllWorkOrders || identity.readAssignedWorkOrders || identity.readOwnWorkOrders
      ? ["work_order", "work_order_activity", "work_order_attachments"] as const
      : []),
    ...Object.entries(READ_VIEW_CAPABILITIES)
      .filter(([, capability]) => allows(identity.principal, capability))
      .map(([view]) => view),
  ];
  return views;
}

type RouteHandler = (request: NextRequest) => Promise<Response | undefined>;

async function callGet(
  incoming: NextRequest,
  pathname: string,
  handler: RouteHandler,
) {
  const bearer = incoming.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!bearer) throw new Error("The CMPRI authorization is missing.");
  const request = new NextRequest(new URL(pathname, incoming.nextUrl.origin), {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const response = await handler(request);
  if (!response) throw new Error("CMPRI read did not return a response.");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`CMPRI read returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `CMPRI read failed (${response.status}).`;
    throw new Error(message);
  }
  return body;
}

function argument(args: Record<string, unknown>, name: string, maximum = 200) {
  const value = args[name];
  if (value === undefined) return "";
  if (typeof value !== "string" || value.trim().length > maximum) {
    throw new Error(`Invalid ${name}.`);
  }
  return value.trim();
}

function recordId(args: Record<string, unknown>) {
  const id = argument(args, "id", 120);
  if (!id || id.includes("/") || id === "." || id === "..") {
    throw new Error("A valid CMPRI record id is required for this view.");
  }
  return id;
}

export async function callMcpReadView(
  incoming: NextRequest,
  identity: McpIdentity,
  view: string,
  args: Record<string, unknown>,
) {
  if (!availableMcpReadViews(identity).includes(view)) {
    throw new Error("This read view is not permitted for your current CMPRI role and permissions.");
  }

  switch (view) {
    case "work_orders": {
      const route = await import("@/app/api/work-orders/route");
      return callGet(incoming, "/api/work-orders", route.GET);
    }
    case "work_order": {
      const id = recordId(args);
      const route = await import("@/app/api/work-orders/[id]/route");
      return callGet(incoming, `/api/work-orders/${encodeURIComponent(id)}`, (request) =>
        route.GET(request, { params: Promise.resolve({ id }) }));
    }
    case "work_order_activity": {
      const id = recordId(args);
      const route = await import("@/app/api/work-orders/[id]/activity/route");
      return callGet(incoming, `/api/work-orders/${encodeURIComponent(id)}/activity`, (request) =>
        route.GET(request, { params: Promise.resolve({ id }) }));
    }
    case "work_order_attachments": {
      const id = recordId(args);
      const route = await import("@/app/api/work-orders/[id]/attachments/route");
      return callGet(incoming, `/api/work-orders/${encodeURIComponent(id)}/attachments`, (request) =>
        route.GET(request, { params: Promise.resolve({ id }) }));
    }
    case "work_order_drafts": {
      const route = await import("@/app/api/work-orders/drafts/route");
      return callGet(incoming, "/api/work-orders/drafts", route.GET);
    }
    case "equipment": {
      const route = await import("@/app/api/assets/route");
      return callGet(incoming, "/api/assets?include_documentation=false", route.GET);
    }
    case "asset_documentation": {
      const assetId = recordId({ id: args.asset_id });
      const route = await import("@/app/api/assets/documentation/route");
      return callGet(incoming, `/api/assets/documentation?asset_id=${encodeURIComponent(assetId)}`, route.GET);
    }
    case "rooms": {
      const route = await import("@/app/api/rooms/route");
      return callGet(incoming, "/api/rooms", route.GET);
    }
    case "room_ranker": {
      const route = await import("@/app/api/room-ranker/route");
      return callGet(incoming, "/api/room-ranker", route.GET);
    }
    case "room_operations": {
      const date = argument(args, "date", 10);
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      const route = await import("@/app/api/room-operations/route");
      return callGet(incoming, `/api/room-operations${query}`, route.GET);
    }
    case "purchasing": {
      const route = await import("@/app/api/engineering/operations/route");
      return callGet(incoming, "/api/engineering/operations", route.GET);
    }
    case "engineering_catalog": {
      const route = await import("@/app/api/engineering/catalog/route");
      return callGet(incoming, "/api/engineering/catalog", route.GET);
    }
    case "corporate_pm": {
      const room = argument(args, "room", 80);
      const sheet = argument(args, "sheet", 80);
      if (room && sheet) throw new Error("Specify either room or sheet, not both.");
      if (!room && roleKey(identity.principal.profile.role) !== "system_admin") {
        throw new Error("A room is required to read daily and weekly PM checks; monthly PM management is restricted to System Administrators.");
      }
      const query = room
        ? `?room=${encodeURIComponent(room)}`
        : sheet
          ? `?sheet=${encodeURIComponent(sheet)}`
          : "";
      const route = await import("@/app/api/corporate-pm/route");
      return callGet(incoming, `/api/corporate-pm${query}`, route.GET);
    }
    case "pool_log": {
      const date = argument(args, "date", 10);
      if (!date) throw new Error("A date in YYYY-MM-DD format is required to read the pool log.");
      const facility = argument(args, "facility", 120);
      const query = new URLSearchParams({ date });
      if (facility) query.set("facility", facility);
      const route = await import("@/app/api/pool-log/route");
      return callGet(incoming, `/api/pool-log?${query.toString()}`, route.GET);
    }
    case "enseo_assignments": {
      const route = await import("@/app/api/enseo/assignments/route");
      return callGet(incoming, "/api/enseo/assignments", route.GET);
    }
    case "feedback": {
      const route = await import("@/app/api/feedback/route");
      return callGet(incoming, "/api/feedback", route.GET);
    }
    case "users": {
      const route = await import("@/app/api/users/route");
      return callGet(incoming, "/api/users", route.GET);
    }
    case "maintenance_reference": {
      const assetId = argument(args, "asset_id", 120);
      const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : "";
      const route = await import("@/app/api/maintenance-reference/route");
      return callGet(incoming, `/api/maintenance-reference${query}`, route.GET);
    }
    default:
      throw new Error("This CMPRI read view is not supported.");
  }
}
