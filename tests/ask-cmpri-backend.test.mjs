import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import * as reference from "../src/lib/work-order-reference.js";
import { loadTs } from "./helpers/load-ts.mjs";

const roles = loadTs("src/lib/server/roles.ts");
const access = loadTs("src/lib/server/access.ts", { "./roles": roles });
const uuid = loadTs("src/lib/uuid.ts");
const room = loadTs("src/lib/room-availability.ts");
const workOrderReader = loadTs("src/lib/server/work-order-reader.ts", { "./access": access });
const readPolicy = loadTs("src/lib/work-order-read-policy.ts");
const workOrderSearch = loadTs("src/lib/work-order-search.ts", { "./work-order-reference.js": reference });
const dependencies = {
  "server-only": {},
  "next/server": {},
  zod,
  "@/lib/dashboard/chief-module-access": { canReadChiefModuleData: () => false },
  "@/lib/dashboard/menu-access": { canOpenRoomOperations: () => false },
  "@/lib/room-availability": room,
  "@/lib/server/access": access,
  "@/lib/server/roles": roles,
  "@/lib/server/room-availability": {},
  "@/lib/server/work-order-reader": workOrderReader,
  "@/lib/work-order-read-policy": readPolicy,
  "@/lib/work-order-reference.js": reference,
  "@/lib/work-order-search": workOrderSearch,
  "@/lib/uuid": uuid,
  "@/lib/server/asset-file-register": { listRegisteredAssetFiles: async () => ({ data: [], error: null }) },
};
const data = {};
const dataFile = "src/lib/server/ask-cmpri-data.ts";
vm.runInNewContext(ts.transpileModule(readFileSync(dataFile, "utf8"), {
  fileName: dataFile, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: data, URL, require: (name) => dependencies[name] });

let modelCall;
const gemini = loadTs("src/lib/server/ask-cmpri-gemini.ts", {
  "server-only": {},
  zod,
  "@ai-sdk/google": { createGoogleGenerativeAI: () => Object.assign((name) => name, { tools: { googleSearch: () => "grounding-test" } }) },
  ai: {
    generateText: async (options) => {
      modelCall = options;
      return {
        text: "This unverified text must not appear.",
        sources: [
          { sourceType: "url", url: "https://producthelp.whirlpool.com/code", title: "Whirlpool Product Help" },
          { sourceType: "url", url: "https://www.whirlpool.com/docs", title: "Whirlpool docs" },
          { sourceType: "url", url: "javascript:alert(1)", title: "Unsafe URL" },
        ],
        providerMetadata: {
          google: {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://producthelp.whirlpool.com/code" } },
                { web: { uri: "https://www.whirlpool.com/docs" } },
              ],
              groundingSupports: [{ segment: { text: "F9 E1 indicates a long drain time." }, groundingChunkIndices: [0] }],
            }
          }
        },
      };
    },
  },
}, { URL, process: { env: { GOOGLE_GENERATIVE_AI_API_KEY: "fake-provider-in-unit-test" } } });

const basePlan = {
  sources: [], rooms: [], workOrders: [], terms: [], status: "all", assignedOnly: false, roomIntent: "roster",
  webIntent: "none", manufacturer: "", model: "", errorCode: "", format: "default", fields: [],
  sortBy: "", sortDirection: "none", followUp: false, clarification: "", candidateAction: "none",
  actionValue: "", requestedPriority: "default",
};

