import assert from "node:assert/strict";
import test from "node:test";
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
const data = loadTs("src/lib/server/ask-cmpri-data.ts", {
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
});

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
