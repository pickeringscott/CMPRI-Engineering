import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import * as reference from "../src/lib/work-order-reference.js";
import { loadTs } from "./helpers/load-ts.mjs";

const responseHelper = loadTs("src/lib/server/ask-cmpri-response.ts", {
  "server-only": {}, "next/server": { NextResponse: { json: Response.json } },
}, { Response, ReadableStream, TextEncoder, Uint8Array });
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

// A historical server-issued result uses the same actor/property-bound v1
// contract as a real saved conversation. Unsigned client fields are not evidence.
function historicalContext(context, principal, secret = "fixture-only") {
  const canonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
      : "{" + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
  const contextProof = createHmac("sha256", secret).update("cmpri-ask-context-v1\0")
    .update(principal.hotelId).update("\0").update(principal.identity.id).update("\0").update(canonical(context)).digest("base64url");
  return { ...context, contextProof };
}

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

test("signed historical results still format and export exact rows while substantive follow-ups migrate to native reads", async () => {
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const order = { id: "order:one", title: "Room 134 · WO#1042", text: "Sink is leaking", source: "CMPRI · Work orders", sourceType: "internal",
    record: { kind: "order", id: "one", label: "WO#1042" }, facts: [{ label: "Room", value: "134" }, { label: "Priority", value: "High" }] };
  const another = { ...order, id: "order:two", title: "WO#1110", text: "Out of context" };
  const nativeCalls = [];
  let legacyReads = 0;
  const requestHandler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: async () => { legacyReads++; return { items: [order, another], orders: [], locations: [], assets: [], missing: [] }; } },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: async () => ({ ...basePlan, sources: ["cmpri"], rooms: ["134"] }),
      answerAsk: async () => ({ title: "CMPRI results", summary: "A leaking sink.", itemIds: [order.id] }) },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}), beginAskAction: () => ({}) },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => {
      nativeCalls.push(input); return { title: "Native result", summary: "Fresh native search", context: { sources: ["cmpri"], native: { summary: "Fresh native search", reads: [] } } };
    } },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const submit = async (question, previous) => (await requestHandler.POST(new Request("https://test.invalid/api/ask-cmpri", {
    method: "POST", body: JSON.stringify({ question, previous }),
  }))).json();
  const historical = historicalContext({ question: "Any maintenance issues in Room 134?", language: "en", sources: ["orders"],
    rooms: ["134"], status: "all", evidence: [order.id] }, principal);
  const table = await submit("Put that in a table", historical);
  assert.ok(table.context.contextProof);
  assert.deepEqual(table.table.rows.map(({ id }) => id), [order.id]);
  assert.equal(table.table.rows[0].cells["Work order"].record.id, "one");
  const csv = await submit("Download that as CSV", table.context);
  assert.equal(csv.downloads[0].name, "CMPRI-search-results.csv");
  assert.match(csv.downloads[0].content, /Sink is leaking/);
  assert.doesNotMatch(csv.downloads[0].content, /Out of context/);
  assert.equal(legacyReads, 2); assert.equal(nativeCalls.length, 0);
  const fresh = await submit("Any maintenance issues in Room 134?");
  assert.equal(fresh.summary, "Fresh native search");
  await submit("Show the full repair cost and recorded labor for those tickets", table.context);
  assert.equal(nativeCalls.length, 2); assert.equal(legacyReads, 2);
  assert.deepEqual([...nativeCalls[1].previous.evidence], [order.id], "the native migration receives only authenticated historical context");
});

