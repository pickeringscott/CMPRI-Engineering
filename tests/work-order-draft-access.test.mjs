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
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
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
    get: () => exports.GET(request()),
    post: (body) => exports.POST(request(body)),
    patch: (body) => exports.PATCH(request(body)),
    delete: (id) => exports.DELETE(request(undefined, id)),
  };
}

test("dashboard managers see other drafts read-only without mutation controls", async () => {
  const route = fixture("General Manager");
  const response = await route.get();

  assert.equal(response.status, 200);
  assert.equal(response.body.drafts.length, 2);
  const foreign = response.body.drafts.find((draft) => draft.id === "other-draft");
  assert.equal(foreign.can_edit, false);
  assert.equal(foreign.can_delete, false);
  assert.equal(foreign.issue, "Submitter draft");
  assert.equal(foreign.room, "Room 101");
  assert.equal(foreign.notes, "");
  assert.equal(foreign.staff_first_name, null);
  assert.equal(foreign.location_id, null);
  assert.equal(foreign.asset_id, null);
  assert.equal(foreign.asset_name, "");
  assert.equal(foreign.category, "General");
  assert.equal(foreign.priority, "Medium");
  assert.equal(foreign.creator_role, "");

  const patch = await route.patch({ id: "other-draft", expected_revision: 1, issue: "Changed by manager" });
  const deletion = await route.delete("other-draft");
  assert.equal(patch.status, 403);
  assert.equal(deletion.status, 403);
  assert.equal(route.writes.length, 0);
  assert.equal(route.drafts.find((draft) => draft.id === "other-draft").issue, "Submitter draft");
});

test("work-order viewers receive redacted read-only summaries for foreign drafts", async () => {
  for (const role of ["Assistant General Manager", "Front Desk Manager", "Maintenance Technician"]) {
    const response = await fixture(role).get();
    const foreign = response.body.drafts.find((draft) => draft.id === "other-draft");
    assert.ok(foreign, role);
    assert.equal(foreign.can_edit, false, role);
    assert.equal(foreign.can_delete, false, role);
    assert.equal(foreign.room, "Room 101", role);
    assert.equal(foreign.issue, "Submitter draft", role);
    assert.equal(foreign.notes, "", role);
    assert.equal(foreign.staff_first_name, null, role);
    assert.equal(foreign.location_id, null, role);
    assert.equal(foreign.asset_id, null, role);
    assert.equal(foreign.asset_name, "", role);
    assert.equal(foreign.category, "General", role);
    assert.equal(foreign.priority, "Medium", role);
    assert.equal(foreign.creator_role, "", role);
  }
});

test("General Managers can see foreign pending drafts read-only and cannot set engineering fields", async () => {
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
  const listed = await route.get();
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
