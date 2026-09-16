import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { DASHBOARD_AI_ACTION, MAX_AI_WORK_ORDERS, refreshDashboardAnalysis } from "../src/lib/ai/dashboard-analysis.ts";

const active = { id: "saved-1", display_id: "WO-26-0001", room: "103", issue: "Fan is loud; possible bad fan", notes: "No repair performed", status: "Open" };
function fixture(overrides = {}) {
  const calls = { read: 0, generate: [] };
  return { calls, dependencies: {
    authenticate: async () => ({ user: "active-user" }),
    readSavedOrders: async () => { calls.read++; return [active]; },
    generate: async (orders) => { calls.generate.push(orders); return JSON.stringify({ summaries: orders.map(({ id, issue }) => ({ id, summary: issue })) }); },
    ...overrides,
  } };
}
const action = { action: DASHBOARD_AI_ACTION };

test("unauthenticated requests cannot read saved orders or invoke AI", async () => {
  const { calls, dependencies } = fixture({ authenticate: async () => null });
  assert.equal((await refreshDashboardAnalysis(action, dependencies)).status, 401);
  assert.equal(calls.read, 0); assert.equal(calls.generate.length, 0);
});
for (const body of [null, {}, { issue: "Draft leaking sink", notes: "typing" }, { action: "automatic-refresh" }]) {
  test(`missing manual action blocks provider: ${JSON.stringify(body)}`, async () => {
    const { calls, dependencies } = fixture();
    assert.equal((await refreshDashboardAnalysis(body, dependencies)).status, 400);
    assert.equal(calls.read, 0); assert.equal(calls.generate.length, 0);
  });
}
test("manual refresh uses saved context, excludes submitted drafts and private DB fields", async () => {
  const { calls, dependencies } = fixture({ readSavedOrders: async () => [{ ...active, creator_email: "private@example.test" }] });
  const result = await refreshDashboardAnalysis({ ...action, issue: "Fabricated replacement", notes: "Unsaved" }, dependencies);
  assert.equal(result.status, 200); assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0][0].issue, active.issue);
  assert.equal(calls.generate[0][0].notes, active.notes);
  assert.equal(calls.generate[0][0].creator_email, undefined);
  assert.equal(result.body.summaries[0].display_id, active.display_id);
});
test("closed, pending, completed and blank saved orders do not trigger a provider request", async () => {
  const rows = ["Closed", "COMPLETED", "Pending Verification", "Cancelled", "Duplicate", "Will Not Do"].map((status) => ({ ...active, status }));
  rows.push({ ...active, issue: "", notes: "" });
  const { calls, dependencies } = fixture({ readSavedOrders: async () => rows });
  const result = await refreshDashboardAnalysis(action, dependencies);
  assert.deepEqual(result.body.summaries, []); assert.equal(calls.generate.length, 0);
});
test("work-order count and input length are bounded", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ ...active, id: `saved-${i}`, issue: "x".repeat(9000), notes: "n".repeat(9000) }));
  const { calls, dependencies } = fixture({ readSavedOrders: async () => rows,
    generate: async (orders) => { calls.generate.push(orders); return JSON.stringify({ summaries: orders.map(({ id }) => ({ id, summary: "Reported issue" })) }); },
  });
  const result = await refreshDashboardAnalysis(action, dependencies);
  assert.equal(calls.generate[0].length, MAX_AI_WORK_ORDERS);
  assert.equal(calls.generate[0][0].issue.length, 1500);
  assert.equal(calls.generate[0][0].notes.length, 2500);
  assert.equal(result.body.limited, true);
});
for (const output of ["invalid", "{}", '{"summaries":[]}', '{"summaries":[{"id":"invented","summary":"Made up"}]}', '{"summaries":[{"id":"saved-1","summary":42}]}', '{"summaries":[{"id":"saved-1","summary":"A"},{"id":"saved-1","summary":"B"}]}']) {
  test(`invalid or invented output rejected: ${output}`, async () => {
    const { dependencies } = fixture({ generate: async () => output });
    await assert.rejects(() => refreshDashboardAnalysis(action, dependencies));
  });
}
test("database failure never invokes provider", async () => {
  const { calls, dependencies } = fixture({ readSavedOrders: async () => { throw new Error("DB failed"); } });
  await assert.rejects(() => refreshDashboardAnalysis(action, dependencies));
  assert.equal(calls.generate.length, 0);
});
test("provider failure is surfaced without automatic retry", async () => {
  let count = 0;
  const { dependencies } = fixture({ generate: async () => { count++; throw new Error("Unavailable"); } });
  await assert.rejects(() => refreshDashboardAnalysis(action, dependencies)); assert.equal(count, 1);
});

