import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {inventoryRequest} from "../src/lib/inventory.ts";
import { fetchAllPages } from "../src/lib/server/paginated-query.ts";
import { loadTs } from "./helpers/load-ts.mjs";

const hotelId = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";
const menuAccess = loadTs("src/lib/dashboard/menu-access.ts");
const access = loadTs("src/lib/server/access.ts");
const assetRows = Array.from({ length: 1001 }, (_, index) => ({
  id: `asset-${index}`,
  hotel_id: hotelId,
  active: true,
  name: `Asset ${index}`,
  asset_type: "Equipment",
  asset_tag: null,
  location_id: null,
  status: "Active",
  manufacturer: null,
  model_number: null,
  serial_number: null,
}));

function routeFixture(routePath, failOffset = null, { role = "Chief Engineer", membershipRole = "admin", mcp = false } = {}) {
  const admin = {
    async rpc(name,args) {assert.equal(name,"cmpri_inventory_snapshot");assert.equal(args.p_hotel,hotelId);return failOffset===1000?{data:null,error:new Error("Snapshot unavailable")}:{data:{assets:assetRows,inventory:[]},error:null};},
    from(table) {
      const query = { table, filters: [], from: 0, to: 999 };
      query.select = () => query;
      query.eq = (key, value) => { query.filters.push([key, value]); return query; };
      query.in = () => query;
      query.order = () => query;
      query.range = (from, to) => { query.from = from; query.to = to; return query; };
      query.limit = (limit) => { query.to = query.from + limit - 1; return query; };
      query.then = (resolve, reject) => {
        if (table === "assets" && query.from === failOffset) {
          return Promise.resolve({ data: null, error: new Error("Asset page unavailable") }).then(resolve, reject);
        }
        const rows = table === "assets" ? assetRows : [];
        const filtered = rows.filter((row) => query.filters.every(([key, value]) => row[key] === value));
        return Promise.resolve({ data: filtered.slice(query.from, query.to + 1), error: null }).then(resolve, reject);
      };
      return query;
    },
  };
  const principal = {
    profile: { role, active: true },
    membership: { role: membershipRole, active: true },
    identity: { id: "test-user" }, hotelId, permissions: [],
  };
  const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === "@/lib/inventory") return {inventoryRequest};
      if (name === "@/lib/constants") return { HOTEL_ID: hotelId };
      if (name === "@/lib/dashboard/menu-access") return menuAccess;
      if (name === "@/lib/server/auth") return {
        requireUserAttempt: async () => ({ ok: true, principal, admin, mcp }),
        requireCapability: async () => ({ principal, admin }),
      };
      if (name === "@/lib/server/access") return access;
      if (name === "@/lib/server/chief-module-read") return { requireChiefModuleRead: async () => ({ principal, admin, canManage: true }) };
      if (name === "@/lib/server/paginated-query") return { fetchAllPages };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return { handlers: exports, request: { nextUrl: new URL("https://cmpri.test/api/test") } };
}

test("Enseo technician reads are available in the dashboard without expanding MCP access", async () => {
  const path = "../src/app/api/enseo/assignments/route.ts";
  const technician = { role: "Maintenance Technician", membershipRole: "technician" };
  for (const [options, status] of [[technician, 200], [{ ...technician, mcp: true }, 403], [{ mcp: true }, 200]]) {
    const { handlers, request } = routeFixture(path, null, options);
    const response = await handlers.GET(request);
    assert.equal(response.status, status);
    if (options === technician) assert.equal(response.body.can_manage, false);
  }
});

for (const routePath of [
  "../src/app/api/enseo/assignments/route.ts",
  "../src/app/api/engineering/catalog/route.ts",
]) {
  test(`${routePath} asset dropdown loads all rows over the Supabase limit`, async () => {
    const fixture = routeFixture(routePath);
    const response = await fixture.handlers.GET(fixture.request);
    assert.equal(response.status, 200);
    assert.equal(response.body.assets.length, 1001);
    assert.equal(response.body.assets.at(-1).id, "asset-1000");
  });

  test(`${routePath} fails explicitly when a later asset page fails`, async () => {
    const fixture = routeFixture(routePath, 1000);
    const response = await fixture.handlers.GET(fixture.request);
    assert.equal(response.status, 503);
    assert.equal(response.body.assets, undefined);
  });
}
