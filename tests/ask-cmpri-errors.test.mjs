import assert from "node:assert/strict";
import test from "node:test";
import * as ai from "ai";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const privateText = "PRIVATE prompt guest-420 api-key bearer storage-token user-id";
function providerError(statusCode = 400, reason = "INVALID_ARGUMENT") {
  return new ai.APICallError({ message: privateText, url: "https://provider.invalid/" + privateText,
    requestBodyValues: { question: privateText }, responseHeaders: { authorization: privateText }, responseBody: privateText,
    statusCode, data: { error: { code: statusCode, message: privateText, status: statusCode === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, metadata: { consumer: privateText } }] } } });
}
function diagnostics() {
  const logs = [];
  const helper = loadTs("src/lib/server/ask-cmpri-error.ts", { "server-only": {}, ai }, {
    console: { error: (...args) => logs.push(args) },
  });
  return { helper, logs };
}

test("provider rejection diagnostics retain only fixed categories, status, reason and a new reference", () => {
  const { helper, logs } = diagnostics();
  const error = providerError();
  // Logging must never inspect/stringify any of these sensitive fields.
  for (const name of ["message", "stack", "url", "requestBodyValues", "responseBody", "responseHeaders"]) {
    Object.defineProperty(error, name, { get() { assert.fail("Read private error field " + name); } });
  }
  const failure = helper.reportAskFailure(error, { language: "en", phase: "native-generate" });
  assert.equal(failure.status, 502);
  assert.equal(failure.body.code, "ai_request_rejected");
  assert.match(failure.body.error, /AI request could not be processed/);
  assert.match(failure.body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(failure.headers["X-CMPRI-Request-ID"], failure.body.requestId);
  assert.deepEqual(plain(logs), [["ask_cmpri_failure", { requestId: failure.body.requestId, phase: "native-generate",
    category: "ai_request_rejected", errorName: "AI_APICallError", providerStatus: 400, providerReason: "INVALID_ARGUMENT" }]]);
  assert.doesNotMatch(JSON.stringify({ failure, logs }), /PRIVATE|guest-420|api-key|bearer|storage-token|user-id|provider\.invalid/);
});

test("invalid credentials, quota, timeout, connection and output failures have separate safe responses", () => {
  const { helper, logs } = diagnostics();
  const key = new ai.RetryError({ message: privateText, reason: "errorNotRetryable", errors: [providerError(400, "API_KEY_INVALID")] });
  const timeout = Object.assign(new Error(privateText), { name: "TimeoutError" });
  const cancelled = Object.assign(new Error(privateText), { name: "AbortError" });
  const output = Object.assign(new Error(privateText), { name: "AI_NoOutputGeneratedError" });
  const network = new ai.APICallError({ message: privateText, url: privateText, requestBodyValues: privateText,
    cause: Object.assign(new Error(privateText), { code: "ECONNRESET" }) });
  for (const [error, code, status, text] of [
    [key, "ai_configuration", 503, /configuration needs attention/],
    [providerError(429, "QUOTA_EXCEEDED"), "ai_quota", 429, /usage limit/],
    [timeout, "timeout", 504, /too long/],
    [cancelled, "cancelled", 499, /was cancelled/],
    [network, "ai_connection", 503, /service is unavailable/],
    [providerError(503), "ai_connection", 503, /service is unavailable/],
    [output, "ai_response_invalid", 502, /unreadable AI response/],
  ]) {
    const failure = helper.reportAskFailure(error, { language: "en", phase: "native-generate" });
    assert.equal(failure.body.code, code); assert.equal(failure.status, status); assert.match(failure.body.error, text);
  }
  assert.equal(logs[0][1].providerReason, "API_KEY_INVALID");
  assert.equal(logs[0][1].providerStatus, 400);
  assert.equal(new Set(logs.map(args => args[1].requestId)).size, 7);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|guest-420|storage-token/);
  const spanish = helper.reportAskFailure(providerError(), { language: "es", phase: "native-generate" });
  assert.match(spanish.body.error, /no pudo procesar la solicitud de IA.*Referencia:/);
});

test("unknown diagnostic fields and cyclic causes cannot leak into a log or response", () => {
  const { helper, logs } = diagnostics();
  const error = providerError(12345, privateText);
  error.name = privateText;
  error.data.error.status = privateText;
  error.cause = error;
  const failure = helper.reportAskFailure(error, { language: "en", phase: privateText });
  assert.equal(failure.body.code, "ai_connection");
  assert.deepEqual(Object.keys(logs[0][1]).sort(), ["category", "errorName", "phase", "requestId"]);
  assert.equal(logs[0][1].errorName, "UnknownError");
  assert.equal(logs[0][1].phase, "unknown");
  assert.doesNotMatch(JSON.stringify({ failure, logs }), /PRIVATE|guest-420|api-key|storage-token/);
});

