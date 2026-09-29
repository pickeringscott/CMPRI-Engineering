import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { fetchAllPages } from "../src/lib/server/paginated-query.ts";

const hotelId = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";
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

function routeFixture(routePath, failOffset = null) {
  const admin = {
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
  const principal = { profile: { role: "Chief Engineer" }, identity: { id: "test-user" } };
  const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === "@/lib/constants") return { HOTEL_ID: hotelId };
      if (name === "@/lib/server/auth") return {
        requireUser: async () => ({ principal, admin }),
        requireCapability: async () => ({ principal, admin }),
      };
      if (name === "@/lib/server/access") return { allows: () => true };
      if (name === "@/lib/server/paginated-query") return { fetchAllPages };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return { handlers: exports, request: { nextUrl: new URL("https://cmpri.test/api/test") } };
}

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
