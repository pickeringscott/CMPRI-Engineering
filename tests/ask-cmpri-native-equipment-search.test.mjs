import assert from "node:assert/strict";
import test from "node:test";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const assetId = "7cb6ebce-9988-4374-b9fd-c6c99bfbd97b";
const otherAsset = "619dd91e-f333-4b7a-9982-d456c8be8c6c";
const original = "https://docs.vendorco.com/support/manual.pdf";
const redirected = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fixture";
const document = loadTs("src/lib/server/ask-cmpri-public-document.ts", { "server-only": {} }, { URL, AbortSignal });
const source = url => ({ sourceType: "url", url, title: "Original equipment support" });
const plain = value => JSON.parse(JSON.stringify(value));
class NativeRequest extends Request { get nextUrl() { return new URL(this.url); } }

function fixture() {
  const calls = [], nativeReads = [], redirects = [];
  const state = {
    assets: [{ id: assetId, manufacturer: "Friedrich", model_number: "PZE09K3SB", model_family: "PTAC", serial_number: "PRIVATE-SERIAL-123",
      name: "Private asset name", room: "212", issue: "Guest Jane saw F3E1", guest: "Jane", notes: "Private property maintenance note" }],
    status: 200, error: undefined, afterRead: undefined,
    result: { sources: [source(original)], providerMetadata: { google: { groundingMetadata: {
      groundingChunks: [{ web: { uri: original } }], groundingSupports: [{ groundingChunkIndices: [0], segment: { text: "The actual source supplies equipment support." } }],
    } } } },
  };
  const transport = loadTs("src/lib/server/ask-cmpri-public-search.ts", {
    "server-only": {},
    "./ask-cmpri-gemini": { askGeminiKey: () => "fixture-google-key" },
    "./ask-cmpri-public-document": document,
    "@ai-sdk/google": { createGoogleGenerativeAI: () => Object.assign(model => model, { tools: { googleSearch: () => "actual-grounding-tool" } }) },
    ai: { generateText: async options => { calls.push(options); if (state.error) throw state.error; return state.result; } },
  }, {
    URL, AbortSignal, process: { env: { CMPRI_GEMINI_MODEL: "fixture-model" } },
    fetch: async (url, options) => { redirects.push({ url: String(url), options }); return new Response(null, { status: 302, headers: { location: original } }); },
  });
  const native = loadTs("src/lib/server/ask-cmpri-native-equipment-search.ts", {
    "server-only": {}, zod, "next/server": { NextRequest: NativeRequest },
    "./ask-cmpri-public-search": transport, "./ask-cmpri-public-document": document,
    "@/app/api/assets/route": { GET: async request => {
      nativeReads.push(request);
      state.afterRead?.();
      return Response.json(state.status === 200 ? { assets: plain(state.assets) } : { error: "Original native role denied" }, { status: state.status });
    } },
  }, { URL, Error });
  const request = new NativeRequest("https://cmpri.invalid/api/ask-cmpri", { method: "POST", headers: {
    Authorization: "Bearer current-actor", Cookie: "Private-session=cookie", "X-Api-Key": "Private-service-key",
  } });
  const run = (params, userTurns = [], extra = {}) => native.searchAskNativeEquipment(request, params, {
    userTurns, signal: new AbortController().signal, ...extra,
  });
  return { calls, nativeReads, redirects, state, run };
}

test("arbitrary real manufacturer/model formats use fixed public queries without legacy whitelists", async () => {
  const f = fixture();
  for (const [manufacturer, model] of [["Friedrich", "PZE09K3SB"], ["Dormakaba", "790"], ["Whirlpool", "WFW8620HW"], ["UniMac", "UW 65/S"], ["A. O. Smith", "BTH-199 (A)"], ["Unlisted Maker & Co.", "123456789012345678901234567890123456789"]]) {
    const answer = await f.run({ manufacturer, model, intent: "manual" }, [`Find the ${manufacturer} ${model} service manual. Guest Jane is in room 212; serial PRIVATE-SERIAL-123.`]);
    assert.equal(f.calls.at(-1).prompt, `${manufacturer} ${model} official manufacturer owner or service manual PDF`);
    assert.equal(answer.manufacturer, manufacturer);
    assert.equal(answer.model, model);
    assert.equal(answer.items[0].href, original);
  }
  await f.run({ manufacturer: "Friedrich", model: "PZE09K3SB", intent: "manufacturer" }, ["Manufacturer: Friedrich. Model: PZE09K3SB."]);
  assert.equal(f.calls.at(-1).prompt, "Friedrich PZE09K3SB official manufacturer specifications and support");
  assert.doesNotMatch(JSON.stringify(f.calls), /Jane|room 212|PRIVATE-SERIAL|Private-session|current-actor|Private-service-key/);
  assert.equal(f.nativeReads.length, 0, "Explicit public identity needs no unrelated private record lookup");
});