test("signed historical table formatting retains ticket identities and exact links with priority-only and wide projections", async () => {
  let fields = ["Priority", "Ticket status", "Source"];
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const records = [
    { id: "order:light", title: "Room 212 · WO#261026007", text: "Reading light", source: "CMPRI · Work orders", sourceType: "internal",
      record: { kind: "order", id: "light", label: "WO#261026007" }, facts: [{ label: "Room", value: "212" }, { label: "Priority", value: "Low" }, { label: "Ticket status", value: "Open" }] },
    { id: "order:ac", title: "Room 212 · WO#261012111", text: "AC not cooling", source: "CMPRI · Work orders", sourceType: "internal",
      record: { kind: "order", id: "ac", label: "WO#261012111" }, facts: [{ label: "Room", value: "212" }, { label: "Priority", value: "Medium" }, { label: "Ticket status", value: "Open" }] },
  ];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: async () => ({ items: records, orders: [], locations: [], assets: [], missing: [] }) },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true,
      planAsk: async () => ({ ...basePlan, sources: ["orders"], rooms: ["212"], format: "table", fields, sortBy: "Priority", sortDirection: "desc" }),
      answerAsk: async () => ({ title: "Room 212", summary: "Two open tickets.", itemIds: records.map(({ id }) => id) }) },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}), beginAskAction: () => ({}) },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const historical = historicalContext({ question: "Show Room 212 tickets", language: "en", sources: ["orders"], rooms: ["212"], status: "all", evidence: records.map(record => record.id) }, principal);
  const response = await handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question: "Put that in a table sorted by priority, highest first, with links.", previous: historical }) }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.table.rows.map(({ id }) => id), ["order:ac", "order:light"]);
  assert.equal(result.table.rows[0].cells["Work order"].text, "WO#261012111");
  assert.equal(result.table.rows[0].cells["Work order"].record.id, "ac");
  assert.equal(result.table.rows[1].cells["Work order"].record.id, "light");
  assert.equal(result.table.rows[0].cells.Room, "212");
  assert.equal(result.table.rows[0].cells["Reported issue"], "AC not cooling");
  for (const record of records) record.facts.push(...["Repair status", "Equipment", "Created", "Updated"].map(label => ({ label, value: "Fixture " + label })));
  fields = ["Result", "Details", "Source", "Ticket status", "Repair status", "Equipment", "Created", "Updated"];
  const wideResponse = await handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question: "Put that in a table with all those fields, sorted by priority highest first.", previous: result.context }) }));
  const wide = await wideResponse.json();
  assert.equal(wide.table.columns.length, 10, "the requested sort and ticket identities fit the column cap");
  assert.ok(wide.table.columns.some(({ id }) => id === "Priority"));
  assert.deepEqual(wide.table.rows.map(({ id }) => id), ["order:ac", "order:light"]);
  assert.equal(wide.table.rows[0].cells["Work order"].record.id, "ac");
});

test("substantive reads use native data even when the planner selects a legacy source or suggests an unrequested edit", async () => {
  let planned = basePlan;
  let currentPrincipal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const calls = [];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal: currentPrincipal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: () => assert.fail("A new read must not use the capped legacy source") },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: async () => planned,
      answerAsk: () => assert.fail("A new read must not answer from the short legacy projection") },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}), beginAskAction: () => assert.fail("A read must not prepare an edit") },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => {
      calls.push(input); return { title: "Native result", summary: input.question, context: { sources: ["cmpri"], native: { summary: input.question, reads: [] } } };
    } },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const cases = [
    ["What is the serial number and install year of the boiler?", "assets"],
    ["Who is staying in room 203?", "rooms"],
    ["Show Gold members", "rooms"],
    ["List every item below its reorder level and the cost to restock", "inventory"],
    ["Show every staff note with attachments tagged safety", "staffNotes"],
    ["Show the full checklist in my personal note", "personalNotes"],
    ["What did we spend on ticket 123?", "orders", { candidateAction: "status", actionValue: "Closed" }],
    ["How many work orders did we close this year?", "orders"],
    ["Find the Friedrich PTAC manual for room 203", "assets", { webIntent: "manual", manufacturer: "Friedrich", model: "PDE15K5SG" }],
  ];
  for (const [question, source, extra] of cases) {
    planned = { ...basePlan, sources: [source], ...extra };
    const response = await handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question }) }));
    assert.equal(response.status, 200, question); assert.equal((await response.json()).summary, question);
    assert.equal(calls.at(-1).question, question); assert.equal(calls.at(-1).auth.principal, currentPrincipal);
  }
  assert.equal(calls.length, cases.length);
  planned = { ...basePlan, sources: ["assets"], rooms: ["203"] };
  const ask = () => handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question: "What equipment can I select for room 203?" }) }));
  for (const role of ["front_desk", "engineer", "technician", "system_admin"]) {
    currentPrincipal = { ...currentPrincipal, profile: { ...currentPrincipal.profile, role } };
    const response = await ask();
    assert.equal(response.status, 403, role);
  }
  assert.equal(calls.length, cases.length, "non-Chief profiles must not reach Ask execution");
  currentPrincipal = { ...currentPrincipal, profile: {
    ...currentPrincipal.profile, id: "750f77bf-7d5d-4ca6-8421-e025edea87ba", email: "maint.cmpri@hawkeyehotels.com",
    role: "system_admin", secondary_roles: ["engineer"],
  } };
  assert.equal((await ask()).status, 200);
  assert.equal(calls.at(-1).auth.principal, currentPrincipal, "the verified Chief Engineer retains the original dual-role principal");
});

