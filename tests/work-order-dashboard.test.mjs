import { ticketReadDependency } from "./helpers/load-ts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { fetchAllPages } from "../src/lib/server/paginated-query.ts";
import { EQUIPMENT_SELECTION_COLUMNS } from "../src/lib/equipment-selection.ts";

const hotelId = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";
const dashboardRows = Array.from({ length: 2501 }, (_, index) => ({
  id: `order-${index}`,
  display_id: `${index}`,
  room: "409",
  status: index % 3 === 0 ? "Closed" : index % 3 === 1 ? "Open" : "In Progress",
}));

function fixture({ failAt, role = "System Administrator", hasDashboard = true } = {}) {
  const ranges = [];
  const projections = [];
  let allowedStatuses = null;
  const admin = {
    from(table) {
      const query = { from: 0, to: 999 };
      query.select = (columns) => { projections.push(columns); return query; };
      query.eq = () => query;
      query.order = () => query;
      query.or = () => { allowedStatuses = ["Open", "In Progress"]; return query; };
      query.in = (_field, values) => { allowedStatuses = values; return query; };
      query.range = (from, to) => {
        query.from = from;
        query.to = to;
        ranges.push([from, to]);
        return query;
      };
      query.then = (resolve, reject) => {
        const result = failAt === query.from
          ? { data: null, error: new Error("page unavailable") }
          : {
            data: table === "work_orders"
              ? dashboardRows.filter((row) => !allowedStatuses || allowedStatuses.includes(row.status)).slice(query.from, query.to + 1)
              : [],
            error: null,
          };
        return Promise.resolve(result).then(resolve, reject);
      };
      return query;
    },
  };
  const principal = { identity: { id: "00000000-0000-4000-8000-000000000001" }, hotelId, profile: { role } };
  const source = readFileSync(new URL("../src/app/api/work-orders/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    process: { env: {} },
    require(name) {
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name, (_principal, capability) => capability === "view_dashboard"
          ? hasDashboard
          : capability === "edit_tickets" || capability === "review_tickets"
            ? role === "System Administrator"
          : capability === "add_work_order_notes"
            ? ["Front Desk", "Housekeeping", "General Manager", "Assistant General Manager", "Front Desk Manager", "Assistant Manager", "Senior Management", "Maintenance Technician", "Engineer", "System Administrator"].includes(role)
          : capability === "view_work_orders");
      if (name === "@/lib/cmpri-location-groups") return { frontDeskCommonArea: () => null };
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === "@supabase/supabase-js") return { createClient: () => admin };
      if (name === "@/lib/constants") return { HOTEL_ID: hotelId };
      if (name === "@/lib/supabase/config") return { SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_URL: "" };
      if (name === "@/lib/server/access") return {
        allows: (_principal, capability) => capability === "view_dashboard"
          ? hasDashboard
          : capability === "edit_tickets" || capability === "review_tickets"
            ? role === "System Administrator"
          : capability === "add_work_order_notes"
            ? ["Front Desk", "Housekeeping", "General Manager", "Assistant General Manager", "Front Desk Manager", "Assistant Manager", "Senior Management", "Maintenance Technician", "Engineer", "System Administrator"].includes(role)
          : capability === "view_work_orders",
      };
      if (name === "@/lib/server/auth") return { requireUser: async () => ({ principal, admin }) };
      if (name === "@/lib/server/request-auth") return { authenticatedUser: async () => null };
      if (name === "@/lib/server/roles") return {
        canSuperviseDraftRole: () => false,
        isFrontDesk: () => false,
        isSubmitOnlyRole: () => false,
        roleAllows: () => false,
        roleKey: (value) => value === "Maintenance Technician" ? "technician" : "unknown",
      };
      if (name === "@/lib/server/supabase-admin") return { createSupabaseAdmin: () => admin };
      if (name === "@/lib/integrations/spreadsheet-input") return { jsonObject: () => ({}) };
      if (name === "@/lib/work-order-attribution") return { validFirstName: () => true, workOrderAttribution: () => ({}) };
      if (name === "@/lib/work-order-duplicates") return { likelyDuplicate: () => false };
      if (name === "@/lib/equipment-selection") return { EQUIPMENT_SELECTION_COLUMNS };
      if (name === "@/lib/work-order-suggestions") return { inferWorkOrder: () => ({}), separateIssueFromReporterNotes: () => ({}), SuggestionAsset: {} };
      if (name === "@/lib/work-order-categories") return { normalizeWorkOrderCategory: (value) => value };
      if (name === "@/lib/server/room-ranker") return { processRoomRankerSyncForWorkOrder: async () => {} };
      if (name === "@/lib/server/room-availability") return {
        currentRoomOperation: () => null,
        currentRoomStatus: () => null,
        loadCurrentRoomStatuses: async () => ({ statuses: new Map(), operations: new Map(), error: null }),
      };
      if (name === "@/lib/server/paginated-query") return { fetchAllPages };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  const request = { nextUrl: { searchParams: new URLSearchParams() } };
  return { get: () => exports.GET(request), ranges, projections };
}

test("dashboard returns every work order beyond the old 2000-row limit", async () => {
  const route = fixture();
  const response = await route.get();

  assert.equal(response.status, 200);
  assert.equal(response.body.work_orders.length, 2501);
  assert.equal(response.body.work_orders.at(-1).id, "order-2500");
  assert.equal(response.body.work_orders[0].checkout_date, null);
  assert.equal(response.body.work_orders[0].checkout_time, null);
  assert.equal(response.body.work_orders[0].cn_room, null);
  assert.deepEqual(route.ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("dashboard reports a later-page query failure instead of returning partial data", async () => {
  const route = fixture({ failAt: 1000 });
  const response = await route.get();

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "Work orders could not be loaded.");
  assert.equal(Object.keys(response.body).length, 1);
  assert.deepEqual(route.ranges, [[0, 999], [1000, 1999]]);
});

test("note-only General Managers list open and closed work orders", async () => {
  const route = fixture({ role: "General Manager", hasDashboard: false });
  const response = await route.get();

  assert.equal(response.status, 200);
  assert.ok(response.body.work_orders.length > 0);
  assert.ok(response.body.work_orders.some((order) => order.status === "Closed"));
});

test("every active role can list all tickets without full dashboard access", async () => {
  for (const role of ["Front Desk", "Housekeeping", "Assistant Manager", "Senior Management", "Maintenance Technician", "Engineer", "Chief Engineer", "System Administrator", "General Manager", "Front Desk Manager"]) {
    const route = fixture({ role, hasDashboard: false });
    const response = await route.get();
    assert.equal(response.status, 200, role);
    assert.equal(response.body.work_orders.length, 2501, role);
    assert.ok(response.body.work_orders.some((order) => order.status === "Closed"), role);
  }
});

test("General Manager dashboard layout lists all same-hotel tickets", async () => {
  const route = fixture({ role: "General Manager", hasDashboard: true });
  const response = await route.get();
  assert.equal(response.status, 200);
  assert.ok(response.body.work_orders.length > 0);
  assert.ok(response.body.work_orders.some((order) => order.status === "Closed"));
});

test("technician landing uses the shared desktop shell with the technician-scoped dashboard launcher", () => {
  const rolePolicy = readFileSync(new URL("../src/lib/server/roles.ts", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("../src/app/engineering/page.tsx", import.meta.url), "utf8");
  const technician = readFileSync(new URL("../src/app/technician/page.tsx", import.meta.url), "utf8");
  assert.match(rolePolicy, /if \(key === "technician"\) return "\/technician"/);
  assert.match(desktop, /roleKey\(session\.user\.role\) === "technician" && \{ key: "\/technician", label: "Technician Dashboard"/);
  assert.match(technician, /data-cmpri-modal-href="\/engineering\/preventive-maintenance"[^>]*>Preventive Maintenance/);
  assert.match(desktop, /const userRoleRef = useRef\(""\)/);
  assert.match(desktop, /fetch\("\/api\/work-orders",/);
  assert.match(desktop, /userRoleRef\.current = session\.user\.role/);
  assert.match(technician, /\/api\/work-orders\?mode=technician/);
});

 test("authorized dashboard reads include existing provenance fields for the pill", async () => {
  const route = fixture();
  const response = await route.get();
  assert.equal(response.status, 200);
  assert.ok(route.projections.length > 0);
  for (const projection of route.projections) {
    assert.ok(projection.split(", ").includes("import_source"));
    assert.ok(projection.split(", ").includes("import_external_id"));
  }
});