const dashboardPath = new URL("../src/app/engineering/page.tsx", import.meta.url);
const dashboard = readFileSync(dashboardPath, "utf8");
const ast = ts.createSourceFile("page.tsx", dashboard, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const allNodes = [];
function walk(node) { allNodes.push(node); ts.forEachChild(node, walk); }
walk(ast);
const handler = allNodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "requestAIRefresh");
function clientHarness(token = "test-token") {
  const requests = [], messages = [], summaries = [];
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const context = { aiInFlightRef: { current: false }, setAiRefreshing() {},
    setAiSummaries: (items) => summaries.push(items), setAiRefreshMessage: (message) => messages.push(message),
    supabase: { auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) } },
    getValidSession: async () => token ? { access_token: token } : null,
    DASHBOARD_AI_ACTION, fetch: async (...args) => { requests.push(args); return pendingFetch; },
    window: { localStorage: { getItem: () => "", setItem: () => {} } },
    crypto: { randomUUID: () => "test_device_id_0001" },
    getOrCreateAiDeviceId: () => "test_device_id_0001",
  };
  return { requests, messages, summaries, click: vm.runInNewContext(`(${handler.getText(ast)})`, context),
    resolve: () => resolveFetch({ ok: true, json: async () => ({ summaries: [{ id: active.id, summary: active.issue }], generated_at: "2026-09-15T01:00:00Z" }) }),
  };
}
test("dashboard click immediately posts authenticated action once, blocks duplicate clicks and shows returned summaries", async () => {
  const h = clientHarness();
  const first = h.click(); const second = h.click();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0], "/api/maintenance-ai");
  assert.equal(h.requests[0][1].headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(h.requests[0][1].body), { ...action, device_id: "test_device_id_0001" });
  h.resolve(); await Promise.all([first, second]);
  assert.equal(h.summaries.at(-1)[0].id, active.id);
  assert.match(h.messages.at(-1), /summaries refreshed/);
});
test("dashboard with no session makes no AI endpoint call", async () => {
  const h = clientHarness(null); await h.click();
  assert.equal(h.requests.length, 0); assert.match(h.messages.at(-1), /Sign in/);
});
test("refresh handler is bound only to the button, never effects, timers or typing", () => {
  const references = allNodes.filter((node) => ts.isIdentifier(node) && node.text === "requestAIRefresh");
  assert.equal(references.length, 2);
  const binding = references.find((node) => ts.isJsxExpression(node.parent));
  assert.ok(binding); assert.equal(binding.parent.parent.name.text, "onClick");
});
test("application AI provider and endpoint call sites are confined to the manual dashboard path", () => {
  const sources = [];
  function collect(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name); if (item.isDirectory()) collect(path);
    else if (/\.(?:tsx?|mjs|js)$/.test(path)) sources.push([path, readFileSync(path, "utf8")]);
  } }
  collect(new URL("../src/", import.meta.url).pathname);
  collect(new URL("../scripts/", import.meta.url).pathname);
  const providerFiles = sources.filter(([, text]) => /from ["']openai["']|responses\.create\(|api\.openai\.com/.test(text));
  assert.equal(providerFiles.length, 1); assert.match(providerFiles[0][0], /api\/maintenance-ai\/route\.ts$/);
  assert.match(providerFiles[0][1], /maxRetries: 0/);
  const callers = sources.filter(([, text]) => text.includes('"/api/maintenance-ai"'));
  assert.equal(callers.length, 1); assert.match(callers[0][0], /engineering\/page\.tsx$/);
  for (const [, text] of sources) assert.doesNotMatch(text, /cmpri:ai-refresh-request|runMaintenanceAI|analyzeDocumentation/);
});