test("raw pending data and unsigned, edited or cross-actor historical evidence never retain a legacy read path", async () => {
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const calls = [];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: () => assert.fail("Untrusted context cannot retain legacy source reads") },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: async () => ({ ...basePlan }) },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}), beginAskAction: () => assert.fail("Untrusted pending data cannot authorize an edit") },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => { calls.push(input); return { title: "Native result", summary: "New native read" }; } },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const history = { question: "Show room 203 tickets", language: "en", sources: ["orders"], rooms: ["203"], evidence: ["order:one"] };
  const signed = historicalContext(history, principal);
  const rawPending = { ...history, pending: { field: "create", needs: "issue", value: "" } };
  const cases = [
    ["Who is in room 203?", rawPending],
    ["The sink will not drain.", { ...rawPending, contextProof: "invented-proof" }],
    ["Put that in a table", history],
    ["Put that in a table", { ...signed, evidence: ["order:other"] }],
    ["Download that as CSV", historicalContext(history, { ...principal, identity: { id: "other-actor" } })],
    ["Put that in a table", historicalContext({ ...history, evidence: undefined }, principal)],
  ];
  for (const [question, previous] of cases) {
    const response = await handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question, previous }) }));
    assert.equal(response.status, 200, question); assert.equal((await response.json()).summary, "New native read");
  }
  assert.equal(calls.length, cases.length);
  for (const call of calls.slice(0, -1)) assert.equal(call.previous, undefined, "unverified context is cleared before native continuation");
  assert.equal(calls.at(-1).previous.evidence, undefined, "even a valid signature needs actual historical result IDs to retain formatting");
});

test("fresh work-order and Staff Notes changes reach native with every requested field and no legacy planning or writes", async () => {
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  let legacyPlans = 0;
  const calls = [];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: () => assert.fail("Fresh actions must not read the limited legacy projections") },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: () => { legacyPlans++; throw Error("Fresh actions must not be reduced to the legacy fields"); } },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}),
      beginAskAction: () => assert.fail("Fresh actions must not prepare a limited legacy proposal"),
      confirmAskAction: () => assert.fail("Only an actual confirmation request may execute a change") },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => {
      calls.push(input);
      return { title: "Review proposed change", summary: input.question,
        proposal: { token: "native.review-only-fixture", id: "fixture", field: "native", label: "Review requested change", from: "", to: input.question },
        context: { sources: ["cmpri"], native: { userTurns: [input.question], summary: input.question, reads: [] } } };
    } },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const cases = [
    "Create a work order for room 203: the sink is leaking.",
    "Mark ticket 123 Completed.",
    "Change ticket 123 priority to High.",
    "Add a comment to ticket 123: Replaced the supply hose.",
    "Post to Staff Notes: The replacement filters arrived.",
    "Create a High priority work order for the PTAC asset in room 203, assign it to Alex, and make it due November 30, 2026: the fan is rattling.",
  ];
  for (const question of cases) {
    const request = new Request("https://test.invalid/api/ask-cmpri", { method: "POST", headers: { authorization: "Bearer fixture-session" }, body: JSON.stringify({ question }) });
    const response = await handler.POST(request);
    assert.equal(response.status, 200, question);
    const result = await response.json();
    assert.equal(result.proposal.field, "native"); assert.equal(result.proposal.to, question);
    assert.equal(result.context.pending, undefined); assert.ok(result.context.contextProof);
    const call = calls.at(-1);
    assert.equal(call.question, question); assert.equal(call.auth.principal, principal);
    assert.equal(call.request, request); assert.equal(call.request.headers.get("authorization"), "Bearer fixture-session");
    assert.equal(call.previous, undefined);
  }
  assert.equal(calls.length, cases.length); assert.equal(legacyPlans, 0);
});