function routeFixture({ generate, loadError, response } = {}) {
  const { helper, logs } = diagnostics();
  const nativeCalls = [];
  const next = { NextResponse: { json: Response.json } };
  const responseHelper = loadTs("src/lib/server/ask-cmpri-response.ts", { "server-only": {}, "next/server": next },
    { Response, ReadableStream, TextEncoder, Uint8Array });
  const dependencies = {
    "next/server": next, zod,
    "@/lib/server/ask-cmpri-error": helper,
    "../../../lib/server/ask-cmpri-response": response || responseHelper,
    "@/lib/server/roles": { profileIsChiefEngineer: () => true, profileIsEstablishedHoursChief: () => false },
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, mcp: false, principal: {
      identity: { id: "PRIVATE actor" }, hotelId: "PRIVATE hotel", profile: { role: "engineer" },
    } }) },
    "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { askContextSchema: zod.z.object({}).passthrough(),
      readAskSources: () => assert.fail("A failed fresh request must not use legacy reads") },
    "@/lib/server/ask-cmpri-gemini": { askGeminiKey: () => "fixture-key",
      planAsk: () => assert.fail("A fresh request must not use the legacy planner") },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}),
      beginAskAction: () => assert.fail("A failed request must not create a legacy action"),
      confirmAskAction: () => assert.fail("A question must not perform a confirmed write") },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => {
      nativeCalls.push(input); return generate ? generate(input) : { title: "Result", summary: "Verified result", items: [] };
    } },
  };
  if (loadError) Object.defineProperty(dependencies, "@/lib/server/ask-cmpri-native-agent", { get() { throw loadError; } });
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", dependencies,
    { TextDecoder, AbortSignal, Error, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-context-secret" } } });
  const post = question => handler.POST(new Request("https://fixture.invalid/api/ask-cmpri", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + privateText,
      "X-CMPRI-Request-ID": privateText }, body: JSON.stringify({ question }),
  }));
  return { post, logs, nativeCalls };
}

test("the three reported fresh questions return correlated safe provider failures without writes", async () => {
  const f = routeFixture({ generate: async () => { throw providerError(); } });
  const questions = [
    "What can you do inside of my program? Please list the available capabilities and modules I can use through Ask CMPRI for my account.",
    "How many rooms still have portable air conditioners in them?",
    "Is the microwave in 420 working?",
  ];
  for (const question of questions) {
    const response = await f.post(question), body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(body.code, "ai_request_rejected");
    assert.equal(response.headers.get("X-CMPRI-Request-ID"), body.requestId);
    assert.equal(f.logs.at(-1)[1].requestId, body.requestId);
    assert.equal(f.logs.at(-1)[1].phase, "native-generate");
    assert.equal(f.nativeCalls.at(-1).question, question);
    assert.doesNotMatch(JSON.stringify({ body, logs: f.logs }), /PRIVATE|Room 420|portable air|What can you do|Bearer/);
    assert.equal(JSON.stringify({ body, logs: f.logs }).includes(question), false);
  }
  assert.equal(f.nativeCalls.length, 3);
  assert.equal(f.logs.length, 3);
});

test("route diagnostics distinguish module loading from response serialization and leave success unchanged", async () => {
  const loading = routeFixture({ loadError: new Error(privateText) });
  const failedLoad = await loading.post("Show equipment");
  assert.equal(failedLoad.status, 500);
  assert.equal(loading.logs[0][1].phase, "native-load");
  assert.equal(loading.nativeCalls.length, 0);
  const serialization = routeFixture({ generate: () => ({ title: "Result", summary: "Result", invalid: 1n }) });
  const failedResponse = await serialization.post("Show equipment");
  assert.equal(failedResponse.status, 500);
  assert.equal(serialization.logs[0][1].phase, "native-response");
  assert.equal(serialization.logs[0][1].errorName, "TypeError");
  const success = routeFixture();
  const response = await success.post("Show equipment");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: "Result", summary: "Verified result", items: [] });
  assert.equal(response.headers.get("X-CMPRI-Request-ID"), null);
  assert.deepEqual(success.logs, []);
});
