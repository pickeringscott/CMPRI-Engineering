import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const actor = "00000000-0000-4000-8000-000000000001";
const hotel = "00000000-0000-4000-8000-000000000002";
const principal = { identity: { id: actor }, hotelId: hotel, profile: { id: actor, role: "engineer" } };
const weatherScreen = "/previews/cmpri-weather-preview.html";
class NativeRequest extends Request { get nextUrl() { return new URL(this.url); } }
const next = { NextRequest: NativeRequest, NextResponse: { json: Response.json } };
const responseHelper = loadTs("src/lib/server/ask-cmpri-response.ts", {
  "server-only": {}, "next/server": next,
}, { Response, ReadableStream, TextEncoder, Uint8Array });
const request = body => new NativeRequest("https://fixture.invalid/api/ask-cmpri", {
  method: "POST", headers: { authorization: "Bearer fixture-session", "content-type": "application/json" }, body: JSON.stringify(body || {}),
});
const guidance = loadTs("src/lib/ai/cmpri-operation-guidance.ts");
const loyalty = loadTs("src/lib/loyalty-tier.ts");
const query = loadTs("src/lib/ask-cmpri/native-query.ts", { "@/lib/loyalty-tier": loyalty }, { Error });
const ranker = loadTs("src/lib/ticket-room-ranking.ts");
const weatherAccess = loadTs("src/lib/dashboard/menu-access.ts");

function loadServer(path, dependencies, globals = {}) {
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, { exports, Buffer, console, ...globals, require(name) {
    if (name in dependencies) return dependencies[name];
    throw Error(`Unmocked domain test import: ${name}`);
  } });
  return exports;
}

