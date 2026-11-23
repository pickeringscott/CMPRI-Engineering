import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import * as zod from "zod";
import * as pdfLib from "pdf-lib";
import * as report from "../src/lib/pool-report.ts";
import { loadTs } from "./helpers/load-ts.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const facility = "00000000-0000-4000-8000-000000000011";
const actor = "00000000-0000-4000-8000-000000000001";
const hotel = "00000000-0000-4000-8000-000000000002";
class NativeRequest extends Request { get nextUrl() { return new URL(this.url); } }
const next = { NextRequest: NativeRequest, NextResponse: { json: Response.json } };
const incoming = () => new NativeRequest("https://fixture.invalid/api/ask-cmpri", { method: "POST", headers: { authorization: "Bearer current-fixture", cookie: "private-cookie" } });
const verified = loadTs("src/app/engineering/gss/gss-reports.ts");
const rankings = loadTs("src/app/engineering/gss/gss-latest-rankings.ts");
const menu = loadTs("src/lib/dashboard/menu-access.ts");
const access = loadTs("src/lib/server/access.ts");

function fixture() {
  const profile = { id: actor, active: true, role: "chief_engineer" };
  const principal = { identity: { id: actor }, profile, hotelId: hotel, membership: { user_id: actor, hotel_id: hotel, role: "engineer", active: true }, permissions: [] };
  const state = { auth: { ok: true, mcp: false, principal }, historyStatus: 200, history: [
    { log_date: "2025-12-31", ph_am: 7.4, sanitizer_band_am: "3-6", completed_by_initials: "AB", remarks: "Fixture December reading" },
    { log_date: "2026-01-01", ph_shallow_pm: 7.2, ph_deep_pm: 7.6, completed_by_initials: "CD", remarks: "Fixture January reading" },
    { log_date: "2026-02-01", ph_am: 7.9, remarks: "Outside selected months" },
  ], returnedFacility: facility, historyError: "Pool-log access is required." };
  const historyCalls = [], renderCalls = [], fileReads = [];
  const adapters = loadTs("src/lib/server/ask-cmpri-native-reports.ts", {
    "server-only": {}, "next/server": next, zod,
    "node:fs/promises": { readFile: async path => { fileReads.push(path); return readFile(path); } },
    "@/lib/dashboard/menu-access": menu, "@/lib/server/access": access,
    "@/lib/pm/weekly-transfer": {},
    "@/lib/server/auth": { requireUserAttempt: async () => state.auth },
    "@/app/engineering/gss/gss-reports": verified, "@/app/engineering/gss/gss-latest-rankings": rankings,
    "@/lib/pool-report": { ...report, createPoolReport: async (template, months, logs) => {
      renderCalls.push({ months: plain(months), logs: plain(logs) });
      try { return await report.createPoolReport(template, months, logs); }
      catch (error) { state.renderError = error.message; throw error; }
    } },
    "@/app/api/pool-log/route": { GET: async request => {
      historyCalls.push({ path: request.nextUrl.pathname, query: Object.fromEntries(request.nextUrl.searchParams), headers: [...request.headers] });
      return state.historyStatus === 200 ? Response.json({ facility: { id: state.returnedFacility }, history: state.history })
        : Response.json({ error: state.historyError }, { status: state.historyStatus });
    } },
  }, { URL, Uint8Array, Response, Error, process });
  const catalog = loadTs("src/lib/server/ask-cmpri-native-catalog.ts", {
    "server-only": {}, "@/lib/ai/cmpri-operation-guidance": loadTs("src/lib/ai/cmpri-operation-guidance.ts"),
    "@/lib/server/ask-cmpri-native-reports": adapters,
  });
  const bridge = loadTs("src/lib/server/ask-cmpri-native.ts", {
    "server-only": {}, "next/server": next, zod,
    "@/lib/server/manual-preview": { manualPreviewReadOnly: () => true },
    "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "fixture" },
    "./ask-cmpri-native-catalog": catalog,
  }, { URL, Headers, FormData, Error });
  return { state, adapters, bridge, catalog, historyCalls, renderCalls, fileReads,
    read: input => bridge.runAskNativeRequest(incoming(), input) };
}

