import * as commonAreas from "../src/lib/cmpri-location-groups.ts";
import { ticketReadDependency } from "./helpers/load-ts.mjs";
import * as equipmentSelection from "../src/lib/equipment-selection.ts";
import * as accountDisplay from "../src/lib/account-display.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const hotelId = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";
const roleExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/server/roles.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: roleExports });

const source = readFileSync(new URL("../src/app/api/work-orders/drafts/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(role, actorId = "actor") {
  const profiles = [
    { id: actorId, role, full_name: "Audit Actor", active: true },
    { id: "submitter", role: "Front Desk", full_name: "Audit Submitter", active: true },
  ];
  const drafts = [
    { id: "own-draft", hotel_id: hotelId, created_by: actorId, location_id: "room-1", room: "Room 101", issue: "Actor draft", notes: "", revision: 1 },
    {
      id: "other-draft",
      hotel_id: hotelId,
      created_by: "submitter",
      staff_first_name: "Sensitive Submitter",
      location_id: "room-1",
      room: "Room 101",
      issue: "Submitter draft",
      notes: "Sensitive work-order details",
      asset_id: "asset-1",
      asset_name: "Sensitive asset",
      category: "Electrical",
      priority: "Urgent",
      revision: 1,
    },
  ];
  const locations = [{ id: "room-1", hotel_id: hotelId, name: "Room 101", active: true }];
  const writes = [];
  const admin = {
    from(table) {
      let action = "select";
      let value;
      const filters = [];
      const query = {
        select() { return query; },
        eq(field, expected) { filters.push((row) => row[field] === expected); return query; },
        in(field, expected) { filters.push((row) => expected.includes(row[field])); return query; },
        order() { return query; },
        limit() { return query; },
        update(nextValue) { action = "update"; value = nextValue; return query; },
        insert(nextValue) { action = "insert"; value = nextValue; return query; },
        delete() { action = "delete"; return query; },
        maybeSingle() { return Promise.resolve(execute(true)); },
        single() { return Promise.resolve(execute(true)); },
        then(onFulfilled, onRejected) { return Promise.resolve(execute(false)).then(onFulfilled, onRejected); },
      };
      function execute(single) {
        const rows = table === "profiles" ? profiles
          : table === "cmpri_work_order_drafts" ? drafts
            : table === "locations" ? locations : [];
        const matched = rows.filter((row) => filters.every((filter) => filter(row)));
        if (action === "insert") {
          const inserted = { id: "new-draft", revision: 1, ...value };
          rows.push(inserted);
          writes.push({ action, table, id: inserted.id });
          return { data: inserted, error: null };
        }
        if (action === "update") {
          const existing = matched[0];
          if (!existing) return { data: null, error: null };
          Object.assign(existing, value);
          writes.push({ action, table, id: existing.id });
          return { data: existing, error: null };
        }
        if (action === "delete") {
          for (const row of matched) {
            const index = drafts.indexOf(row);
            if (index >= 0) drafts.splice(index, 1);
            writes.push({ action, table, id: row.id });
          }
          return { data: null, error: null };
        }
        return { data: single ? matched[0] || null : matched, error: null };
      }
      return query;
    },
  };
  const principal = { identity: { id: actorId }, profile: { id: actorId, role, full_name: "Audit Actor", active: true } };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name);
      if (name === "@/lib/equipment-selection") return equipmentSelection;
      if (name === "@/lib/account-display") return accountDisplay;
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) } };
      if (name === "@/lib/constants") return { HOTEL_ID: hotelId };
      if (name === "@/lib/server/auth") return {
        requireCapability: async (_request, capability) => roleExports.roleAllows(role, capability) ? { principal, admin } : null,
      };
      if (name === "@/lib/server/roles") return roleExports;
      throw new Error(`Unexpected module ${name}`);
    },
  });
  const request = (body, id) => ({
    nextUrl: { searchParams: new URLSearchParams(id ? { id } : {}) },
    json: async () => body,
  });
  return {
    drafts,
    writes,
    get: (params = {}) => exports.GET({ ...request(), nextUrl: { searchParams: new URLSearchParams(params) } }),
    post: (body) => exports.POST(request(body)),
    patch: (body) => exports.PATCH(request(body)),
    delete: (id) => exports.DELETE(request(undefined, id)),
  };
}