test("public search accepts allowlisted equipment and safe exact codes, without free text", async () => {
  const approved = { webIntent: "error-code", manufacturer: "Whirlpool", model: "WFW5620HW", errorCode: "F9 E1" };
  const sanitized = gemini.publicAskQuery(approved, "Private work-order note, room 212. The washer code reads F9 E1.");
  assert.equal(sanitized, "Whirlpool WFW5620HW official manufacturer error code F9E1");
  assert.equal(gemini.publicAskQuery({ ...approved, model: "VIP1027" }, "Look up Whirlpool VIP1027 error code F9 E1."), null);
  assert.equal(gemini.publicAskQuery(approved, "Their guest code is F9E1."), null);
  assert.equal(gemini.publicAskQuery(approved, "Washer code AF9E1X"), null);
  assert.equal(gemini.publicAskQuery({ ...approved, model: "OTHER123", errorCode: "F9E1" }, "F9E1", true), null);
  assert.equal(gemini.publicAskQuery({ ...approved, webIntent: "public-guidance" }, "Tornado in Room 212, guest name Example Name"),
    "National Weather Service what to do during a tornado official public safety guidance");
  const returned = await gemini.searchPublicAsk(sanitized, new AbortController().signal);
  assert.equal(modelCall.prompt, sanitized);
  assert.deepEqual([...Object.keys(modelCall.tools)], ["google_search"]);
  assert.equal(returned.length, 2);
  assert.equal(returned[0].text, "F9 E1 indicates a long drain time.");
  assert.match(returned[0].source, /producthelp\.whirlpool\.com via Google Search/);
  assert.equal(returned[1].text, undefined);
});

test("follow-ups retain room and table fields while new substantive queries select new sources", () => {
  const prior = { sources: ["orders"], rooms: ["134"], status: "all", format: "table", fields: ["Room", "Work order", "Repair status"] };
  const table = data.applyAskContext({ ...basePlan, sources: ["rooms"], fields: ["Priority"] }, "Add a priority column and sort by priority", prior);
  assert.deepEqual([...table.sources], ["orders"]);
  assert.deepEqual([...table.rooms], ["134"]);
  assert.deepEqual([...table.fields], ["Room", "Work order", "Repair status", "Priority"]);
  assert.equal(table.sortBy, "priority");
  const newQuery = data.applyAskContext({ ...basePlan, sources: ["rooms"], roomIntent: "late-checkouts" }, "Which rooms have late checkouts in a table?", prior);
  assert.deepEqual([...newQuery.sources], ["rooms"]);
  assert.deepEqual([...newQuery.rooms], []);
  assert.equal(newQuery.roomIntent, "late-checkouts");
  assert.equal(newQuery.format, "table");
  const replacements = data.applyAskContext({ ...basePlan, followUp: true, sources: ["assets"], webIntent: "manufacturer" },
    "What could replace those?", { sources: ["orders"], rooms: ["134", "212"], terms: ["microwave"] });
  assert.deepEqual([...replacements.sources], ["orders", "assets"]);
  assert.deepEqual([...replacements.rooms], ["134", "212"]);
  assert.deepEqual([...replacements.terms], ["microwave"]);
});

test("repair complete and administrative closure remain separate facts", () => {
  const item = { id: "order", display_id: "1078", room: "134", issue: "Towel bar loose.", priority: "Low" };
  const repair = (status, action_root_cause) => data.askOrderItem({ ...item, status, action_root_cause }).facts.find((fact) => fact.label === "Repair status").value;
  assert.equal(repair("In Progress"), "Repair in progress");
  assert.match(repair("Completed"), /awaiting closure/);
  assert.equal(repair("Closed", "Checked the towel bar."), "Repair outcome unconfirmed");
  assert.equal(repair("Closed", "Replaced the damaged part."), "Repair complete per recorded action");
  assert.equal(repair("Closed", "Not repaired."), "Repair outcome unconfirmed");
});

test("assigned tickets are restricted by the authenticated technician name and property", async () => {
  const fields = [];
  const query = {
    select() { return query; },
    eq(field, value) { fields.push([field, value]); return query; },
    order() { return query; },
    limit() { return Promise.resolve({ data: [], error: null }); },
  };
  const principal = {
    identity: { id: "account", email: "account@example.invalid" },
    profile: { id: "account", role: "technician", full_name: "Signed In", active: true },
    membership: { user_id: "account", hotel_id: "property", role: "technician", active: true },
    hotelId: "property",
    permissions: [],
  };
  const plan = data.applyAskContext(basePlan, "show my assigned tickets");
  const found = await data.askOrders({ principal, admin: { from() { return query; } } }, plan);
  assert.equal(found.length, 0);
  assert.deepEqual(fields, [["hotel_id", "property"], ["technician_name", "Signed In"]]);
});