function fixture(handlers = {}) {
  const state = { auth: { ok: true, mcp: false, principal }, authorizations: [] };
  const catalog = loadTs("src/lib/server/ask-cmpri-native-catalog.ts", {
    "server-only": {}, "@/lib/ai/cmpri-operation-guidance": guidance, ...handlers,
  });
  const native = loadTs("src/lib/server/ask-cmpri-native.ts", {
    "server-only": {}, "next/server": next, zod,
    "@/lib/server/manual-preview": { manualPreviewReadOnly: () => false },
    "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "fixture-bucket" },
    "@/lib/server/auth": { requireUserAttempt: async request => { state.authorizations.push(request); return state.auth; } },
    "@/lib/dashboard/menu-access": weatherAccess,
    "./ask-cmpri-native-catalog": catalog,
  }, { URL, Headers, FormData, Error, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-signing-secret" } } });
  const read = input => native.runAskNativeRequest(request(), input);
  return { catalog, native, read, state };
}

function helpFixture() {
  return loadTs("src/lib/server/ask-cmpri-native-help.ts", {
    "server-only": {}, "next/server": next,
    "@/components/beginners-guide/guide-lessons.json": { roles: {} },
    "@/components/beginners-guide/ask-cmpri-guide": { ASK_CMPRI_GUIDE: { key: "ask", title: "Ask" } },
    "@/lib/general-notes": { NOTE_FONT_SIZES: [12] }, "@/lib/loyalty-tier": loyalty,
    "@/lib/pm/catalog": { PM_TEMPLATES: [], PM_ROOM_NUMBERS: [], PM_WORKBOOK_SOURCE: "Fixture" },
    "@/lib/winter-preparedness": { WINTER_TASKS: [], WINTER_YEAR: 2026 },
    "@/lib/server/auth": { requireUser: async () => ({ principal }) },
    "@/lib/server/room-operations-import-schema": { ROOM_OPERATIONS_IMPORT_CONTRACT: {} },
    "@/lib/ai/cmpri-operation-guidance": guidance,
  });
}

function agentFixture(f, script) {
  const agent = loadServer("src/lib/server/ask-cmpri-native-agent.ts", {
    "server-only": {}, "node:crypto": { createHash }, zod,
    "@ai-sdk/google": { createGoogleGenerativeAI: () => model => ({ model }) },
    ai: {
      tool: value => value, Output: { object: value => value }, isStepCount: value => value, hasToolCall: value => value,
      ToolLoopAgent: class {
        constructor(options) { this.options = options; }
        async generate() {
          const call = async (name, data) => {
            const tool = this.options.tools[name]; assert.ok(tool, name);
            return tool.execute(tool.inputSchema.parse(data));
          };
          return { output: this.options.output.schema.parse(await script(call)) };
        }
      },
    },
    "@/lib/ask-cmpri/native-query": query,
    "@/lib/ask-cmpri/native-context": loadTs("src/lib/ask-cmpri/native-context.ts"),
    "./ask-cmpri-native-catalog": f.catalog, "./ask-cmpri-native": f.native,
    "./ask-cmpri-pm": {}, "./ask-cmpri-gemini": { askGeminiKey: () => "fixture-key" },
    "./ask-cmpri-public-document": {}, "./ask-cmpri-public-search": {}, "./ask-cmpri-vendor-document": {},
  }, { Date, Intl, Error, AbortSignal, process: { env: {} } });
  return question => agent.runNativeAsk({ request: request({ question }), auth: { ok: true, mcp: false, principal }, question,
    language: "en", chief: true, signal: new AbortController().signal });
}

test("all Weather and Airport operations execute their native handler and return the actual modal route", async () => {
  const calls = [];
  const paths = [
    ["weather.read", "/api/weather-preview", { part: "forecast" }],
    ["weather.map", "/api/weather-preview/map", { url: "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer/4?f=json" }],
    ["weather.basemap", "/api/weather-preview/basemap", { op: "metadata", dataset: "imagery" }],
    ["weather.wms", "/api/weather-preview/wms", { product: "cloudCover", op: "capabilities" }],
    ["weather.astronomy", "/api/weather-preview/astronomy", {}],
    ["willard.flights", "/api/willard-flights", {}], ["willard.tracker", "/api/willard-tracker", {}],
    ["willard.layout", "/api/willard-airport-layout", {}],
  ];
  const handlers = Object.fromEntries(paths.map(([operation, path]) => ["@/app" + path + "/route", { GET: async req => {
    calls.push({ operation, path: req.nextUrl.pathname, query: Object.fromEntries(req.nextUrl.searchParams), headers: [...req.headers] });
    return Response.json({ source: operation, status: "live", retrievedAt: "2026-11-23T12:00:00Z" });
  } }]));
  const f = fixture(handlers);
  for (const [operation, path, params] of paths) {
    const result = await f.read({ operation, query: params });
    assert.equal(result.ok, true, operation); assert.equal(result.screen, weatherScreen, operation);
    assert.deepEqual(calls.at(-1), { operation, path, query: params, headers: [["authorization", "Bearer fixture-session"]] });
    assert.equal(f.native.nativeReadItem(result, operation).record.id, weatherScreen);
    assert.equal(f.catalog.askNativeOperation(operation).writes, false);
  }
  assert.equal((await f.read({ operation: "willard.flights", query: { date: "2027-01-01" } })).ok, false);
  assert.equal(calls.length, paths.length, "Unsupported date must not reach the current-only flight board");
  assert.equal(f.state.authorizations.length, paths.length, "Every Weather-modal source lookup verifies the current account");
});

test("Weather-modal data follows the existing role admission before any public source handler runs", async () => {
  const paths = [
    ["weather.read", "/api/weather-preview"], ["weather.map", "/api/weather-preview/map"],
    ["weather.basemap", "/api/weather-preview/basemap"], ["weather.wms", "/api/weather-preview/wms"],
    ["weather.astronomy", "/api/weather-preview/astronomy"], ["willard.flights", "/api/willard-flights"],
    ["willard.tracker", "/api/willard-tracker"], ["willard.layout", "/api/willard-airport-layout"],
  ];
  const calls = [];
  const handlers = Object.fromEntries(paths.map(([operation, path]) => ["@/app" + path + "/route", {
    GET: async () => { calls.push(operation); return Response.json({ status: "live" }); },
  }]));
  const f = fixture(handlers);
  for (const [role, allowed] of [
    ["chief_engineer", true], ["system_admin", true], ["senior_management", true],
    ["manager", true], ["technician", true], ["front_desk", true], ["housekeeping", true],
    ["assistant_manager", false], ["front_desk_manager", false], ["unknown", false],
  ]) {
    f.state.auth = { ok: true, mcp: false, principal: { ...principal, profile: { ...principal.profile, role } } };
    for (const [operation] of paths) {
      const before = calls.length;
      const read = await f.read({ operation });
      assert.equal(read.ok, allowed, `${role}: ${operation}`);
      assert.equal(read.status, allowed ? 200 : 403, `${role}: ${operation}`);
      assert.equal(calls.length, before + Number(allowed), "Denied roles cannot query even a public source through Ask");
    }
  }
  assert.equal(f.state.authorizations.length, paths.length * 10);
  f.state.auth = { ok: true, mcp: false, principal: { ...principal, profile: { ...principal.profile, role: "assistant_manager", secondary_roles: ["technician"] } } };
  assert.equal((await f.read({ operation: "weather.read" })).ok, true, "Existing permitted secondary roles are retained");
  for (const auth of [{ ok: false, reason: "profile-inactive" }, { ok: false, reason: "verify-failed" }, { ok: true, mcp: true, principal }]) {
    f.state.auth = auth;
    const before = calls.length;
    assert.equal((await f.read({ operation: "weather.read" })).status, 401);
    assert.equal(calls.length, before, "Invalid, inactive or non-app sessions cannot call a weather provider");
  }
});

test("source-owned Weather help produces a native-valid WSSI query and preserves real source errors/images", async () => {
  const seen = [];
  let response = () => Response.json({ fields: ["impact", "issue_time", "start_time", "end_time", "idp_filedate"].map(name => ({ name })) });
  const map = loadTs("src/app/api/weather-preview/map/route.ts", {}, {
    URL, Response, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    fetch: async (url, options) => { seen.push({ url: String(url), options }); return response(); },
  });
  const f = fixture({ "@/app/api/weather-preview/map/route": map });
  const help = await (await helpFixture().readAskNativeHelp(new NativeRequest("https://fixture.invalid/help?section=weather"))).json();
  const source = help.weather.map.sources.winterImpacts;
  assert.equal((await f.read({ operation: "weather.map", query: { url: source + "?f=json" } })).ok, true);
  const queryUrl = new URL(source + help.weather.map.hotelWinterImpactQuery.pathSuffix);
  for (const [key, value] of Object.entries(help.weather.map.hotelWinterImpactQuery.query)) queryUrl.searchParams.set(key, value);
  response = () => Response.json({ features: [{ attributes: { impact: "Minor", issue_time: "2026-11-23T10:00Z", start_time: "2026-11-23T12:00Z", end_time: "2026-11-26T12:00Z" } }], exceededTransferLimit: false });
  const result = await f.read({ operation: "weather.map", query: { url: queryUrl.href } });
  assert.equal(result.ok, true); assert.equal(result.data.features[0].attributes.impact, "Minor");
  assert.equal(seen.at(-1).url, queryUrl.href);
  assert.equal(seen.at(-1).options.credentials, "omit");
  assert.equal(seen.at(-1).options.headers.authorization, undefined, "Private bearer never reaches NOAA");
  response = () => Response.json({ error: { code: 400, message: "Invalid source fields" } });
  const failed = await f.read({ operation: "weather.map", query: { url: queryUrl.href } });
  assert.equal(failed.ok, false, "A provider error inside HTTP 200 is not a successful weather read");
  assert.match(failed.error, /Invalid source fields/);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  response = () => new Response(png, { headers: { "content-type": "image/png" } });
  const image = await f.read({ operation: "weather.map", query: { url: "https://mapservices.weather.noaa.gov/arcgis/rest/directories/arcgisoutput/radar/frame.png" } });
  assert.equal(image.ok, true); assert.equal(image.downloads[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.downloads[0].content, "base64"), Buffer.from(png));
});

test("Room Ranker tools count the complete native room list and preserve room and underlying ticket links", async () => {
  const locations = Array.from({ length: 612 }, (_, i) => ({ id: `room-${i}`, room_number: String(i + 101), name: `Room ${i + 101}`, active: true, location_type: "Guest Room" }));
  const tickets = [
    ...[0, 1, 2].map(i => ({ id: `low-${i}`, location_id: "room-0", room: "Room 101", issue: `Low issue ${i}`, priority: "Medium", ranker_base_priority: "Low", status: "Open" })),
    { id: "high-1", location_id: "room-1", room: "Room 102", issue: "Broken door lock", priority: "High", status: "Open" },
    { id: "closed-1", location_id: "room-2", room: "Room 103", issue: "Completed issue", priority: "Urgent", status: "Closed" },
  ];
  const rooms = ranker.rankTicketRooms(locations, tickets);
  const f = fixture({ "@/app/api/ticket-room-ranker/route": { GET: async req => {
    assert.equal(req.headers.get("authorization"), "Bearer fixture-session");
    return Response.json({ rooms, refreshedAt: "2026-11-23T12:00:00Z" });
  } } });
  const run = agentFixture(f, async call => {
    const found = await call("discoverOperations", { query: "ranker" });
    assert.ok(found.operations.some(value => value.key === "room_ranker.read"));
    await call("describeOperation", { operation: "room_ranker.read" });
    const read = await call("readCmpri", { operation: "room_ranker.read" });
    assert.equal(read.shape.rooms.count, 612);
    const count = await call("querySnapshot", { snapshotId: read.snapshotId, path: "rooms", groupBy: "rank", aggregate: "count", limit: 1 });
    assert.equal(count.matchedCount, 612); assert.equal(count.aggregate, 612); assert.equal(count.returnedCount, 1);
    const ranked = await call("querySnapshot", { snapshotId: read.snapshotId, path: "rooms", filters: [{ path: "rank", operator: "ne", valueJson: '"A"' }], sort: [{ path: "number", direction: "asc" }], fields: ["number", "rank"] });
    assert.deepEqual(plain(ranked.rows.map(room => [room.number, room.rank])), [["101", "B"], ["102", "C"]]);
    assert.equal(ranked.rows[0].id, undefined, "Visible columns may omit IDs while source links retain original identity");
    return { title: "Room ranks", summary: "612 active guest rooms; 610 A, 1 B, 1 C.", itemIds: ranked.itemIds, format: "table" };
  });
  const result = await run("Show B and C rooms and the tickets causing their rank.");
  assert.equal(result.items[0].title, "Room 101");
  assert.equal(result.items[0].record.kind, "roomRank"); assert.equal(result.items[0].record.id, "room-0");
  assert.deepEqual(result.items[0].links.filter(link => link.kind === "order").map(link => link.id).sort(), ["low-0", "low-1", "low-2"]);
  assert.equal(result.items[1].links.find(link => link.kind === "order").id, "high-1");
  assert.equal(result.table.rows[0].cells.Result.record.kind, "roomRank");
});

test("native Airport tools query the actual nested flight-board rows without conflating unavailable with empty", async () => {
  const payload = { airport: "KCMI", iata: "CMI", timeZone: "America/Chicago", checkedAt: "2026-11-23T12:00:00Z", boards: {
    arrivals: { status: "live", sourceUrl: "https://provider.invalid/CMI", retrievedAt: "2026-11-23T12:00:00Z", providerDate: "2026-11-23", explicitEmpty: false, error: null,
      flights: [{ id: "aa-1", flight: "AA 1234", airline: "American", location: "Dallas", iata: "DFW", date: "2026-11-23", time: "11:15", status: "Delayed" }, { id: "aa-2", flight: "AA 2345", airline: "American", location: "Chicago", iata: "ORD", date: "2026-11-23", time: "15:00", status: "On Time" }] },
    departures: { status: "unavailable", sourceUrl: "https://provider.invalid/CMI", retrievedAt: null, providerDate: null, flights: null, explicitEmpty: false, error: "Provider unavailable" },
  } };
  const f = fixture({ "@/app/api/willard-flights/route": { GET: async () => Response.json(payload) } });
  const run = agentFixture(f, async call => {
    const read = await call("readCmpri", { operation: "willard.flights" });
    const detail = await call("querySnapshot", { snapshotId: read.snapshotId, path: "boards.departures" });
    assert.equal(detail.rows[0].flights, null); assert.equal(detail.rows[0].explicitEmpty, false);
    const arrivals = await call("querySnapshot", { snapshotId: read.snapshotId, path: "boards.arrivals.flights", filters: [{ path: "status", operator: "eq", valueJson: '"Delayed"' }], aggregate: "count" });
    assert.equal(arrivals.aggregate, 1); assert.equal(arrivals.rows[0].flight, "AA 1234");
    return { title: "Willard arrivals", summary: "One published arrival is marked delayed. Departures are unavailable.", itemIds: arrivals.itemIds, format: "table" };
  });
  const result = await run("Which Willard arrivals are delayed?");
  assert.equal(result.items[0].record.id, weatherScreen);
  assert.equal(result.items.flatMap(item => item.facts || []).find(fact => fact.label === "flight").value, "AA 1234");
  const help = await (await helpFixture().readAskNativeHelp(new NativeRequest("https://fixture.invalid/help?section=airport"))).json();
  assert.deepEqual(help.airport.flights.rows, ["boards.arrivals.flights", "boards.departures.flights"]);
  assert.equal(help.airport.layout.rows, "collection.features");
});

test("Airport partial and stale observations remain readable with their explicit limits", async () => {
  const f = fixture({
    "@/app/api/willard-airport-layout/route": { GET: async () => Response.json({ airport: "KCMI", status: "partial", referenceOnly: true,
      collection: { type: "FeatureCollection", features: [{ type: "Feature", properties: { kind: "runway" }, geometry: { type: "Polygon", coordinates: [] } }] },
      layers: [{ kind: "runway", status: "available", featureCount: 1 }, { kind: "taxiway", status: "unavailable", featureCount: null }],
      error: "Some airport layout geometry is unavailable or old." }) },
    "@/app/api/willard-tracker/route": { GET: async () => Response.json({ airport: "KCMI", status: "stale", aircraft: [{ hex: "abc123", lat: 40.03, lon: -88.28 }],
      observedAt: "2026-11-23T11:50:00Z", retrievedAt: "2026-11-23T11:50:01Z", error: "Source could not be refreshed." }) },
  });
  const layout = await f.read({ operation: "willard.layout" });
  assert.equal(layout.ok, true); assert.equal(layout.data.status, "partial");
  assert.equal(layout.data.collection.features.length, 1); assert.match(layout.data.error, /unavailable or old/);
  const tracker = await f.read({ operation: "willard.tracker" });
  assert.equal(tracker.ok, true); assert.equal(tracker.data.status, "stale");
  assert.equal(tracker.data.aircraft.length, 1); assert.match(tracker.data.error, /could not be refreshed/);
});

test("fresh Room Ranker, Weather and Airport questions bypass legacy planning including indirect domain requests", async () => {
  let planned = 0;
  const nativeQuestions = [];
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "../../../lib/server/ask-cmpri-response": responseHelper,
    "next/server": next, zod,
    "@/lib/server/roles": { profileIsChiefEngineer: () => true, profileIsEstablishedHoursChief: () => false },
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, mcp: false, principal }) },
    "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { askContextSchema: zod.z.object({}).passthrough(), askPermittedSources: () => ["roomRank"] },
    "@/lib/server/ask-cmpri-gemini": { askGeminiKey: () => "fixture-key", planAsk: async () => { planned++; throw Error("A fresh native domain reached the legacy planner"); } },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}) },
    "@/lib/server/ask-cmpri-native-agent": { runNativeAsk: async input => {
      nativeQuestions.push(input.question); return { title: "Native result", summary: input.question, context: { native: { summary: input.question } } };
    } },
  }, { TextDecoder, AbortSignal, Error, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-signing-secret" } } });
  const questions = ["Show Room Ranker", "How many rank A rooms are available?", "Show rooms ranked B", "Why is room 101 ranked C?", "Show the hotel weather forecast", "Show the radar", "What are Willard arrivals?", "Show airport departures", "Where are the nearby aircraft?", "Show CMI runway layout"];
  for (const question of questions) {
    const response = await handler.POST(request({ question }));
    assert.equal(response.status, 200, question);
    assert.equal((await response.json()).summary, question);
  }
  assert.deepEqual(nativeQuestions, questions); assert.equal(planned, 0);
  const indirect = "Which guest rooms need the most attention?";
  const response = await handler.POST(request({ question: indirect }));
  assert.equal(response.status, 200); assert.equal((await response.json()).summary, indirect);
  assert.equal(planned, 0); assert.equal(nativeQuestions.at(-1), indirect);
});