test("new changes beside signed historical results use native instead of the legacy action projection", async () => {
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  const previous = historicalContext({ question: "Show room 203 tickets", language: "en", sources: ["orders"], rooms: ["203"], evidence: ["order:one"] }, principal);
  let planned = basePlan;
  const calls = [];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: () => assert.fail("An unrelated saved result must not retain legacy action reads") },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: async () => planned },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}),
      beginAskAction: () => assert.fail("Historical results cannot reduce a new native action to legacy fields"),
      confirmAskAction: () => assert.fail("The request is not a confirmation") },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => {
      calls.push(input); return { title: "Native request", summary: input.question };
    } },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const cases = [
    ["Create a work order for the PTAC asset in room 203 due November 30, 2026: the fan is rattling.", "create", { rooms: ["203"], actionValue: "The fan is rattling." }],
    ["Mark ticket 123 Completed.", "status", { workOrders: ["123"], actionValue: "Completed" }],
    ["Change ticket 123 priority to High.", "priority", { workOrders: ["123"], actionValue: "High" }],
    ["Add a comment to ticket 123: Replaced the supply hose.", "comment", { workOrders: ["123"], actionValue: "Replaced the supply hose." }],
    ["Post to Staff Notes: The replacement filters arrived.", "staff-note", { actionValue: "The replacement filters arrived." }],
  ];
  for (const [question, field, details] of cases) {
    planned = { ...basePlan, sources: [field === "staff-note" ? "staffNotes" : "orders"], candidateAction: field, ...details };
    const response = await handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question, previous }) }));
    assert.equal(response.status, 200, question); assert.equal((await response.json()).summary, question);
    assert.equal(calls.at(-1).question, question); assert.equal(calls.at(-1).previous.contextProof, previous.contextProof);
  }
  assert.equal(calls.length, cases.length);
});