test("exact work order identifiers are matched before limits and alphanumeric room numbers survive", async () => {
  let expression;
  const order = { id: "ticket", display_id: "WO#1042", room: "Room 103B", hotel_id: "property" };
  const query = {
    select() { return query; }, eq() { return query; },
    or(value) { expression = value; return query; },
    limit() { return Promise.resolve({ data: [order], error: null }); },
  };
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const plan = data.applyAskContext({ ...basePlan, sources: ["orders"] }, "What happened on WO#1042 in Room 103B?");
  assert.deepEqual([...plan.rooms], ["103B"]);
  const found = await data.askOrders({ principal, admin: { from() { return query; } } }, plan);
  assert.deepEqual(Array.from(found, ({ id }) => id), ["ticket"]);
  assert.match(expression, /display_id\.ilike\."1042"/);
  assert.doesNotMatch(expression, /%1042%/);
  const checkout = data.applyAskContext({ ...basePlan, rooms: ["12"], roomIntent: "late-checkouts" }, "Which rooms check out after 12:30 PM?");
  assert.deepEqual([...checkout.rooms], []);
  assert.equal(checkout.checkoutAfter, "12:30 PM");
});

test("an authorized linked asset stays tappable when physically elsewhere, with no Installed model badge", () => {
  const order = { id: "order", display_id: "1078", room: "Front Desk", location_id: "desk", status: "Closed" };
  const asset = { id: "pbx", location_id: "mechanical", name: "PBX phone", active: true, manufacturer: "GE", model_number: "X12" };
  const remote = data.askOrderItem(order, true, asset);
  assert.equal(remote.links[0].id, "pbx");
  assert.equal(remote.facts.some(({ label }) => label === "Installed model"), false);
  const installed = data.askOrderItem(order, true, { ...asset, location_id: "desk" });
  assert.equal(installed.facts.find(({ label }) => label === "Installed model").value, "GE X12");
});

test("a formatter always rerenders previously selected result rows and keeps links and CSV export", async () => {
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const order = { id: "order:one", title: "Room 134 · WO#1042", text: "Sink is leaking", source: "CMPRI · Work orders", sourceType: "internal",
    record: { kind: "order", id: "one", label: "WO#1042" }, facts: [{ label: "Room", value: "134" }, { label: "Priority", value: "High" }] };
  const another = { ...order, id: "order:two", title: "WO#1110", text: "Out of context" };
  const requestHandler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: async () => ({ items: [order, another], orders: [], locations: [], assets: [], missing: [] }) },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: async () => ({ ...basePlan, sources: ["orders"], rooms: ["134"] }),
      answerAsk: async () => ({ title: "CMPRI results", summary: "A leaking sink.", itemIds: [order.id] }) },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}), beginAskAction: () => ({}) },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const submit = async (question, previous) => (await requestHandler.POST(new Request("https://test.invalid/api/ask-cmpri", {
    method: "POST", body: JSON.stringify({ question, previous }),
  }))).json();
  const first = await submit("Any maintenance issues in Room 134?");
  assert.ok(first.context.contextProof);
  assert.deepEqual(first.items.map(({ id }) => id), [order.id]);
  const table = await submit("Put that in a table", first.context);
  assert.deepEqual(table.table.rows.map(({ id }) => id), [order.id]);
  assert.equal(table.table.rows[0].cells["Work order"].record.id, "one");
  const csv = await submit("Download that as CSV", table.context);
  assert.equal(csv.downloads[0].name, "CMPRI-search-results.csv");
  assert.match(csv.downloads[0].content, /Sink is leaking/);
  assert.doesNotMatch(csv.downloads[0].content, /Out of context/);
});