test("fresh native identity uses the current actor and property read gate every time", async () => {
  const f = fixture();
  await f.run({ assetId, intent: "manual" }, ["Find the actual asset manual."]);
  assert.equal(f.calls[0].prompt, "Friedrich PZE09K3SB official manufacturer owner or service manual PDF");
  const request = f.nativeReads[0];
  assert.equal(request.url, "https://cmpri.invalid/api/assets?scope=property&include_documentation=false");
  assert.equal(request.method, "GET");
  assert.deepEqual([...request.headers], [["authorization", "Bearer current-actor"]]);
  assert.doesNotMatch(JSON.stringify(f.calls), /serial|PRIVATE|Jane|212|property maintenance/i);
  f.state.assets[0].manufacturer = "Dormakaba"; f.state.assets[0].model_number = "790";
  const refreshed = await f.run({ assetId, intent: "manufacturer" });
  assert.equal(refreshed.model, "790");
  assert.equal(f.calls[1].prompt, "Dormakaba 790 official manufacturer specifications and support");
  await assert.rejects(f.run({ assetId, manufacturer: "Friedrich", model: "PZE09K3SB", intent: "manual" }), /differs from the current native asset/);
  for (const status of [401, 403]) {
    f.state.status = status;
    await assert.rejects(f.run({ assetId, intent: "manual" }), /current CMPRI account cannot read/);
  }
  f.state.status = 200;
  await assert.rejects(f.run({ assetId: otherAsset, intent: "manual" }), /not available to this CMPRI account/);
  assert.equal(f.calls.length, 2, "Denial, a missing current record and stale identity all stop before public search");
  assert.equal(f.nativeReads.length, 6);
});

test("explicit new error codes and signed-turn follow-ups work without manufacturer/code lists", async () => {
  const f = fixture();
  for (const model of ["WFW8620HW", "WFW5620HW"]) {
    await f.run({ manufacturer: "Whirlpool", model, errorCode: "F3E1", intent: "error-code" }, [`Whirlpool ${model}`, "What does F3E1 mean?"]);
    assert.equal(f.calls.at(-1).prompt, `Whirlpool ${model} official manufacturer error code F3E1`);
  }
  await f.run({ assetId, errorCode: "F3E1", intent: "error-code" }, ["Guest Jane is in room 212. The actual equipment error code is F3E1."]);
  assert.equal(f.calls.at(-1).prompt, "Friedrich PZE09K3SB official manufacturer error code F3E1");
  await f.run({ manufacturer: "UniMac", model: "UW 65/S", errorCode: "E-37.2", intent: "error-code" }, ["Marca: UniMac. Modelo: UW 65/S.", "¿Qué significa E-37.2?"]);
  assert.equal(f.calls.at(-1).prompt, "UniMac UW 65/S official manufacturer error code E-37.2");
  await assert.rejects(f.run({ assetId, errorCode: "F3E1", intent: "error-code" }, ["Check the work-order description for its code."]), /actual error code in your question/);
  assert.equal(f.calls.length, 4, "A code found only in the native guest issue is not public query authority");
});

