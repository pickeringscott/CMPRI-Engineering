import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTs } from "./helpers/load-ts.mjs";

const guidance = loadTs("src/lib/ai/cmpri-operation-guidance.ts");
const catalog = loadTs("src/lib/server/ask-cmpri-native-catalog.ts", { "server-only": {}, "@/lib/ai/cmpri-operation-guidance": guidance });
const root = new URL("../", import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value));

test("every native API feature verb is registered or explicitly documented as a non-operation", () => {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  const api = new URL("src/app/api/", root).pathname;
  const missing = [];
  for (const file of walk(api).filter(file => file.endsWith("/route.ts"))) {
    const route = "/api/" + path.relative(api, file).replace(/\/route\.ts$/, "");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const names = ts.isFunctionDeclaration(node) ? [node.name?.text] : ts.isVariableStatement(node) ? node.declarationList.declarations.map(declaration => declaration.name.getText(source)) : [];
      for (const method of names.filter(name => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name || ""))) {
        const registered = catalog.ASK_NATIVE_OPERATIONS.some(operation => operation.path === route && operation.method === method);
        const excluded = catalog.ASK_NATIVE_NON_OPERATIONS.some(entry => entry.path === route && (!entry.method || entry.method === method));
        const disabledAlias = method !== "GET" && ["/api/weather-preview/astronomy", "/api/willard-airport-layout", "/api/willard-flights", "/api/willard-tracker", "/api/football-betting-line"].includes(route);
        if (!registered && !excluded && !disabledAlias) missing.push(`${method} ${route}`);
      }
    }
  }
  assert.deepEqual(missing, []);
  const keys = catalog.ASK_NATIVE_OPERATIONS.map(operation => operation.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(catalog.ASK_NATIVE_OPERATIONS.every(operation => /^\/api\//.test(operation.path) && operation.inputContract.length > 20 && Object.isFrozen(operation)));
});

test("native discovery carries full shared workflow rules and accurate guest/reference contracts", () => {
  const pool = catalog.askNativeOperation("pool.log_save").inputContract;
  assert.ok(pool.includes(guidance.CMPRI_NATIVE_POOL_LOG_GUIDANCE));
  assert.doesNotMatch(pool, /Only System Administrators can change a value/);
  assert.match(pool, /daily_checks_missing/);
  assert.match(pool, /test_entry/);
  const manual = catalog.askNativeOperation("manuals.save").inputContract;
  assert.ok(manual.includes(guidance.CMPRI_DOCUMENTATION_INTEGRITY_RULES));
  const guests = catalog.askNativeOperation("room_operations.read").inputContract;
  assert.match(guests, /loyalty_tier/); assert.match(guests, /incoming_loyalty_tier/); assert.match(guests, /blank\/unrecognized is unknown/);
  assert.deepEqual(plain(catalog.askNativeOperation("work_orders.references").queryParams), ["target"]);
  const note = catalog.askNativeOperation("work_orders.note").inputContract;
  assert.match(note, /notes:string\[1\.\.50\]/); assert.match(note, /do not resend existing history/); assert.match(note, /supplies actual actor/);
  for (const key of ["room_operations.validate", "room_operations.guest_reports_validate", "room_operations.drive_preview"]) assert.equal(catalog.askNativeOperation(key).writes, false);
  assert.equal(catalog.askNativeOperation("room_operations.drive_commit").writes, true);
});

test("shared documentation rules exactly preserve the established source document", () => {
  assert.equal(guidance.CMPRI_DOCUMENTATION_INTEGRITY_RULES, readFileSync(new URL("docs/CMPRI_DOCUMENTATION_INTEGRITY_RULES.md", root), "utf8"));
});

test("external MCP retains all existing shared descriptions and existing write-scope guard", () => {
  const writes = loadTs("src/lib/server/cmpri-mcp-writes.ts", {
    "server-only": {}, "next/server": {}, "@/lib/ai/cmpri-operation-guidance": guidance,
    "./hours-tracker-mcp": { canUseHoursMcp: () => true }, "@/lib/server/hours-clock-policy": { hoursClockEnabled: () => true },
    "@/lib/constants": { HOTEL_ID: "fixture" }, "@/lib/ai/mcp-write-input": {}, "@/lib/pool-log": {},
    "@/lib/server/access": { allows: () => true }, "@/lib/server/roles": { roleKey: () => "system_admin" },
  });
  const identity = { canWrite: true, principal: { profile: {} } };
  const actions = writes.availableMcpWriteActions(identity);
  assert.equal(actions.length, Object.keys(guidance.CMPRI_WRITE_ACTION_GUIDANCE).length);
  for (const action of actions) assert.equal(action.description, guidance.CMPRI_WRITE_ACTION_GUIDANCE[action.action]);
  assert.match(actions.find(action => action.action === "pool_log.save").description, /Only System Administrators can change a value/);
  assert.deepEqual(plain(writes.availableMcpWriteActions({ ...identity, canWrite: false })), []);
});