function submittedDraftRetryFixture() {
  const actorId = "reviewer";
  const sourceDraftId = "submitted-draft";
  const existingOrder = {
    id: "created-work-order",
    display_id: "WO-1234",
    status: "Open",
    source_draft_created_by: "submitter",
  };
  const calls = [];
  const admin = {
    from(table) {
      const filters = [];
      const query = {
        select() { calls.push(`${table}.select`); return query; },
        eq(field, expected) { filters.push([field, expected]); return query; },
        delete() { calls.push(`${table}.delete`); return query; },
        maybeSingle() {
          calls.push(`${table}.maybeSingle`);
          return Promise.resolve({
            data: table === "work_orders"
              && filters.some(([field, value]) => field === "source_draft_id" && value === sourceDraftId)
              ? existingOrder
              : null,
            error: null,
          });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const routeExports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/app/api/work-orders/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: routeExports,
    require(name) {if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name);
      if (name === "@/lib/equipment-selection") return equipmentSelection;
      if (name === "@/lib/account-display") return accountDisplay;
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) } };
      if (name === "@/lib/constants") return { HOTEL_ID: hotelId };
      if (name === "@/lib/server/access") return { allows: () => true };
      if (name === "@/lib/server/auth") return { requireUser: async () => null };
      if (name === "@/lib/server/request-auth") return {
        authenticatedUser: async () => ({ user: { id: actorId }, profile: { role: "System Administrator" } }),
      };
      if (name === "@/lib/server/roles") return roleExports;
      if (name === "@/lib/server/supabase-admin") return { createSupabaseAdmin: () => admin };
      if (name === "@/lib/server/paginated-query") return { fetchAllPages: async () => ({ data: [], error: null }) };
      if (name === "@/lib/integrations/spreadsheet-input") return { jsonObject: async (request) => request.json() };
      if (name === "@/lib/work-order-attribution") return { validFirstName: () => true, workOrderAttribution: () => ({}) };
      if (name === "@/lib/work-order-duplicates") return { likelyDuplicate: () => false };
      if (name === "@/lib/work-order-suggestions") return { inferWorkOrder: () => ({}) };
      if (name === "@/lib/work-order-categories") return { normalizeWorkOrderCategory: (value) => value };
      if (name === "@/lib/server/room-ranker") return { processRoomRankerSyncForWorkOrder: async () => ({}) };
      if (name === "@/lib/server/room-availability") return { currentRoomOperation: () => null, currentRoomStatus: () => "", loadCurrentRoomStatuses: async () => ({}) };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return {
    calls,
    post: () => routeExports.POST({
      headers: new Headers(),
      json: async () => ({
        source_draft_id: sourceDraftId,
        source_draft_revision: 1,
        orders: [{ location_id: "room-1", issue: "Already approved report" }],
      }),
    }),
  };
}

test("creation draft choices are owner-only for every submit-capable role, including accounts stored as Engineer", async () => {
  for (const role of ["Front Desk", "Lead Housekeeper", "General Manager", "Assistant General Manager", "Front Desk Manager", "Maintenance Technician", "Engineer", "Chief Engineer", "System Administrator"]) {
    for (const actorId of ["actor", "second-session-user"]) {
      const route = fixture(role, actorId);
      const response = await route.get();
      assert.equal(response.status, 200, role);
      assert.equal(response.body.drafts.length, 1, role);
      assert.ok(response.body.drafts.every(draft => draft.created_by === actorId));
      assert.equal(response.headers["Cache-Control"], "private, no-store");
      assert.equal(route.writes.length, 0);
    }
  }
});

test("review scope and targeted review reject non-reviewers without leaking foreign drafts", async () => {
  for (const role of ["Front Desk", "Lead Housekeeper", "General Manager", "Assistant General Manager", "Front Desk Manager", "Maintenance Technician"]) {
    const route = fixture(role);
    for (const params of [{scope:"review"}, {review_draft_id:"other-draft"}]) assert.equal((await route.get(params)).status,403,role);
    assert.equal((await route.patch({id:"other-draft", expected_revision:1, issue:"Changed"})).status,403);
    assert.equal((await route.delete("other-draft")).status,403);
    assert.equal(route.writes.length,0);
  }
});

test("targeted authorized review is separate from own form choices and scoped to the hotel", async () => {
  const route=fixture("Chief Engineer");
  const response=await route.get({scope:"own",review_draft_id:"other-draft"});
  assert.equal(response.body.drafts.length,1);
  assert.equal(response.body.review_draft.id,"other-draft");
  assert.equal(response.body.review_draft.can_edit,true);
  route.drafts.push({id:"other-hotel",created_by:"actor",hotel_id:"elsewhere"});
  const other=await route.get({scope:"own",review_draft_id:"other-hotel"});
  assert.equal(other.body.review_draft,null);
  assert.equal(other.body.drafts.length,1);
  assert.equal((await route.get({scope:"unknown"})).status,400);
});

test("General Managers cannot set engineering fields in their own drafts", async () => {
  const route = fixture("General Manager");
  const own = await route.post({
    location_id: "room-1",
    issue: "New request",
    asset_id: "forged-asset",
    asset_name: "Forged equipment",
    category: "Forged category",
    priority: "Urgent",
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.draft.asset_id, null);
  assert.equal(own.body.draft.asset_name, "");
  assert.equal(own.body.draft.category, "General");
  assert.equal(own.body.draft.priority, "Medium");

  const updated = await route.patch({
    id: "own-draft",
    expected_revision: 1,
    asset_id: "forged-asset",
    asset_name: "Forged equipment",
    category: "Forged category",
    priority: "Urgent",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.draft.asset_id, null);
  assert.equal(updated.body.draft.asset_name, "");
  assert.equal(updated.body.draft.category, "General");
  assert.equal(updated.body.draft.priority, "Medium");
});

test("engineer reviewers may edit and delete another submitter's draft", async () => {
  const route = fixture("Chief Engineer");
  const listed = await route.get({scope:"review"});
  const foreign = listed.body.drafts.find((draft) => draft.id === "other-draft");
  assert.equal(foreign.can_edit, true);
  assert.equal(foreign.can_delete, true);

  const patch = await route.patch({ id: "other-draft", expected_revision: 1, issue: "Reviewed by engineer" });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.draft.issue, "Reviewed by engineer");
  assert.equal(patch.body.draft.revision, 2);
  assert.equal(route.writes.length, 1);

  const deletion = await route.delete("other-draft");
  assert.equal(deletion.status, 200);
  assert.equal(route.drafts.some((draft) => draft.id === "other-draft"), false);
});

test("submit-only roles cannot read or mutate another submitter's draft", async () => {
  const route = fixture("Front Desk");
  const listed = await route.get();
  assert.deepEqual(listed.body.drafts.map((draft) => draft.id), ["own-draft"]);
  assert.equal((await route.patch({ id: "other-draft", expected_revision: 1, issue: "Attempted change" })).status, 403);
  assert.equal((await route.delete("other-draft")).status, 403);
  assert.equal(route.writes.length, 0);
});

test("submit-only draft creation ignores protected asset, category, and priority fields", async () => {
  const route = fixture("Front Desk");
  const response = await route.post({
    location_id: "room-1",
    issue: "Front desk draft",
    asset_id: "unauthorized-asset",
    asset_name: "Unauthorized asset",
    category: "Emergency Electrical",
    priority: "Urgent",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.draft.asset_id, null);
  assert.equal(response.body.draft.asset_name, "");
  assert.equal(response.body.draft.category, "General");
  assert.equal(response.body.draft.priority, "Medium");
});

test("submit-only draft updates normalize protected fields even when directly patched", async () => {
  const route = fixture("Front Desk");
  const response = await route.patch({
    id: "own-draft",
    expected_revision: 1,
    category: "Emergency Electrical",
    priority: "Urgent",
    asset_name: "Unauthorized asset",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.draft.asset_id, null);
  assert.equal(response.body.draft.asset_name, "");
  assert.equal(response.body.draft.category, "General");
  assert.equal(response.body.draft.priority, "Medium");
  assert.equal(response.body.draft.revision, 2);
});

test("work-order submission from another user's draft requires review capability", () => {
  const workOrderRoute = readFileSync(new URL("../src/app/api/work-orders/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/work-orders/page.tsx", import.meta.url), "utf8");

  assert.match(workOrderRoute, /if\s*\(!ownDraft\s*&&\s*!roleAllows\(auth\.profile\.role,\s*"review_tickets"\)\)/);
  assert.match(page, /if \(draft\.created_by !== cmpriSession\?\.user\.id && !draft\.can_edit\) return;/);
  assert.match(page, /: <span className="px-3 py-1\.5 text-xs font-semibold text-slate-500">Read-only<\/span>/);
});

test("retrying an already approved draft returns its existing order after draft deletion", async () => {
  const route = submittedDraftRetryFixture();
  const response = await route.post();

  assert.equal(response.status, 200);
  assert.equal(response.body.already_submitted, true);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.work_orders[0].id, "created-work-order");
  assert.ok(route.calls.indexOf("work_orders.maybeSingle") < route.calls.indexOf("cmpri_work_order_drafts.delete"));
  assert.equal(route.calls.includes("cmpri_work_order_drafts.maybeSingle"), false);
});
