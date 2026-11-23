import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const catalog = loadTs("src/lib/pm/catalog.ts", { "./source-catalog.json": { default: JSON.parse(readFileSync("src/lib/pm/source-catalog.json", "utf8")) } });
const taskReview = loadTs("src/lib/pm/task-review.ts");
const transfer = loadTs("src/lib/pm/weekly-transfer.ts", { "./catalog": catalog, "./task-review": taskReview });
const week = "2026-11-30";
const daily = catalog.findPmTemplate(catalog.PM_DAILY_TEMPLATE_ID);
const weekly = catalog.findPmTemplate(catalog.PM_WEEKLY_TEMPLATE_ID);
const november = catalog.PM_TEMPLATES.find(template => template.id === "workbook:monthly:nov");
const form = catalog.PM_TEMPLATES.find(template => template.kind === "inspection" && template.checklist.length && catalog.templatePeriodsForWeek(template, week).includes("2026-11-01"));
assert.ok(form, "Fixture must use a real form due during the selected week");
const entries = [
  { template_id: daily.id, period_start: week, scope_key: "property", responses: { [daily.checklist[0].id]: false }, task_states: { [daily.checklist[0].id]: { status: "needs", workerChecked: true } }, notes: "Saved daily note" },
  { template_id: weekly.id, period_start: week, scope_key: "property", responses: { [weekly.checklist[0].id]: true }, status: "pending" },
  { template_id: november.id, period_start: "2026-11-01", scope_key: "property", responses: { [november.checklist[0].id]: true }, status: "approved" },
  { template_id: form.id, period_start: "2026-11-01", scope_key: "equipment:verified-unit", responses: { [form.checklist[0].id]: "follow-up", [form.checklist[1].id]: "na" }, deficiency_notes: 'Valve needs work, label "A"', status: "approved" },
  { template_id: catalog.PM_ROOM_TEMPLATE_ID, period_start: "2026-10-01", scope_key: "room:101", responses: {}, is_complete: true, completed_on: "2026-11-23", notes: "Saved room inspection", status: "pending" },
];

test("the shared Weekly CSV retains native columns, periods, scoped forms, task ownership and room review status", () => {
  const rows = transfer.pmWeeklyTransferRows({ weekStart: week, entries, spreadsheetSyncEnabled: false });
  assert.deepEqual(plain(rows[0]), ["Date / period", "Cadence", "Form / task", "Scope", "Status", "Completion date", "Notes / deficiency", "Source", "Review status"]);
  assert.ok(rows.every(row => row.length === 9));
  const routine = rows.find(row => row[0] === week && row[2] === daily.checklist[0].label);
  assert.equal(routine[4], "Complete", "Native worker-checked state outranks a stale false response");
  assert.equal(routine[6], "Saved daily note"); assert.equal(routine[8], "needs");
  const pending = rows.find(row => row[0] === week && row[2] === weekly.checklist[0].label);
  assert.equal(pending[4], "Complete"); assert.equal(pending[8], "Pending review");
  assert.ok(rows.some(row => row[0] === "2026-11-01" && row[1] === "monthly"));
  assert.ok(rows.some(row => row[0] === "2026-12-01" && row[1] === "monthly"), "A cross-month week includes both native monthly periods");
  const scoped = rows.find(row => row[3] === "equipment:verified-unit" && row[2].endsWith(form.checklist[0].label));
  assert.equal(scoped[4], "Needs work"); assert.equal(scoped[6], 'Valve needs work, label "A"'); assert.equal(scoped[8], "Approved in CMPRI");
  const room = rows.find(row => row[3] === "Room 101");
  assert.equal(room[0], "2026-10-01"); assert.equal(room[4], "Complete"); assert.equal(room[5], "2026-11-23"); assert.equal(room[8], "Pending review");
  assert.equal(rows.filter(row => row[3].startsWith("Room ")).length, catalog.PM_ROOM_NUMBERS.length);
  const missingRoom = rows.find(row => row[3] === "Room 102");
  assert.equal(missingRoom[4], "Open"); assert.equal(missingRoom[5], "");
  const csv = transfer.createPmWeeklyTransferCsv({ weekStart: week, entries, spreadsheetSyncEnabled: false });
  assert.match(csv, /"Valve needs work, label ""A"""/);
  assert.equal(csv.split("\r\n").length, rows.length);
});

