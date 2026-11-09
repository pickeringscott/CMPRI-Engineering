import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {inventoryRequest} from "../src/lib/inventory.ts";
import { isUuid } from "../src/lib/uuid.ts";

function loadRoute(path, admin = { from() { throw new Error("Invalid input must not reach database writes."); } }) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === "@/lib/constants") return { HOTEL_ID: "audit-hotel" };
      if (name === "@/lib/inventory") return {inventoryRequest};
      if (name === "@/lib/uuid") return { isUuid };
      if (name === "@/lib/server/auth") return {
        requireCapability: async () => ({ principal: { identity: { id: "audit-user" }, profile: { role: "Engineer", full_name: "Audit User" } }, admin }),
      };
      if (name === "@/lib/server/paginated-query") return { fetchAllPages: async () => [] };
      if (name === "@/lib/work-order-categories") return { normalizeWorkOrderCategory: () => "General" };
      if (name === "@/lib/work-order-duplicates") return { likelyDuplicate: () => false };
      if (name === "@/lib/work-order-suggestions") return { inferWorkOrder: () => ({}) };
      throw new Error(`Unexpected route dependency: ${name}`);
    },
  });
  return exports;
}

function request(body = {}) {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("Parts/Vendor mutations return 400 for missing record kinds before database access", async () => {
  const route = loadRoute("../src/app/api/engineering/catalog/route.ts");

  for (const method of ["POST", "PATCH"]) {
    const response = await route[method](request());
    assert.equal(response.status, 400, `${method} status`);
    assert.match(response.body.error, /Record type is required/);
  }
});

test("Parts/Vendor creation persists the optional website field", async () => {
  let inserted;
  const builder = {
    insert(row) { inserted = row; return this; },
    select() { return this; },
    async single() { return { data: { id: "audit-vendor", ...inserted }, error: null }; },
  };
  const admin = {
    from(table) {
      assert.equal(table, "cmpri_vendors");
      return builder;
    },
  };
  const route = loadRoute("../src/app/api/engineering/catalog/route.ts", admin);
  const response = await route.POST(request({
    kind: "vendor",
    company_name: "Audit Vendor",
    website: "https://vendor.example.invalid",
  }));
  assert.equal(response.status, 200);
  assert.equal(inserted.website, "https://vendor.example.invalid");
  assert.equal(response.body.vendor.website, "https://vendor.example.invalid");
});

test("Parts/Vendor updates reject malformed record IDs as client errors", async () => {
  const route = loadRoute("../src/app/api/engineering/catalog/route.ts");
  const response = await route.PATCH(request({ kind: "idea", id: "not-a-uuid" }));
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Record id is invalid/);
});

test("work-order imports return 400 for missing or unsupported sources before database access", async () => {
  const route = loadRoute("../src/app/api/work-orders/import/route.ts");

  for (const body of [{}, { source: "Unknown", rows: [] }]) {
    const response = await route.POST(request(body));
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Import source/);
  }
});
