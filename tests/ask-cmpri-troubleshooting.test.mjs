import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { loadTs } from "./helpers/load-ts.mjs";
import { parseTicketHistory } from "../src/lib/ticket-note-presentation.ts";
import * as roles from "../src/lib/server/roles.ts";

const workOrderId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const hotel = "synthetic-property";

function fixture(canRead = true, issue = "Washer shows error code F9E1. Private reporter text.", role = "chief_engineer") {
  const queries = [], publicQueries = [], answers = [];
  const order = {
    id: workOrderId, hotel_id: hotel, asset_id: assetId, issue, technician_name: "Taylor Technician", action_root_cause: "Drain test ran for three minutes.",
    notes: "CMPRI2|2026-11-10T12:00:00Z|Taylor Technician|Maintenance Technician|note|Tried the filter. No change.\nCMPRI2|2026-11-10T12:05:00Z|Desk|Front Desk|note|Private unscoped note.",
  };
  const asset = { id: assetId, hotel_id: hotel, active: true, manufacturer: "Whirlpool", model_number: "WFW5620HW", documentation_revision_id: otherId, documentation_verified_at: null };
  const principal = { hotelId: hotel, profile: { role } };
  const admin = {
    from(table) {
      const filters = [];
      queries.push({ table, filters });
      const query = {
        select() { return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        async maybeSingle() {
          const item = table === "work_orders" ? order : asset;
          return { data: filters.every(([field, value]) => item[field] === value) ? item : null, error: null };
        },
      };
      return query;
    },
  };
  const { POST } = loadTs("src/app/api/ask-cmpri/troubleshooting/route.ts", {
    "next/server": { NextResponse: Response }, zod: { z },
    "@/lib/manual-knowledge": { normalizeManualKnowledge: input => input },
    "@/lib/manual-source": { reportedDiagnosticCode: input => /\bcode F9E1\b/i.test(input) ? "F9E1" : null },
    "@/lib/server/access": { allows: () => canRead },
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, mcp: false, principal, admin }) },
    "@/lib/server/roles": roles,
    "@/lib/server/uploaded-asset-guide": { loadUploadedAssetGuide: async () => ({ documentation_status: "verified", manualKnowledge: { source: { verified: true } } }) },
    "@/lib/server/work-order-reader": { workOrderReader: () => ({}) },
    "@/lib/ticket-note-presentation": { parseTicketHistory },
    "@/lib/uuid": { isUuid: value => /^[\da-f-]{36}$/i.test(value) },
    "@/lib/work-order-read-policy": { canReadWorkOrder: () => true },
    "@/lib/work-orders/troubleshooting-checklist": { deriveTroubleshootingChecklistContext: () => ({ steps: [{ id: "step-1", label: "Inspect the verified drain source.", sourcePages: [13] }] }) },
    "@/lib/server/ask-cmpri-gemini": {
      answerAsk: async input => { answers.push(input); return { title: "Troubleshooting", summary: "See the documented drain checks." }; },
      askGeminiKey: () => "unit-test-key",
      publicAskQuery: (plan, question, verified) => { publicQueries.push({ plan, question, verified }); return "synthetic safe public search"; },
      searchPublicAsk: async () => [{ id: "web-1", title: "Whirlpool Product Help", href: "https://producthelp.whirlpool.com/", source: "Whirlpool", sourceType: "web" }],
    },
  }, { AbortSignal });
  return { queries, publicQueries, answers, run: values => POST(new Request("https://cmpri.invalid/api/ask-cmpri/troubleshooting", { method: "POST", body: JSON.stringify({ workOrderId, assetId, ...values }) })) };
}

test("the ticket Ask entry point denies a technician even with existing ticket and PM permissions", async () => {
  const h = fixture(true, undefined, "technician");
  assert.equal((await h.run({})).status, 403);
  assert.equal(h.queries.length + h.answers.length, 0);
});

test("initial troubleshooting opens approved manufacturer guidance and supplies only scoped technician findings as private context", async () => {
  const f = fixture();
  assert.equal((await f.run({ assetId: otherId, web: true })).status, 409);
  assert.equal(f.publicQueries.length, 0);
  assert.equal((await f.run({ web: false })).status, 200);
  assert.equal(f.publicQueries.length, 0);
  const response = await f.run({});
  assert.equal(response.status, 200);
  const items = (await response.json()).items;
  assert.match(items[0].text, /Tried the filter.*No change/);
  assert.equal(items[1].href, "https://producthelp.whirlpool.com/");
  assert.deepEqual(f.queries.at(-1).filters, [["hotel_id", hotel], ["id", assetId]]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.publicQueries)), [{ verified: true, question: "Error code F9E1", plan: { manufacturer: "Whirlpool", model: "WFW5620HW", webIntent: "error-code", errorCode: "F9E1" } }]);
  assert.equal(f.answers.at(-1).items[0].facts[0].value, "13");
  assert.doesNotMatch(JSON.stringify(f.answers.at(-1).items), /Private unscoped note/);
  assert.match(f.answers.at(-1).items.at(-1).text, /Drain test ran for three minutes/);
  assert.doesNotMatch(JSON.stringify(f.publicQueries), /private|Tried the filter|Drain test/i);
});

test("a guest code on the work order cannot become a manufacturer diagnostic query", async () => {
  const f = fixture(true, "Washer does not drain. Guest code F9E1.");
  assert.equal((await f.run({})).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(f.publicQueries)), [{ verified: true, question: "Official manufacturer troubleshooting manual", plan: { manufacturer: "Whirlpool", model: "WFW5620HW", webIntent: "manual", errorCode: "" } }]);
});

test("troubleshooting refuses unauthorized accounts before touching records or a provider", async () => {
  const f = fixture(false);
  assert.equal((await f.run({ web: true })).status, 403);
  assert.equal(f.queries.length, 0);
  assert.equal(f.answers.length, 0);
  assert.equal(f.publicQueries.length, 0);
});