test("the actual PM page transfer control preserves queued status callbacks and native file naming", () => {
  const page = ts.createSourceFile("page.tsx", readFileSync("src/app/engineering/preventive-maintenance/page.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "downloadTransfer") declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(page); assert.ok(declaration);
  let downloaded, created, clicked = false, revoked;
  const code = ts.transpileModule(declaration.getText(page), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code + "\ndownloadTransfer();", {
    createPmWeeklyTransferCsv: transfer.createPmWeeklyTransferCsv, weekStart: week, entries,
    spreadsheetSyncEnabled: false, liveWorkbook: null,
    routineStatus: (template, period, item) => template.id === daily.id && period === week && item === daily.checklist[0].id ? false : true,
    roomCompleted: room => room === "102",
    Blob: class { constructor(parts, options) { this.content = parts.join(""); this.options = options; } },
    URL: { createObjectURL: blob => { created = blob; return "blob:fixture"; }, revokeObjectURL: value => { revoked = value; } },
    document: { createElement: () => (downloaded = { click: () => { clicked = true; } }) },
  });
  assert.equal(downloaded.download, `cmpri-pm-${week}-transfer.csv`); assert.equal(clicked, true); assert.equal(revoked, "blob:fixture");
  const rows = created.content.split("\r\n");
  assert.ok(rows.some(row => row.startsWith(`"${week}","daily","${daily.checklist[0].label}"`) && row.includes(',"Open",')));
  assert.ok(rows.some(row => row.includes(',"Room 102","Complete",')));
  assert.equal(created.options.type, "text/csv;charset=utf-8");
});

test("PM transfer notes stay literal spreadsheet text and preserve embedded quotes/newlines", () => {
  const csv = transfer.createPmWeeklyTransferCsv({ weekStart: week, spreadsheetSyncEnabled: false, entries: [
    { ...entries[0], notes: ' \t=HYPERLINK("https://untrusted.invalid")\nsecond line' },
  ] });
  assert.ok(csv.includes('"\' \t=HYPERLINK(""https://untrusted.invalid"")\nsecond line"'));
  assert.ok(!csv.includes('," \t=HYPERLINK'));
});

class NativeRequest extends Request { get nextUrl() { return new URL(this.url); } }
const next = { NextRequest: NativeRequest, NextResponse: { json: Response.json } };
function fixture() {
  const calls = [];
  const state = { status: 200, entries, returnedWeek: week };
  const reports = loadTs("src/lib/server/ask-cmpri-native-reports.ts", {
    "server-only": {}, "next/server": next, zod,
    "@/lib/dashboard/menu-access": {}, "@/lib/server/access": {}, "@/lib/server/auth": {},
    "@/lib/pool-report": {}, "@/lib/pm/weekly-transfer": transfer,
    "@/app/engineering/gss/gss-reports": {}, "@/app/engineering/gss/gss-latest-rankings": {},
    "@/app/api/preventive-maintenance/route": { GET: async request => {
      calls.push({ path: request.nextUrl.pathname, query: Object.fromEntries(request.nextUrl.searchParams), headers: [...request.headers] });
      return state.status === 200 ? Response.json({ week: state.returnedWeek, entries: state.entries,
        workbook: { rooms: [{ room: "102", quarters: { Q4: { value: "11/25/26" } } }] }, spreadsheet_sync_enabled: false })
        : Response.json({ error: "Native PM read denied or unavailable." }, { status: state.status });
    } },
  }, { URL, Response, Error, Date });
  const nativeCatalog = loadTs("src/lib/server/ask-cmpri-native-catalog.ts", {
    "server-only": {}, "@/lib/ai/cmpri-operation-guidance": loadTs("src/lib/ai/cmpri-operation-guidance.ts"),
    "@/lib/server/ask-cmpri-native-reports": reports,
  });
  const native = loadTs("src/lib/server/ask-cmpri-native.ts", {
    "server-only": {}, "next/server": next, zod, "@/lib/server/manual-preview": { manualPreviewReadOnly: () => true },
    "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "fixture" }, "./ask-cmpri-native-catalog": nativeCatalog,
  }, { URL, Headers, FormData, Error });
  const incoming = new NativeRequest("https://fixture.invalid/api/ask-cmpri", { method: "POST", headers: { authorization: "Bearer current-user", cookie: "private-cookie" } });
  return { calls, state, reports, nativeCatalog, read: input => native.runAskNativeRequest(incoming, input) };
}

test("Ask Weekly CSV delegates the current native role check and exports only fresh saved PM records", async () => {
  const f = fixture();
  const result = await f.read({ operation: "preventive_maintenance.weekly_csv", query: { week }, body: { entries: [{ notes: "Invented unsaved value" }] } });
  assert.equal(result.ok, true); assert.equal(result.screen, "/engineering/preventive-maintenance");
  assert.equal(f.nativeCatalog.askNativeOperation("preventive_maintenance.weekly_csv").writes, false);
  assert.deepEqual(f.calls, [{ path: "/api/preventive-maintenance", query: { week }, headers: [["authorization", "Bearer current-user"]] }]);
  assert.equal(result.downloads[0].name, `cmpri-pm-${week}-saved-transfer.csv`);
  const csv = Buffer.from(result.downloads[0].content, "base64").toString("utf8");
  assert.equal(csv, transfer.createPmWeeklyTransferCsv({ weekStart: week, entries, spreadsheetSyncEnabled: false }));
  assert.doesNotMatch(csv, /Invented unsaved value|11\/25\/26|2026-11-25/);
  assert.ok(csv.includes(',"Room 102","Open",""'));
  const direct = await f.reports.exportNativePmWeeklyCsv(new NativeRequest(`https://fixture.invalid/pm?week=${week}`, { headers: { authorization: "Bearer current-user" } }));
  assert.match(direct.headers.get("X-CMPRI-Export-Source"), /Saved PM records only.*unsaved browser forms and queued changes are excluded/);
});

test("saved PM export preserves access failures and rejects mismatched or missing native records", async () => {
  const f = fixture();
  for (const status of [401, 403, 503]) {
    f.state.status = status;
    const result = await f.read({ operation: "preventive_maintenance.weekly_csv", query: { week } });
    assert.equal(result.ok, false); assert.equal(result.status, status); assert.equal(result.downloads, undefined);
  }
  f.state.status = 200; f.state.returnedWeek = "2026-11-23";
  assert.equal((await f.read({ operation: "preventive_maintenance.weekly_csv", query: { week } })).status, 503);
  f.state.returnedWeek = week; f.state.entries = null;
  assert.equal((await f.read({ operation: "preventive_maintenance.weekly_csv", query: { week } })).status, 503);
  const count = f.calls.length;
  for (const query of [{ week: "2026-12-01" }, { week: "2026-02-30" }, { week: [week, week] }, { week, entries: "supplied rows" }]) {
    assert.equal((await f.read({ operation: "preventive_maintenance.weekly_csv", query })).status, 400);
  }
  assert.equal(f.calls.length, count, "Invalid source selectors must not read native PM data");
});