test("Pool report runs the real official PDF generator with exact authorized saved history and native download", async () => {
  const f = fixture();
  const result = await f.read({ operation: "pool.report", query: { facility, start: "12/25", end: "01/26" } });
  assert.equal(result.ok, true, f.state.renderError || result.error); assert.equal(result.screen, "/engineering/pool-log");
  assert.equal(f.catalog.askNativeOperation("pool.report").writes, false);
  assert.deepEqual(f.historyCalls, [{ path: "/api/pool-log", query: { history: "1", facility }, headers: [["authorization", "Bearer current-fixture"]] }]);
  assert.deepEqual(f.renderCalls, [{ months: ["2025-12", "2026-01"], logs: f.state.history.slice(0, 2) }]);
  assert.match(f.fileReads[0], /public\/forms\/swimming-facility-daily-operational-report\.pdf$/);
  const download = result.downloads[0];
  assert.equal(download.name, "Residence-Inn-Pool-2025-12-to-2026-01.pdf"); assert.equal(download.mimeType, "application/pdf");
  const bytes = Buffer.from(download.content, "base64");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const pdf = await pdfLib.PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  for (const page of pdf.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 792 });
  if (process.env.ASK_POOL_REPORT_SAMPLE) await writeFile(process.env.ASK_POOL_REPORT_SAMPLE, bytes);
});

test("Pool report preserves native denials and incomplete-history failures before reading the template or rendering", async () => {
  const f = fixture();
  for (const status of [401, 403, 404, 503]) {
    f.state.historyStatus = status;
    const result = await f.read({ operation: "pool.report", query: { facility, start: "01/26", end: "12/26" } });
    assert.equal(result.ok, false); assert.equal(result.status, status); assert.equal(result.downloads, undefined);
  }
  f.state.historyStatus = 200;
  f.state.history = null;
  assert.equal((await f.read({ operation: "pool.report", query: { facility, start: "01/26", end: "12/26" } })).status, 503);
  f.state.history = []; f.state.returnedFacility = "different-facility";
  assert.equal((await f.read({ operation: "pool.report", query: { facility, start: "01/26", end: "12/26" } })).status, 503);
  assert.deepEqual(f.renderCalls, []); assert.deepEqual(f.fileReads, []);
});

test("Pool report accepts only a real facility and native bounded month range, never model-supplied readings", async () => {
  const f = fixture();
  for (const query of [
    { start: "01/26", end: "02/26" }, { facility, start: "13/26", end: "12/26" },
    { facility, start: "12/26", end: "01/26" }, { facility, start: "01/00", end: "01/99" },
    { facility, start: ["01/26", "02/26"], end: "12/26" },
    { facility, start: "01/26", end: "02/26", history: '[{"ph_am":7.4}]' },
  ]) {
    const result = await f.read({ operation: "pool.report", query });
    assert.equal(result.ok, false); assert.equal(result.status, 400); assert.equal(result.downloads, undefined);
  }
  assert.deepEqual(f.historyCalls, []); assert.deepEqual(f.renderCalls, []);
});

test("GSS verified reports expose every actual dated snapshot and ranking with the source metric order", async () => {
  const f = fixture();
  const result = await f.read({ operation: "gss.verified_reports" });
  assert.equal(result.ok, true); assert.equal(result.screen, "/engineering/gss");
  assert.equal(f.catalog.askNativeOperation("gss.verified_reports").writes, false);
  assert.deepEqual(plain(result.data.reports), plain(verified.verifiedGssReports));
  assert.deepEqual(plain(result.data.rankings.periods), plain(rankings.latestRankings));
  assert.equal(result.data.verifiedDate, "2026-11-09");
  assert.equal(result.data.rankings.date, "2026-11-09");
  assert.equal(result.data.metrics[4], "Maintenance and Upkeep");
  assert.equal(result.data.reports[0].snapshots[0].scores[4], 66.7);
  assert.deepEqual(result.data.rankings.periods.map(period => period.rows.length), [15, 15]);
  assert.match(result.data.instruction, /not a live mailbox refresh/);
  assert.match(result.data.instruction, /Wave to Date is not week to date/);
  assert.deepEqual(f.historyCalls, []); assert.deepEqual(f.fileReads, []);
});

test("GSS verified-history access matches the current native GSS role gate including secondary roles", async () => {
  const f = fixture();
  for (const role of ["chief_engineer", "engineer", "system_admin", "senior_management", "manager", "assistant_manager", "front_desk_manager", "technician"]) {
    f.state.auth.principal.profile.role = role;
    assert.equal((await f.read({ operation: "gss.verified_reports" })).ok, true, role);
  }
  for (const role of ["front_desk", "housekeeping", "unknown"]) {
    f.state.auth.principal.profile.role = role;
    const denied = await f.read({ operation: "gss.verified_reports" });
    assert.equal(denied.ok, false, role); assert.equal(denied.status, 403); assert.equal(denied.data.reports, undefined);
  }
  f.state.auth.principal.profile.secondary_roles = ["technician"];
  assert.equal((await f.read({ operation: "gss.verified_reports" })).ok, true);
  f.state.auth = { ok: false };
  assert.equal((await f.read({ operation: "gss.verified_reports" })).status, 401);
});
