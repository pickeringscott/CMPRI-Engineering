import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import * as reference from "../src/lib/work-order-reference.js";
import { loadTs } from "./helpers/load-ts.mjs";

const uuid = loadTs("src/lib/uuid.ts");
class NativeRequest extends Request {
  get nextUrl() { return new URL(this.url); }
}

const basePlan = {
  sources: [], rooms: [], workOrders: [], terms: [], status: "all", assignedOnly: false, roomIntent: "roster",
  webIntent: "none", manufacturer: "", model: "", errorCode: "", format: "default", fields: [],
  sortBy: "", sortDirection: "none", followUp: false, clarification: "", candidateAction: "none",
  actionValue: "", requestedPriority: "default",
};
const principal = { hotelId: "property", profile: { role: "Chief Engineer" }, permissions: ["manage_assets", "view_work_orders", "view_locations"] };
const request = () => new NativeRequest("https://preview.example.invalid/api/ask-cmpri", { headers: { Authorization: "Bearer fixture-session" } });
const id = (value) => "00000000-0000-4000-8000-" + String(value).padStart(12, "0");

function loadData({ inventoryGet = async () => { throw Error("Unexpected inventory read"); }, files = async () => ({ data: [], error: null }) } = {}) {
  const dependencies = {
    "server-only": {}, "next/server": { NextRequest: NativeRequest }, zod,
    "@/lib/dashboard/chief-module-access": { canReadChiefModuleData: (value) => value.chiefRead === true },
    "@/lib/dashboard/menu-access": { canOpenRoomOperations: () => false },
    "@/lib/room-availability": {},
    "@/lib/server/access": { allows: (value, capability) => value.permissions.includes(capability) },
    "@/lib/server/roles": { canReadEquipment: () => true },
    "@/lib/server/room-availability": {}, "@/lib/server/work-order-reader": {},
    "@/lib/work-order-read-policy": {}, "@/lib/work-order-reference.js": reference,
    "@/lib/work-order-search": {}, "@/lib/uuid": uuid,
    "@/lib/server/asset-file-register": { listRegisteredAssetFiles: files },
    "@/app/api/engineering/catalog/route": { GET: inventoryGet },
  };
  const exports = {}, fileName = "src/lib/server/ask-cmpri-data.ts";
  vm.runInNewContext(ts.transpileModule(readFileSync(fileName, "utf8"), {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, require: (name) => dependencies[name] });
  return exports;
}

test("stock questions use live authorized inventory and preserve item size instead of broad AC synonyms", async () => {
  const calls = [];
  const data = loadData({ inventoryGet: async (native) => {
    calls.push({ method: native.method, path: native.nextUrl.pathname, stock: native.nextUrl.searchParams.get("stock"), auth: native.headers.get("authorization") });
    return Response.json({ as_of: "2026-11-23T12:00:00Z", inventory: [
      { id: id(1), item_name: '1/2" Air Conditioner Whip', vendor_sku: "SKU300750", quantity_on_hand: 5, quantity_reserved: 0, unit_of_measure: "EA", storage_location: "Electrical storage", current_unit_cost: 99 },
      { id: id(2), item_name: '3/4" Air Conditioner Whip', quantity_on_hand: 11, quantity_reserved: 1, unit_of_measure: "EA" },
      { id: id(3), item_name: "Artifacts and drapes", quantity_on_hand: 19, quantity_reserved: 0, unit_of_measure: "EA" },
    ] });
  } });
  const plan = data.applyAskContext({ ...basePlan, sources: ["assets"], terms: ["AC", "HVAC"] }, "How many 1/2-inch Air Conditioner Whips are in stock right now? Read only.");
  assert.deepEqual([...plan.sources], ["inventory"]);
  assert.deepEqual([...plan.terms], ["1/2-inch Air Conditioner Whips"]);
  const result = await data.readAskSources(request(), { principal, admin: { from() { throw Error("Stock must use the native catalog read"); } } }, plan);
  assert.deepEqual(calls, [{ method: "GET", path: "/api/engineering/catalog", stock: "1", auth: "Bearer fixture-session" }]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "inventory:" + id(1));
  const facts = Object.fromEntries(result.items[0].facts.map(({ label, value }) => [label, value]));
  assert.equal(facts["On hand"], "5 EA");
  assert.equal(facts.Reserved, "0 EA");
  assert.equal(facts.Available, "5 EA");
  assert.equal(facts.SKU, "SKU300750");
  assert.equal(facts["Stock as of"], "2026-11-23T12:00:00Z");
  assert.equal(result.items[0].href, "https://preview.example.invalid/engineering/parts");
  assert.equal(result.missing.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /current_unit_cost|fixture-session/);
});

test("inventory reads keep both the account permission gate and native endpoint denial", async () => {
  let reads = 0;
  const data = loadData({ inventoryGet: async () => { reads++; return Response.json({ error: "Denied" }, { status: 403 }); } });
  const plan = { ...basePlan, sources: ["inventory"] };
  const denied = await data.readAskSources(request(), { principal: { ...principal, permissions: [] } }, plan);
  assert.equal(reads, 0);
  assert.equal(denied.items.length, 0);
  assert.match(denied.missing.join(" "), /outside this account/);
  const endpointDenied = await data.readAskSources(request(), { principal }, plan);
  assert.equal(reads, 1);
  assert.equal(endpointDenied.items.length, 0);
  assert.match(endpointDenied.missing.join(" "), /inventory is unavailable/);
  assert.ok(data.askPermittedSources({ ...principal, permissions: [], chiefRead: true }).includes("inventory"));
});

test("inventory follow-up evidence selects the exact item and missing stock is not invented as zero", async () => {
  const data = loadData({ inventoryGet: async () => Response.json({ inventory: [
    { id: id(1), item_name: "Other item", quantity_on_hand: 2, quantity_reserved: 0, unit_of_measure: "EA" },
    { id: id(2), item_name: "Requested item", quantity_on_hand: null, quantity_reserved: 0, unit_of_measure: "EA" },
  ] }) });
  const result = await data.readAskSources(request(), { principal }, { ...basePlan, sources: ["inventory"] }, ["inventory:" + id(2)]);
  assert.deepEqual(Array.from(result.items, ({ id }) => id), ["inventory:" + id(2)]);
  assert.equal(result.items[0].facts.some(({ label }) => label === "On hand" || label === "Available"), false);
  assert.equal(result.items[0].facts.find(({ label }) => label === "Reserved").value, "0 EA");
});

test("all six exact assets retain attached PDFs even during documentation revision without claiming applicability", async () => {
  const assets = Array.from({ length: 6 }, (_, index) => ({
    id: id(index + 10), name: "Navien Water Heater #" + (index + 1), location_id: id(100), active: true,
    manufacturer: "Navien", model_number: "NPE-240S2",
    documentation_revision_id: index === 0 ? id(200) : null,
    documentation_verified_at: index === 0 ? "2026-11-01T12:00:00Z" : null,
  }));
  const listed = [];
  const data = loadData({ files: async (_, assetId) => {
    listed.push(assetId);
    return { error: null, data: [
      { id: id(300 + assets.findIndex(({ id }) => id === assetId)), name: "Navien NPE Parts List.pdf", storage_path: "private-path/never-project" },
      { id: id(500), name: "_cmpri-verification.json", storage_path: "private-marker/never-project" },
    ] };
  } });
  const admin = { from(table) {
    const rows = table === "assets" ? assets : [{ id: id(100), name: "Boiler Room", room_number: null }];
    const query = { select() { return query; }, eq() { return query; }, in() { return query; }, or() { return query; }, ilike() { return query; }, order() { return query; }, limit() { return Promise.resolve({ data: rows, error: null }); } };
    return query;
  } };
  const result = await data.readAskSources(request(), { principal, admin }, { ...basePlan, sources: ["assets"], manufacturer: "Navien", model: "NPE-240S2", locationNames: ["Boiler Room"], webIntent: "manual" });
  assert.deepEqual(listed.sort(), assets.map(({ id }) => id).sort());
  assert.equal(result.items.length, 6);
  for (const [index, item] of result.items.entries()) {
    assert.equal(item.record.id, assets[index].id);
    assert.equal(item.links.length, 1);
    assert.equal(item.links[0].kind, "file");
    assert.equal(item.links[0].assetId, assets[index].id);
    assert.equal(item.links[0].id, id(300 + index));
    assert.equal(item.links[0].label, "Navien NPE Parts List.pdf");
  }
  assert.equal(result.assets[0].documentation_verified, false);
  assert.match(result.items[0].facts.find(({ label }) => label === "Documentation").value, /model applicability is unverified/);
  assert.doesNotMatch(JSON.stringify(result), /private-path|private-marker|signedUrl/);
});

test("answer evidence includes record and document actions while omitting signed or private URLs", async () => {
  let call;
  const gemini = loadTs("src/lib/server/ask-cmpri-gemini.ts", {
    "server-only": {}, zod,
    "@ai-sdk/google": { createGoogleGenerativeAI: () => (name) => name },
    ai: { Output: { object: (value) => value }, generateText: async (options) => { call = options; return { output: {} }; } },
  }, { URL, process: { env: { GOOGLE_GENERATIVE_AI_API_KEY: "fixture-key" } } });
  assert.ok(gemini.planSchema.safeParse({ ...basePlan, sources: ["inventory"] }).success);
  assert.ok(loadData().askContextSchema.safeParse({ sources: ["inventory"], pending: { field: "create", needs: "review" } }).success);
  await gemini.answerAsk({ question: "Show ticket and manual links", language: "en", chief: true, missing: [], signal: new AbortController().signal, items: [{
    id: "order:" + id(1), title: "WO#1042", source: "CMPRI · Work orders", sourceType: "internal",
    record: { kind: "order", id: id(1), label: "WO#1042" },
    links: [{ kind: "file", id: id(300), assetId: id(10), label: "Navien NPE Parts List.pdf" }],
    href: "https://private.example.invalid/document?token=never-send", hrefLabel: "Open source",
  }] });
  const evidence = JSON.parse(call.prompt).items[0];
  assert.deepEqual(evidence.actions, [
    { kind: "order", label: "WO#1042", available: true },
    { kind: "attached-document", label: "Navien NPE Parts List.pdf", available: true },
    { kind: "source", label: "Open source", available: true },
  ]);
  assert.doesNotMatch(call.prompt, /never-send|private\.example|fixture-key/);
  assert.match(call.system, /Do not claim those links are unavailable/);
  assert.match(call.system, /does not by itself prove model applicability/);
});