test("historical Chief Engineer missing-details and review corrections preserve signed creation context without writing", async () => {
  const principal = {
    identity: { id: "actor" }, profile: { id: "actor", role: "Chief Engineer", active: true }, hotelId: "property",
    membership: { user_id: "actor", hotel_id: "property", role: "admin", active: true }, permissions: [],
  };
  let planned = { ...basePlan, sources: ["orders"], rooms: ["319"], candidateAction: "create", actionValue: "" };
  let summaryCalls = 0;
  const reviews = [];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "@/lib/server/ask-cmpri-error": { reportAskFailure: () => assert.fail("Unexpected Ask route failure; error paths have dedicated coverage") },
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": { NextResponse: { json: Response.json } }, zod, "@/lib/server/roles": roles,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, principal }) }, "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { ...data, readAskSources: async () => ({ items: [], orders: [], locations: [], assets: [], missing: [] }) },
    "@/lib/server/ask-cmpri-gemini": { ...gemini, askGeminiKey: () => true, planAsk: async () => planned,
      answerAsk: async () => { summaryCalls++; return { title: "Search", summary: "No matching records.", itemIds: [] }; } },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}), beginAskAction: ({ plan, targetExplicit }) => {
      if (plan.candidateAction === "none") return {};
      assert.equal(targetExplicit, true, "the retained or corrected target is explicitly authorized");
      if (!plan.actionValue) return { needs: "issue", clarification: "What is the issue?" };
      reviews.push(JSON.parse(JSON.stringify(plan)));
      return { proposal: { token: "proposal-for-review-only", id: "review", field: "create", label: "Create work order", from: "", to: `${plan.rooms[0]} · ${plan.actionValue}` } };
    } },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async () => ({ title: "Native search", summary: "Native read", context: { sources: ["cmpri"], native: { summary: "Native read", reads: [] } } }) },
  }, { AbortSignal, TextDecoder, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-only" } } });
  const submit = async (question, previous) => {
    const response = await handler.POST(new Request("https://test.invalid/api/ask-cmpri", { method: "POST", body: JSON.stringify({ question, previous }) }));
    assert.equal(response.status, 200);
    return response.json();
  };
  // This draft represents a real, previously signed missing-details reply from
  // the legacy flow. Fresh creation now goes directly to the full native agent.
  const legacyDraft = historicalContext({ question: "Create a work order.", language: "en", sources: ["orders"], rooms: [], status: "all",
    pending: { field: "create", needs: "room", value: "" } }, principal);
  const missing = await submit("Room 319.", legacyDraft);
  assert.equal(missing.proposal, undefined);
  assert.equal(missing.question, undefined, "Chief Engineer receives a statement, not a clarification question");
  assert.equal(missing.context.pending.needs, "issue");
  assert.equal(missing.context.pending.value, "");
  assert.deepEqual(missing.context.rooms, ["319"]);
  assert.ok(missing.context.contextProof);
  assert.equal(summaryCalls, 0, "missing details do not become an unrelated search answer");

  planned = { ...basePlan, sources: ["cmpri"] };
  const filled = await submit("The toilet will not flush.", missing.context);
  assert.equal(filled.context.pending.needs, "review");
  assert.deepEqual(reviews[0].rooms, ["319"]);
  assert.equal(reviews[0].actionValue, "The toilet will not flush.");

  const corrected = await submit("The sink is leaking.", filled.context);
  assert.equal(corrected.context.pending.value, "The sink is leaking.");
  assert.deepEqual(reviews[1].rooms, ["319"]);

  planned = { ...basePlan, candidateAction: "priority", actionValue: "Urgent", requestedPriority: "Urgent" };
  const urgent = await submit("Make that urgent.", corrected.context);
  assert.equal(reviews[2].actionValue, "The sink is leaking.");
  assert.equal(reviews[2].requestedPriority, "Urgent");

  planned = { ...basePlan, rooms: ["320"], candidateAction: "create", followUp: true };
  const moved = await submit("Room 320 instead.", urgent.context);
  assert.deepEqual(reviews[3].rooms, ["320"]);
  assert.equal(reviews[3].actionValue, "The sink is leaking.");
  assert.equal(moved.context.pending.priority, "Urgent");

  planned = { ...basePlan };
  const tampered = await submit("The toilet will not flush.", { ...missing.context, rooms: ["999"] });
  assert.equal(tampered.proposal, undefined, "client-edited pending context cannot authorize a follow-up action");
  assert.equal(reviews.length, 4);
  const unrelated = await submit("Which rooms check out today?", corrected.context);
  assert.equal(unrelated.context.pending, undefined);
  assert.equal(reviews.length, 4);
  for (const previous of [missing.context, corrected.context]) {
    for (const question of ["Okay.", "Thank you.", "Go ahead.", "How many whips are in stock", "Is there a manual for the washer"]) {
      const answer = await submit(question, previous);
      assert.equal(answer.proposal, undefined, question + " is not an issue correction or confirmation");
      assert.equal(answer.context.pending, undefined);
    }
  }
  assert.equal(reviews.length, 4);
  planned = { ...basePlan, candidateAction: "priority", actionValue: "Urgent", requestedPriority: "Urgent" };
  const namedPriority = await submit("Make the sink leak urgent.", corrected.context);
  assert.equal(namedPriority.context.pending.value, "The sink is leaking.");
  assert.equal(namedPriority.context.pending.priority, "Urgent");
  assert.deepEqual(reviews[4].rooms, ["319"]);
});