test("model assertions, copied record-only fields, guessed identities and private labels cannot authorize public searches", async () => {
  const f = fixture();
  const identity = { manufacturer: "Whirlpool", model: "WFW8620HW", intent: "manual" };
  await assert.rejects(f.run(identity, ["Read my asset records."], { records: [{ manufacturer: "Whirlpool", model: "WFW8620HW" }] }), /exact public manufacturer and model/);
  await assert.rejects(f.run({ ...identity, verified: true }, ["Read my asset records."]), /Unrecognized key/);
  await assert.rejects(f.run({ ...identity, intent: "public-guidance" }, ["Whirlpool WFW8620HW"]), /Invalid option/);
  await assert.rejects(f.run(identity, ["Whirlpool WFW8620HW1"]), /exact public manufacturer and model/);
  for (const turn of ["Guest name: Whirlpool WFW8620HW", "Guest note: Whirlpool WFW8620HW", "Staff note: Whirlpool WFW8620HW"]) {
    await assert.rejects(f.run(identity, [turn]), /exact public manufacturer and model/);
  }
  for (const [manufacturer, model] of [["Guest Jane", "212"], ["Whirlpool", "Room 212"], ["Whirlpool", "PRIVATE-SERIAL-123"], ["Whirlpool", "api_key=secret"], ["Whirlpool", "WFW8620HW\nGuest Jane"]]) {
    await assert.rejects(f.run({ manufacturer, model, intent: "manual" }, [`${manufacturer} ${model}`]), /public equipment/);
  }
  f.state.assets[0].manufacturer = "Guest Jane";
  await assert.rejects(f.run({ assetId, intent: "manual" }), /without serials or private labels/);
  f.state.assets[0].manufacturer = "Friedrich";
  f.state.assets[0].serial_number = "PZE09K3SB";
  await assert.rejects(f.run({ assetId, intent: "manual" }), /saved model matches the asset's serial/);
  assert.equal(f.calls.length, 0);
});

test("guest, reservation, room and serial labels do not become equipment error codes", async () => {
  const f = fixture();
  for (const turn of ["Guest code F3E1", "Guest account code F3E1", "Guest confirmation code is F3E1", "F3E1 is the guest code", "Reservation number: F3E1", "Serial number F3E1", "Room code F3E1", "Door code F3E1", "Access code F3E1", "Guest note: equipment error code F3E1", "Código de huésped F3E1", "Confirmación de reserva F3E1", "Número de serie F3E1"]) {
    await assert.rejects(f.run({ assetId, intent: "error-code", errorCode: "F3E1" }, [turn]), /actual error code in your question/, turn);
  }
  assert.equal(f.calls.length, 0);
});

test("only retrieved public URL sources and source-matched grounded text survive", async () => {
  const f = fixture(), fabricated = "https://vendorco.com/fabricated.pdf";
  f.state.result = {
    text: `Invented diagnosis and URL: ${fabricated}`,
    sources: [source(redirected), source("http://vendorco.com/insecure"), source("https://127.0.0.1/private"), source("https://user:password@vendorco.com/private"), { sourceType: "document", url: fabricated }],
    providerMetadata: { google: { groundingMetadataPerRequest: [{
      groundingChunks: [{ web: { uri: redirected } }, { web: { uri: fabricated } }],
      groundingSupports: [{ supportChunkIndices: [0], segment_text: "Actual source support." }, { supportChunkIndices: [1], segment_text: "Ungrounded invented diagnosis." }],
    }] } },
  };
  const answer = await f.run({ assetId, intent: "manufacturer" });
  assert.deepEqual(plain(answer.items.map(item => item.href)), [original]);
  assert.equal(answer.items[0].text, "Actual source support.");
  assert.doesNotMatch(JSON.stringify(answer), /fabricated|Invented|Ungrounded|127\.0\.0|password/);
  assert.equal(f.redirects.length, 1);
  assert.equal(f.redirects[0].url, redirected);
  assert.equal(f.redirects[0].options.method, "HEAD");
  assert.equal(f.redirects[0].options.redirect, "manual");
  assert.equal(f.redirects[0].options.credentials, "omit");
  assert.equal(f.redirects[0].options.headers, undefined);
});

test("a vendor restriction needs observed public URL provenance and sends only the hostname", async () => {
  const f = fixture(), vendorUrl = "https://vendorco.com/selected/Private-record?token=PRIVATE-TOKEN";
  const params = { assetId, intent: "manual", vendorUrl };
  await assert.rejects(f.run(params), /supplied by the user or returned by the current search/);
  await assert.rejects(f.run({ ...params, vendorUrl: "https://127.0.0.1/private" }, [], { publicSources: new Set(["https://127.0.0.1/private"]) }), /public HTTPS/);
  assert.equal(f.calls.length, 0);
  f.state.result.sources.push(source("https://vendorco.com.evil.com/fake"), source("https://evilvendorco.com/fake"));
  const answer = await f.run(params, [], { publicSources: new Set([vendorUrl]) });
  assert.equal(f.calls[0].prompt, "Friedrich PZE09K3SB official manufacturer owner or service manual PDF site:vendorco.com");
  assert.doesNotMatch(JSON.stringify(f.calls), /Private-record|PRIVATE-TOKEN/);
  assert.deepEqual(plain(answer.items.map(item => item.href)), [original]);
});

test("cancellation, missing sources and provider failures never produce fallback evidence", async () => {
  const f = fixture();
  const cancelled = new AbortController(); cancelled.abort(Error("Cancelled"));
  await assert.rejects(f.run({ assetId, intent: "manual" }, [], { signal: cancelled.signal }), /Cancelled/);
  assert.equal(f.nativeReads.length, 0);
  const duringRead = new AbortController();
  f.state.afterRead = () => duringRead.abort(Error("Account changed"));
  await assert.rejects(f.run({ assetId, intent: "manual" }, [], { signal: duringRead.signal }), /Account changed/);
  assert.equal(f.calls.length, 0);
  f.state.afterRead = undefined;
  f.state.result = { text: "https://vendorco.com/made-up.pdf", sources: [] };
  assert.equal((await f.run({ assetId, intent: "manual" })).items.length, 0);
  f.state.error = Error("Provider unavailable");
  await assert.rejects(f.run({ assetId, intent: "manual" }), /Provider unavailable/);
});
