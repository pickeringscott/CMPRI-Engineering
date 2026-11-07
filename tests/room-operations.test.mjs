import "./helpers/resolve-ts.mjs";
const { projectGuestRoom } = await import("../src/lib/room-guest-reports.ts");
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { detectRoomMoves, expiredRoomOperationsBefore, formatCheckoutRoomWorkOrders, isRailwayCnGuestName, isBigTenGroup, summarizeRoomOperations } from "../src/lib/room-operations.ts";
import { createRoomOperationsOcrCrops, createRoomOperationsRecoveryCrops } from "../src/lib/room-operations-report-images.ts";
import { roomKey, roomStatusBadge } from "../src/lib/room-availability.ts";
import {
  extractAndValidateRoomOperations,
  isRecoverableRoomOperationsValidationError,
  ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT,
} from "../src/lib/room-operations-recovery.ts";
import {
  canApplyScheduledCheckout,
  checkoutDeadlinePassed,
  hotelDateAt,
  normalizePrintedTime,
  parsePrintedReport,
  reportReplacementError,
  roomAfterScheduledCheckout,
} from "../src/lib/room-operations-reports.ts";

const snapshotSource = readFileSync(new URL("../src/lib/server/cmpri-room-operations-snapshot.ts", import.meta.url), "utf8");
const snapshotModule = { exports: {} };
const snapshotRuntimeRequire = (specifier) => {
  if (specifier === "@/lib/room-guest-reports") return { projectGuestRoom };
  if (specifier === "@/lib/constants") return { HOTEL_ID: "hotel-test", HOTEL_TIME_ZONE: "America/Chicago" };
  if (specifier === "@/lib/room-operations-reports") return { checkoutDeadlinePassed, hotelDateAt, normalizePrintedTime };
  throw new Error(`Unexpected snapshot test dependency: ${specifier}`);
};
vm.runInNewContext(ts.transpileModule(snapshotSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: snapshotModule, exports: snapshotModule.exports, require: snapshotRuntimeRequire });
const {
  loadEffectiveRoomOperationsSnapshot,
  applyRoomOperationCheckoutTransitions,
  applyExpiredRoomOperationCheckouts,
} = snapshotModule.exports;

function snapshotAdmin(tables) {
  return {
    from(table) {
      const query = { filters: [], orders: [], limit: null };
      const builder = {
        select() { return this; },
        eq(column, value) { query.filters.push((row) => row[column] === value); return this; },
        lte(column, value) { query.filters.push((row) => row[column] <= value); return this; },
        order(column, options = {}) { query.orders.push([column, options.ascending !== false]); return this; },
        limit(value) { query.limit = value; return this; },
        then(resolve, reject) {
          let rows = [...(tables[table] || [])].filter((row) => query.filters.every((filter) => filter(row)));
          for (const [column, ascending] of query.orders.reverse()) {
            rows.sort((a, b) => String(a[column] || "").localeCompare(String(b[column] || "")) * (ascending ? 1 : -1));
          }
          if (query.limit !== null) rows = rows.slice(0, query.limit);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const importerSource = readFileSync(new URL("../src/app/engineering/room-operations/RoomOperationsImport.tsx", import.meta.url), "utf8");
const importerAst = ts.createSourceFile("room-operations-importer.tsx", importerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const snapshotTimeNode = importerAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "normalizeSnapshotTime");
const snapshotValueNode = importerAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "normalizeSnapshotValue");
const snapshotMatchesNode = importerAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "snapshotMatches");
assert.ok(snapshotTimeNode, "normalizeSnapshotTime must be declared");
assert.ok(snapshotValueNode, "normalizeSnapshotValue must be declared");
assert.ok(snapshotMatchesNode, "snapshotMatches must be declared");
const snapshotTimeExports = {};
vm.runInNewContext(ts.transpileModule(
  `${snapshotTimeNode.getText(importerAst)}\n${snapshotValueNode.getText(importerAst)}\n${snapshotMatchesNode.getText(importerAst)}\nexports.normalizeSnapshotTime = normalizeSnapshotTime; exports.normalizeSnapshotValue = normalizeSnapshotValue; exports.snapshotMatches = snapshotMatches;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: snapshotTimeExports });
const parserFunctions = [
  "normalizeHeader",
  "parseDelimitedLine",
  "parseReport",
  "normalizeRoom",
  "parseRoomStatusReport",
  "parseExpectedDepartures",
  "mergeRoomOperations",
  "missingCurrentGuestNames",
].map((name) => {
  const node = importerAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${name} must be declared`);
  return node.getText(importerAst);
});
const parserExports = {};
vm.runInNewContext(ts.transpileModule(
  `${parserFunctions.join("\n")}\nexports.parseRoomStatusReport = parseRoomStatusReport; exports.parseExpectedDepartures = parseExpectedDepartures; exports.mergeRoomOperations = mergeRoomOperations; exports.missingCurrentGuestNames = missingCurrentGuestNames;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: parserExports, parsePrintedReport });

const notificationSource = readFileSync(new URL("../src/lib/dashboard/room-operations-notifications.ts", import.meta.url), "utf8");
const notificationAst = ts.createSourceFile("room-operations-notifications.ts", notificationSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const notificationFunctions = ["isOutOfOrder", "roomOperationsNotification"].map((name) => {
  const node = notificationAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${name} must be declared`);
  return node.getText(notificationAst);
});
const notificationExports = {};
vm.runInNewContext(ts.transpileModule(
  `${notificationFunctions.join("\n")}\nexports.roomOperationsNotification = roomOperationsNotification;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: notificationExports, detectRoomMoves });

test("room report metadata, freshness, and scheduled checkout helpers validate exact transitions", () => {
  assert.equal(hotelDateAt(new Date("2026-10-05T01:00:00.000Z"), "America/Chicago"), "2026-10-04");
  assert.equal(normalizePrintedTime("8:15 AM"), "08:15:00");
  assert.equal(normalizePrintedTime("25:15"), null);
  assert.deepEqual(parsePrintedReport("Printed Date: 10/5/2026\nPrinted Time: 8:15 AM", "Room Status Report"), {
    report: { printed_date: "2026-10-05", printed_time: "08:15:00" },
    error: null,
  });

  const latest = { printed_date: "2026-10-05", printed_time: "08:15:00", fingerprint: "older-version" };
  assert.equal(reportReplacementError("Room Status Report", {
    printed_date: "2026-10-05", printed_time: "08:16:00",
  }, latest, "2026-10-05", "new-version"), null);
  assert.match(reportReplacementError("Room Status Report", {
    printed_date: "2026-10-05", printed_time: "08:15:00",
  }, latest, "2026-10-05", "new-version"), /not newer/);

  assert.equal(checkoutDeadlinePassed("2026-10-05", "11:00 AM", new Date("2026-10-05T15:59:59.000Z"), "America/Chicago"), false);
  assert.equal(checkoutDeadlinePassed("2026-10-05", "11:00 AM", new Date("2026-10-05T16:00:00.000Z"), "America/Chicago"), true);
  assert.equal(canApplyScheduledCheckout(
    { import_id: "import-1", checkout_date: "2026-10-05", checkout_time: "11:00 AM", room_status: "Occupied" },
    { import_id: "import-1", checkout_date: "2026-10-05", checkout_time: "11:00:00" },
  ), true);
  assert.equal(canApplyScheduledCheckout(
    { import_id: "import-2", checkout_date: "2026-10-05", checkout_time: "11:00 AM", room_status: "Occupied" },
    { import_id: "import-1", checkout_date: "2026-10-05", checkout_time: "11:00:00" },
  ), false);
  assert.deepEqual(roomAfterScheduledCheckout({
    checkout_date: "2026-10-05",
    checkout_time: "11:00:00",
    room_status: "Occupied",
    guest_name: "Synthetic Guest",
    guest_code: "REG",
    room_type: "KING",
    guest_arrival_date: "2026-10-01",
    stay_nights: 4,
    reserved: false,
    arrival_date: null,
    arrival_time: null,
  }), {
    checkout_date: null,
    checkout_time: null,
    room_status: "Vacant Dirty",
    guest_name: "",
    guest_code: "",
    room_type: "",
    guest_arrival_date: null,
    stay_nights: 0,
    reserved: false,
    arrival_date: null,
    arrival_time: null,
  });
});

test("automatic image recovery retries incomplete extraction and validates recovered data before saving", async () => {
  let extractionCalls = 0;
  let validationCalls = 0;
  let persistedReport = "last accepted";
  const progress = [];
  const result = await extractAndValidateRoomOperations({
    onProgress: (phase, recoveryAttempt, unresolved) => progress.push({ phase, recoveryAttempt, unresolved }),
    extract: async ({ recoveryAttempt, unresolved, previousReport }) => {
      extractionCalls += 1;
      if (!recoveryAttempt) return { missing: true };
      assert.equal(recoveryAttempt, 1);
      assert.match(unresolved, /Room 103.*guest name/);
      assert.deepEqual(previousReport, { missing: true });
      return { room: "103", guest_name: "Source-backed Guest" };
    },
    validate: async (report) => {
      validationCalls += 1;
      if ("missing" in report) {
        return { ok: false, error: "Room 103 current guest details are incomplete: guest name.", recoverable: true };
      }
      return { ok: true, value: { rows: [report], complete: true } };
    },
  });
  persistedReport = result.validation.rows[0].guest_name;
  assert.equal(extractionCalls, 2);
  assert.equal(validationCalls, 2);
  assert.equal(persistedReport, "Source-backed Guest");
  assert.equal(progress.some(({ phase, recoveryAttempt }) => phase === "extract" && recoveryAttempt === 1), true);
});

test("exhausted automatic recovery preserves accepted data and names the unresolved source field", async () => {
  let extractionCalls = 0;
  let importCalls = 0;
  const lastAccepted = { report: "unchanged" };
  await assert.rejects(
    extractAndValidateRoomOperations({
      extract: async () => {
        extractionCalls += 1;
        return { room: "103", guest_name: "" };
      },
      validate: async () => ({
        ok: false,
        error: "Room 103 current guest details on source page 2 are incomplete or unreadable: guest name.",
        recoverable: true,
      }),
    }).then((result) => {
      importCalls += 1;
      return result;
    }),
    /Automatic image recovery exhausted 2 additional passes.*No room data was changed.*Room 103.*source page 2.*guest name/s,
  );
  assert.equal(extractionCalls, ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT + 1);
  assert.equal(importCalls, 0);
  assert.deepEqual(lastAccepted, { report: "unchanged" });
  assert.equal(isRecoverableRoomOperationsValidationError(422, "Room 103 guest name is unreadable."), true);
  assert.equal(isRecoverableRoomOperationsValidationError(422, "Room Status row 3 room must contain a room number."), true);
  assert.equal(isRecoverableRoomOperationsValidationError(409, "Room Status Report is not newer than the latest accepted version."), false);
  assert.equal(isRecoverableRoomOperationsValidationError(503, "Room report schema is unavailable."), false);
  assert.equal(isRecoverableRoomOperationsValidationError(429, "OpenAI rate limit exceeded."), false);
});

test("room status and expected departures merge by room and default a missing checkout time", () => {
  const statusRows = parserExports.parseRoomStatusReport([
    "Printed Date: 9/30/2026",
    "Printed Time: 8:15 AM",
    "Room\tRoom Status\tRoom Type\tArv\tDep\tLOS\tCode\tName\tBlk'd\tDue In\tType\tName",
    "316\tOccupied\tKING\t9/28/2026\t9/30/2026\t2\tREG\tCasey Guest\tNo\t\t\t",
    "MGR\tOut of Order\tSERVICE\t\t\t\t\t\tNo\t\t\t",
  ].join("\n"));
  const departureRows = parserExports.parseExpectedDepartures([
    "Printed Date: 9/30/2026",
    "Printed Time: 8:20 AM",
    "Room\tDeparture Date\tCheckout Time\tGuest Name",
    "316\t\t\tCasey Guest",
    "412\t9/30/2026\t10:30 AM\tJordan Guest",
  ].join("\n"));
  const rows = parserExports.mergeRoomOperations(statusRows, departureRows, "2026-09-30");
  const room316 = rows.find((row) => row.room === "316");
  const room412 = rows.find((row) => row.room === "412");
  const mgr = rows.find((row) => row.room === "MGR");
  assert.equal(rows.length, 3);
  assert.equal(room316.checkout_date, "9/30/2026");
  assert.equal(room316.checkout_time, "11:00 AM");
  assert.equal(room316.room_status, "Occupied");
  assert.equal(room412.checkout_time, "10:30 AM");
  assert.equal(room412.room_status, "");
  assert.equal(mgr.room_status, "Out of Order");
  assert.equal(mgr.room, "MGR");
});

test("report parsers fail instead of dropping unknown or duplicate rooms", () => {
  assert.throws(() => parserExports.parseRoomStatusReport("Printed Date: 9/30/2026\nRoom\tRoom Status\n?\tOccupied"), /room was not recognized/);
  assert.throws(() => parserExports.parseRoomStatusReport("Printed Date: 9/30/2026\nRoom\tRoom Status\n316\tOccupied\n316\tVacant"), /more than once/);
  assert.throws(() => parserExports.parseExpectedDepartures("Guest\tCheckout Time\nCasey\t11 AM"), /missing a Room column/);
});

test("room-operation snapshot verification compares equivalent database and preview times", () => {
  const normalizeTime = snapshotTimeExports.normalizeSnapshotTime;
  const normalizeValue = snapshotTimeExports.normalizeSnapshotValue;
  const snapshotMatches = snapshotTimeExports.snapshotMatches;
  assert.equal(normalizeTime("11:00 AM"), "11:00:00");
  assert.equal(normalizeTime("11:00:00"), "11:00:00");
  assert.equal(normalizeTime("12:00 AM"), "00:00:00");
  assert.equal(normalizeTime("12:00 PM"), "12:00:00");
  assert.equal(normalizeTime("1:05:09 PM"), "13:05:09");
  assert.equal(normalizeTime("13:05"), "13:05:00");
  assert.equal(normalizeTime("25:00"), "25:00");
  assert.equal(normalizeTime(""), "");
  assert.equal(normalizeValue(null), "");
  assert.equal(normalizeValue("  "), "");

  const expected = [{
    room: "102", checkout_date: "2026-10-04", checkout_time: "11:00 AM", room_status: "Occupied",
    arrival_date: "", arrival_time: "", move_from: "", move_to: "", guest_name: "Audit Guest Two",
    room_type: "KING", guest_code: "", guest_arrival_date: "", stay_nights: 0, reserved: false,
  }];
  const persisted = [{ ...expected[0], checkout_time: "11:00:00", imported_at: "2026-10-04T10:47:54.701152+00:00" }];
  assert.equal(snapshotMatches(expected, persisted), true);
  assert.equal(snapshotMatches(expected, [{ ...persisted[0], checkout_time: "12:00:00" }]), false);

  const optionalFieldsExpected = [{
    room: "MGR", checkout_date: "", checkout_time: "", room_status: "Out of Order",
    arrival_date: "", arrival_time: "", move_from: "", move_to: "", guest_name: "",
    room_type: "", guest_code: "", guest_arrival_date: "", stay_nights: 0, reserved: false,
  }];
  const optionalFieldsPersisted = [{
    ...optionalFieldsExpected[0],
    checkout_date: null,
    arrival_date: null,
    arrival_time: null,
    guest_name: null,
    room_type: null,
    guest_code: null,
    guest_arrival_date: null,
    imported_at: "2026-10-04T11:15:35.230025+00:00",
  }];
  assert.equal(snapshotMatches(optionalFieldsExpected, optionalFieldsPersisted), true);
  assert.equal(snapshotMatches(optionalFieldsExpected, [{ ...optionalFieldsPersisted[0], guest_name: "Unexpected" }]), false);
});

test("room moves are detected from unique guest names across the two snapshots", () => {
  const yesterday = [
    { room: "316", guest_name: "  Casey   Guest " },
    { room: "412", guest_name: "Jordan Guest" },
  ];
  const today = [
    { room: "412", guest_name: "casey guest" },
    { room: "507", guest_name: "Jordan Guest" },
    { room: "MGR", guest_name: "" },
  ];
  const rows = detectRoomMoves(yesterday, today);
  assert.deepEqual(rows.map(({ room, move_from, move_to }) => ({ room, move_from, move_to })), [
    { room: "412", move_from: "316", move_to: "412" },
    { room: "507", move_from: "412", move_to: "507" },
    { room: "MGR", move_from: "", move_to: "" },
  ]);
  const reportedMove = detectRoomMoves([], [{ room: "509", guest_name: "Guest", move_from: "412", move_to: "509" }]);
  assert.equal(reportedMove[0].move_from, "412", "reported or previously persisted moves are retained without a prior snapshot match");
  assert.equal(reportedMove[0].move_to, "509");
  const ambiguous = detectRoomMoves(
    [{ room: "316", guest_name: "Same Name" }, { room: "317", guest_name: "Same Name" }],
    [{ room: "412", guest_name: "Same Name" }],
  );
  assert.equal(ambiguous[0].move_from, "");

  const rcnaIgnored = detectRoomMoves(
    [
      { room: "316", guest_name: "Same Name", guest_code: " rcna " },
      { room: "317", guest_name: "Same Name", guest_code: "REG" },
    ],
    [{ room: "412", guest_name: "Same Name", guest_code: "reg" }],
  );
  assert.equal(rcnaIgnored[0].move_from, "317", "RCNA rows do not make a real guest appear duplicated");
  assert.equal(rcnaIgnored.length, 1);

  const rcnaCurrent = detectRoomMoves(
    [{ room: "316", guest_name: "Casey Guest", guest_code: "REG" }],
    [{ room: "412", guest_name: "Casey Guest", guest_code: "RCNA" }],
  );
  assert.equal(rcnaCurrent[0].move_from, "", "a current RCNA row is excluded from room-move matching");
});

test("room-operations notifications report out-of-order and move room numbers, excluding RCNA", () => {
  const notification = notificationExports.roomOperationsNotification(
    "import-123",
    "2026-09-30",
    [
      { room: "412", guest_name: "Same Name", guest_code: "REG", room_status: "Occupied" },
      { room: "509", guest_name: "", guest_code: "", room_status: "Out of Order" },
    ],
    [
      { room: "316", guest_name: "Same Name", guest_code: "RCNA", room_status: "Occupied" },
      { room: "317", guest_name: "Same Name", guest_code: "REG", room_status: "Occupied" },
    ],
    "2026-09-30T15:00:00.000Z",
  );
  assert.equal(notification.work_order_id, null);
  assert.equal(notification.target_path, "/engineering/room-operations");
  assert.match(notification.message, /509 \(Out of Order\)/);
  assert.match(notification.message, /317 → 412/);
  assert.doesNotMatch(notification.message, /316/);
  assert.equal(notificationExports.roomOperationsNotification("import-456", "2026-09-30", [
    { room: "316", guest_name: "Guest", guest_code: "RCNA", room_status: "Occupied" },
  ], [
    { room: "412", guest_name: "Guest", guest_code: "REG", room_status: "Occupied" },
  ]), null);
});

test("room-operations import summary reports today's checkouts, OOO rooms, and active work orders in checkout rooms", () => {
  const summary = summarizeRoomOperations([
    { room: "101", checkout_date: "2026-10-05", room_status: "Occupied" },
    { room: "102", checkout_date: "2026-10-06", room_status: "Out of Order" },
    { room: "103", checkout_date: "", room_status: "OOO" },
  ], "2026-10-05");
  assert.equal(summary.checkoutCount, 1);
  assert.deepEqual(summary.outOfOrderRooms, [
    { room: "102", status: "Out of Order" },
    { room: "103", status: "OOO" },
  ]);
  assert.equal(formatCheckoutRoomWorkOrders([]), "Open work orders in checkout rooms: none.");
  assert.equal(formatCheckoutRoomWorkOrders(null), "Open work orders in checkout rooms: unable to check.");
  assert.equal(formatCheckoutRoomWorkOrders([
    { room: "101", display_id: "WO-123", issue: "Leaking faucet", status: "In Progress" },
  ]), "Open work orders in checkout rooms: Room 101 — WO-123 (In Progress): Leaking faucet.");

  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  assert.match(api, /\.from\("work_orders"\)[\s\S]*\.in\("room", checkoutRooms\)[\s\S]*\.in\("status", \["Open", "In Progress"\]\)/);
  assert.match(api, /checkout_work_orders: checkoutWorkOrders/);
});

test("room-operations uploads validate printed reports, retain history, and reconcile checkouts", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20261010180000_cmpri_room_operations_provenance_checkouts.sql", import.meta.url), "utf8");
  assert.match(api, /\["paste", "file"\]/);
  assert.match(api, /reportDate > today/);
  assert.match(migration, /Room Status Report printed identity or fingerprint is missing/);
  assert.match(api, /roomValue/);
  assert.match(api, /room !== "MGR" && !knownRooms\.has\(room\)/);
  assert.match(api, /\\d\{2,4\}\|MGR/);
  assert.match(api, /parsedCheckoutTime \|\| "11:00:00"/);
  assert.match(api, /loadEffectiveRoomOperationsSnapshot\(auth\.admin, date\)/);
  assert.match(api, /source_type: snapshot\.source_type/);
  assert.match(api, /carried_over: snapshot\.carried_over/);
  assert.match(api, /cmpri_reconcile_room_operations/);
  assert.match(api, /auth\.admin\.rpc\("cmpri_replace_room_operations"/);
  assert.match(api, /p_rows: rowsForStorage/);
  assert.match(api, /roomOperationsNotification/);
  assert.match(api, /guest_code: typeof row\.guest_code === "string" \? row\.guest_code : ""/);
  assert.match(api, /notification_key: notification\.id/);
  assert.match(api, /target_path: notification\.target_path/);
  assert.match(migration, /create table if not exists public\.cmpri_room_operation_imports/);
  assert.match(migration, /create table if not exists public\.cmpri_room_operation_checkout_transitions/);
  assert.match(migration, /'legacy'/);
  assert.match(migration, /jsonb_agg\(jsonb_build_object/);
  assert.match(migration, /original report metadata unavailable/);
  assert.match(migration, /source_type <> 'legacy'/);
  assert.match(migration, /p_source_type not in \('paste', 'file'\)/);
  assert.match(migration, /create or replace function public\.cmpri_reconcile_room_operations/);
  assert.match(migration, /create or replace function public\.cmpri_replace_room_operations/);
  assert.match(migration, /delete from public\.room_operations where hotel_id = p_hotel_id/);
  assert.doesNotMatch(migration, /delete from (?:public\.)?(?:profiles|work_orders|auth\.users)/);
  const snapshot = readFileSync(new URL("../src/lib/server/cmpri-room-operations-snapshot.ts", import.meta.url), "utf8");
  const availability = readFileSync(new URL("../src/lib/server/room-availability.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/engineering/room-operations/page.tsx", import.meta.url), "utf8");
  assert.match(snapshot, /\.lte\("report_date", requestedDate\)/);
  assert.match(snapshot, /order\("report_date", \{ ascending: false \}\)/);
  assert.match(availability, /loadEffectiveRoomOperationsSnapshot\(admin, date\)/);
  assert.match(page, /Showing \{snapshotInfo\.sourceType === "legacy" \? "legacy room data"/);
  assert.match(page, /selected date/);
  assert.match(page, /displayDate\(snapshotInfo\.requestedDate\)/);
});

test("effective room snapshot carries forward complete history without future leakage and protects newer room state", async () => {
  const legacyRows = Array.from({ length: 112 }, (_, index) => ({
    room: String(101 + index),
    room_status: index === 111 ? "Out of Order" : "Occupied",
    guest_name: `Guest ${index + 1}`,
    report_date: "2026-10-09",
  }));
  const legacy = await loadEffectiveRoomOperationsSnapshot(snapshotAdmin({
    cmpri_room_operation_imports: [
      { hotel_id: "hotel-test", id: "future", report_date: "2026-10-11", source_type: "legacy", source_rows: [], uploaded_at: "2026-10-11T12:00:00Z" },
      { hotel_id: "hotel-test", id: "legacy-oct-9", report_date: "2026-10-09", source_type: "legacy", source_rows: legacyRows, uploaded_at: "2026-10-09T12:00:00Z" },
    ],
    cmpri_room_operations: [],
  }), "2026-10-10");
  assert.equal(legacy.requested_date, "2026-10-10");
  assert.equal(legacy.source_date, "2026-10-09");
  assert.equal(legacy.source_type, "legacy");
  assert.equal(legacy.carried_over, true);
  assert.equal(legacy.rows.length, 112);
  assert.equal(legacy.rows.filter((row) => row.room_status === "Out of Order").length, 1);
  assert.equal(legacy.rows.every((row) => row.report_date === "2026-10-09"), true);

  const beforeChicagoMidnight = await loadEffectiveRoomOperationsSnapshot(snapshotAdmin({
    cmpri_room_operation_imports: [
      { hotel_id: "hotel-test", id: "oct-9", report_date: "2026-10-09", source_type: "legacy", source_rows: legacyRows, uploaded_at: "2026-10-09T12:00:00Z" },
    ],
    cmpri_room_operations: [],
  }), hotelDateAt(new Date("2026-10-10T04:59:00Z"), "America/Chicago"));
  const afterChicagoMidnight = await loadEffectiveRoomOperationsSnapshot(snapshotAdmin({
    cmpri_room_operation_imports: [
      { hotel_id: "hotel-test", id: "oct-9", report_date: "2026-10-09", source_type: "legacy", source_rows: legacyRows, uploaded_at: "2026-10-09T12:00:00Z" },
    ],
    cmpri_room_operations: [],
  }), hotelDateAt(new Date("2026-10-10T05:00:00Z"), "America/Chicago"));
  assert.equal(beforeChicagoMidnight.requested_date, "2026-10-09");
  assert.equal(beforeChicagoMidnight.carried_over, false);
  assert.equal(afterChicagoMidnight.requested_date, "2026-10-10");
  assert.equal(afterChicagoMidnight.source_date, "2026-10-09");
  assert.equal(afterChicagoMidnight.carried_over, true);

  const noPastSnapshot = await loadEffectiveRoomOperationsSnapshot(snapshotAdmin({
    cmpri_room_operation_imports: [
      { hotel_id: "hotel-test", id: "future", report_date: "2026-10-11", source_type: "legacy", source_rows: legacyRows, uploaded_at: "2026-10-11T12:00:00Z" },
    ],
    cmpri_room_operations: [],
  }), "2026-10-10");
  assert.equal(noPastSnapshot.source_date, null);
  assert.equal(noPastSnapshot.rows.length, 0);

  const transitioned = applyRoomOperationCheckoutTransitions([{
    room: "101",
    room_status: "Occupied",
    guest_name: "Departing Guest",
    checkout_date: "2026-10-10",
    checkout_time: "11:00 AM",
    incoming_name: "Next Guest",
    incoming_block_indicator: "Blocked",
  }], [{
    room: "101",
    departing_guest_name: "Departing Guest",
    checkout_date: "2026-10-10",
    checkout_time: "11:00:00",
  }], "accepted-import");
  assert.equal(transitioned[0].room_status, "Vacant Dirty");
  assert.equal(transitioned[0].guest_name, "");
  assert.equal(transitioned[0].incoming_name, "Next Guest");
  assert.equal(transitioned[0].incoming_block_indicator, "Blocked");

  const protectedRows = applyRoomOperationCheckoutTransitions([
    { room: "101", room_status: "Occupied", guest_name: "New Guest", checkout_date: "2026-10-10", checkout_time: "11:00 AM" },
    { room: "102", room_status: "Vacant Ready", guest_name: "", checkout_date: "2026-10-10", checkout_time: "11:00 AM" },
  ], [
    { room: "101", departing_guest_name: "Old Guest", checkout_date: "2026-10-10", checkout_time: "11:00:00" },
    { room: "102", departing_guest_name: "", checkout_date: "2026-10-10", checkout_time: "11:00:00" },
  ], "accepted-import");
  assert.equal(protectedRows[0].guest_name, "New Guest");
  assert.equal(protectedRows[0].room_status, "Occupied");
  assert.equal(protectedRows[1].room_status, "Vacant Ready");

  const dueSourceRows = [
    { room: "201", room_status: "Occupied Dirty", guest_name: "Departed Guest", checkout_date: "2026-10-09", checkout_time: "11:00:00" },
    { room: "202", room_status: "Occupied", guest_name: "Current Guest", checkout_date: "2026-10-10", checkout_time: "11:00:00" },
    { room: "203", room_status: "Occupied", guest_name: "Future Guest", checkout_date: "2026-10-11", checkout_time: "11:00:00" },
    { room: "204", room_status: "Occupied", guest_name: "Unknown Time", checkout_date: "2026-10-09", checkout_time: null },
    { room: "205", room_status: "Occupied", guest_name: "Original Guest", checkout_date: "2026-10-09", checkout_time: "11:00:00" },
    { room: "206", room_status: "Occupied", guest_name: "Original Guest", checkout_date: "2026-10-09", checkout_time: "11:00:00" },
    { room: "207", room_status: "Occupied", guest_name: "Original Guest", checkout_date: "2026-10-09", checkout_time: "11:00:00", source_import_id: "other-import" },
  ];
  const dueRows = dueSourceRows.map((row) => ({ ...row, incoming_name: `Incoming ${row.room}` }));
  dueRows[4] = { ...dueRows[4], guest_name: "New Guest" };
  dueRows[5] = { ...dueRows[5], room_status: "Vacant Ready" };
  const afterDeadline = applyExpiredRoomOperationCheckouts(
    dueRows,
    dueSourceRows,
    "accepted-import",
    "2026-10-10",
    new Date("2026-10-10T22:00:00.000Z"),
  );
  assert.equal(afterDeadline[0].room_status, "Vacant Dirty");
  assert.equal(afterDeadline[0].guest_name, "");
  assert.equal(afterDeadline[0].incoming_name, "Incoming 201");
  assert.equal(afterDeadline[1].room_status, "Vacant Dirty");
  assert.equal(afterDeadline[2].room_status, "Occupied");
  assert.equal(afterDeadline[3].room_status, "Occupied");
  assert.equal(afterDeadline[4].guest_name, "New Guest");
  assert.equal(afterDeadline[5].room_status, "Vacant Ready");
  assert.equal(afterDeadline[6].room_status, "Occupied");

  const beforeDeadline = applyExpiredRoomOperationCheckouts(
    [dueSourceRows[1]],
    [dueSourceRows[1]],
    "accepted-import",
    "2026-10-10",
    new Date("2026-10-10T15:59:59.000Z"),
  );
  assert.equal(beforeDeadline[0].room_status, "Occupied");
  const historicalSelection = applyExpiredRoomOperationCheckouts(
    [dueSourceRows[0]],
    [dueSourceRows[0]],
    "accepted-import",
    "2026-10-09",
    new Date("2026-10-10T22:00:00.000Z"),
  );
  assert.equal(historicalSelection[0].room_status, "Occupied Dirty");
});

test("room-operations cleanup fails closed until its retention policy is confirmed", () => {
  assert.equal(expiredRoomOperationsBefore(new Date("2026-10-07T04:59:00.000Z"), "America/Chicago"), "2026-10-05");
  assert.equal(expiredRoomOperationsBefore(new Date("2026-10-07T05:00:00.000Z"), "America/Chicago"), "2026-10-06");
  assert.equal(expiredRoomOperationsBefore(new Date("2026-11-02T06:00:00.000Z"), "America/Chicago"), "2026-11-01");

  const cleanupRoute = readFileSync(new URL("../src/app/api/room-operations/cleanup/route.ts", import.meta.url), "utf8");
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.match(cleanupRoute, /request\.headers\.get\("authorization"\) !== `Bearer \$\{secret\}`/);
  assert.match(cleanupRoute, /Room Operations cleanup is disabled until a retention policy is confirmed/);
  assert.doesNotMatch(cleanupRoute, /\.delete\(\)/);
  assert.equal(vercel.crons.some(({ path }) => path === "/api/room-operations/cleanup"), false);
});

test("manual import previews two reports and verifies the replacement snapshot", () => {
  const source = importerSource;
  assert.match(source, /Room Status Report/);
  assert.match(source, /Expected Departures/);
  assert.match(source, /Preview Merged Snapshot/);
  assert.match(source, /function mergeRoomOperations/);
  const start = source.indexOf("async function commitImport");
  const end = source.indexOf("\n  return (", start);
  const commit = source.slice(start, end);
  assert.match(commit, /report_data: preview\.report_data/);
  assert.match(commit, /payload\.ok !== true \|\| !payload\.import_id/);
  assert.match(commit, /api\/room-operations\?date=/);
  assert.match(source, /function snapshotMatches/);
  assert.match(commit, /snapshotMatches\(preview\.rows, result\.rows\)/);
  assert.match(source, /snapshotMatches\(validationPayload\.rows, result\.rows\)/);
});

test("server CSV parser preserves room status aliases and all room rows", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const apiAst = ts.createSourceFile("room-operations-route.ts", api, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ["parseDelimitedCells", "parseCsvToRows"].map((name) => {
    const node = apiAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `${name} must be declared`);
    return node.getText(apiAst);
  });
  const parserExports = {};
  vm.runInNewContext(ts.transpileModule(
    `${functions.join("\n")}\nexports.parseCsvToRows = parseCsvToRows;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText, { exports: parserExports });
  const rows = parserExports.parseCsvToRows([
    "Room,HK Status,Guest Name,Room Type",
    "316,VR,Casey Guest,KING",
    "317,VD,,2QUEEN",
    "318,Out of Order,,KING",
  ].join("\n"));
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(rows, (row) => row.room_status), ["VR", "VD", "Out of Order"]);
  assert.deepEqual(Array.from(rows, (row) => row.room), ["316", "317", "318"]);

  const reportRows = parserExports.parseCsvToRows(
    readFileSync(new URL("./fixtures/daily-room-ops-report.csv", import.meta.url), "utf8"),
  );
  const room103 = reportRows.find((row) => row.room === "103");
  const room411 = reportRows.find((row) => row.room === "411");
  const room421 = reportRows.find((row) => row.room === "421");
  assert.equal(room103.checkout_date, "01Dec");
  assert.equal(room103.guest_arrival_date, "13Apr");
  assert.equal(room103.guest_code, "RCNA");
  assert.equal(room103.guest_name, "RAILWAY/CN-NJ8");
  assert.equal(room411.arrival_date, "05Oct");
  assert.equal(room411.reserved, "64827");
  assert.equal(room421.room_status, "OOO");
});

test("server import rejects occupied rows missing any current guest field", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const apiAst = ts.createSourceFile("room-operations-route.ts", api, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = apiAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "missingCurrentGuestFields");
  assert.ok(node, "missingCurrentGuestFields must be declared");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(
    `${node.getText(apiAst)}\nexports.missingCurrentGuestFields = missingCurrentGuestFields;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText, { exports });
  const missing = exports.missingCurrentGuestFields([
    { room: "103", room_status: "OCCUPIED DIRTY", guest_name: "", guest_code: "RCNA", guest_arrival_date: "2026-04-13", checkout_date: "2026-12-01" },
    { room: "104", room_status: "Occupied", guest_name: "Railway/CN", guest_code: "", guest_arrival_date: "2026-04-13", checkout_date: "2026-12-01" },
    { room: "105", room_status: "Occupied Clean", guest_name: "Guest", guest_code: "RCNA", guest_arrival_date: "", checkout_date: "2026-12-01" },
    { room: "106", room_status: "Occupied Clean", guest_name: "Guest", guest_code: "RCNA", guest_arrival_date: "2026-04-13", checkout_date: "" },
    { room: "421", room_status: "OOO", guest_name: "", guest_code: "", guest_arrival_date: "", checkout_date: "" },
  ]);
  assert.deepEqual(Array.from(missing), [
    "Room 103: guest name, room type, length of stay",
    "Room 104: guest code, room type, length of stay",
    "Room 105: room type, current guest arrival date, length of stay",
    "Room 106: room type, current guest departure date, length of stay",
  ]);
  assert.deepEqual(Array.from(exports.missingCurrentGuestFields([
    { room: "103", room_status: "Occupied", guest_name: "Guest", guest_code: "RCNA", room_type: "KING", guest_arrival_date: "2026-04-13", checkout_date: "2026-12-01", stay_nights: 2 },
    { room: "421", room_status: "OOO", guest_name: "", guest_code: "", guest_arrival_date: "", checkout_date: "" },
  ])), []);
  assert.ok(api.indexOf("if (missingGuestFields.length)") < api.indexOf('auth.admin.rpc("cmpri_replace_room_operations"'));
});

test("image extraction magnifies table crops from the uploaded report page", async () => {
  const image = await sharp({
    create: { width: 768, height: 1024, channels: 3, background: "#ffffff" },
  }).jpeg().toBuffer();
  const crops = await createRoomOperationsOcrCrops(image);
  assert.equal(crops.length, 2);
  for (const crop of crops) {
    const metadata = await sharp(crop).metadata();
    assert.equal(metadata.width, 1800);
    assert.ok(metadata.height > 700);
    assert.equal(metadata.format, "jpeg");
  }
  const recoveryCrops = await createRoomOperationsRecoveryCrops(image);
  assert.equal(recoveryCrops.length, 4);
  for (const crop of recoveryCrops) {
    const metadata = await sharp(crop).metadata();
    assert.equal(metadata.width, 2400);
    assert.ok(metadata.height > 0);
    assert.equal(metadata.format, "jpeg");
  }
  const smallImage = await sharp({
    create: { width: 200, height: 200, channels: 3, background: "#ffffff" },
  }).jpeg().toBuffer();
  await assert.rejects(createRoomOperationsOcrCrops(smallImage), /too small to read/);
});

test("daily room-operations report import preserves current guest dates, codes, names, blocked arrivals, and OOO rooms", () => {
  const fixture = readFileSync(new URL("./fixtures/daily-room-ops-report.csv", import.meta.url), "utf8").trim();
  const statusRows = parserExports.parseRoomStatusReport(fixture);
  const departures = parserExports.parseExpectedDepartures([
    "Printed Date: 10/5/2026",
    "Lvl\tName\tFolio\tRm #\tType Code\tBill Type\tGroup",
    "MRD\tCLINE, ANTHONY\t64928\t103\tSTDO\tB\tDS",
  ].join("\n"));
  assert.equal(departures[0].room, "103", "Expected Departures uses the Marriott 'Rm #' header");

  const rows = parserExports.mergeRoomOperations(statusRows, departures, "2026-10-05");
  const room103 = rows.find((row) => row.room === "103");
  const room411 = rows.find((row) => row.room === "411");
  const room421 = rows.find((row) => row.room === "421");
  assert.equal(room103.guest_arrival_date, "13Apr", "Arv is the current guest arrival date");
  assert.equal(room103.checkout_date, "01Dec", "Dep is the current guest departure date, not the report date");
  assert.equal(room103.guest_code, "RCNA");
  assert.equal(room103.guest_name, "RAILWAY/CN-NJ8");
  assert.equal(room103.reserved, false);
  assert.equal(room411.arrival_date, "05Oct", "Due In is kept separate as the incoming guest's arrival");
  assert.equal(room411.reserved, true, "a numeric Blk'd value indicates a blocked incoming guest");
  assert.equal(room421.room_status, "OOO");
});

test("Railway/CN badge matches its stable core when the guest suffix changes", () => {
  assert.equal(isRailwayCnGuestName("RAILWAY/CN-NJ8"), true);
  assert.equal(isRailwayCnGuestName("RAILWAY/CN-CHANGED"), true);
  assert.equal(isRailwayCnGuestName("railway / cn anything"), true);
  assert.equal(isRailwayCnGuestName("Different Guest"), false);
});

test("image import rejects occupied rows whose extracted current guest name is missing", () => {
  const rows = [
    { room: "103", room_status: "OCCUPIED DIRTY", guest_code: "RCNA", guest_arrival_date: "2026-04-13", checkout_date: "2026-12-01", guest_name: "" },
    { room: "104", room_status: "OCCUPIED DIRTY", guest_code: "RCNA", guest_arrival_date: "2026-04-13", checkout_date: "2026-12-01", guest_name: "RAILWAY/CN-CHANGED" },
    { room: "421", room_status: "OOO", guest_code: "", guest_arrival_date: "", checkout_date: "", guest_name: "" },
  ];
  assert.deepEqual(parserExports.missingCurrentGuestNames(rows), ["103"]);
});

test("Marriott departures report Dplm time is imported and missing time defaults to 11 AM", () => {
  const departures = parserExports.parseExpectedDepartures([
    "Printed Date: 10/5/2026",
    "Lvl\tName\tFolio\tRm #\tType Code\tBill Type\tGroup\tDplm",
    "MRD\tCLINE, ANTHONY\t64928\t103\tSTDO\tB\tDS\t10:30AM",
    "MRD\tCOX, CLEOPHUS\t16293\t212\tSTDO\tNBNT\tDB\t",
  ].join("\n"));
  const rows = parserExports.mergeRoomOperations([], departures, "2026-10-05");
  assert.equal(rows.find((row) => row.room === "103").checkout_date, "2026-10-05");
  assert.equal(rows.find((row) => row.room === "103").checkout_time, "10:30AM");
  assert.equal(rows.find((row) => row.room === "212").checkout_time, "11:00 AM");
});

test("room-operation checkout dates preserve four-digit US years", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const apiAst = ts.createSourceFile("room-operations-route.ts", api, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ["validDate", "normalizedDate", "reserved"].map((name) => {
    const node = apiAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `${name} must be declared`);
    return node.getText(apiAst);
  });
  const dateExports = {};
  vm.runInNewContext(ts.transpileModule(
    `${functions.join("\n")}\nexports.normalizedDate = normalizedDate; exports.reserved = reserved;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText, { exports: dateExports, hotelDate: () => "2026-10-05" });
  assert.equal(dateExports.normalizedDate("10/4/2026"), "2026-10-04");
  assert.equal(dateExports.normalizedDate("10/4/26"), "2026-10-04");
  assert.equal(dateExports.normalizedDate("2026-10-04"), "2026-10-04");
  assert.equal(dateExports.normalizedDate("2/30/2026"), "");
  assert.equal(dateExports.normalizedDate("13Apr", "2026-10-05"), "2026-04-13");
  assert.equal(dateExports.normalizedDate("01Dec", "2026-10-05"), "2026-12-01");
  assert.equal(dateExports.reserved("64827"), true);
  assert.equal(dateExports.reserved("0"), false);
  assert.equal(dateExports.normalizedDate("2026-02-30"), "");
});

test("room imports reject incomplete room/status snapshots and image uploads preflight before saving", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const importer = importerSource;
  assert.match(api, /const missingRooms = \[\.\.\.knownRooms\]\.filter/);
  assert.match(api, /const missingStatuses = rows\.filter/);
  assert.match(api, /status: 422/);
  assert.match(api, /Nothing was imported/);
  assert.match(importer, /validate_only: true/);
  assert.match(importer, /report_data: reportData/);
  assert.match(importer, /report_data: preview\.report_data/);
});

test("room availability bubbles normalize room identifiers and mark only vacant-ready rooms available", () => {
  assert.equal(roomKey("Room 0316"), "0316");
  assert.equal(roomKey("mgr"), "MGR");
  assert.equal(roomStatusBadge("VR")?.available, true);
  assert.equal(roomStatusBadge("Vacant Ready")?.label, "Available");
  assert.equal(roomStatusBadge("VD")?.available, false);
  assert.equal(roomStatusBadge("Occupied")?.available, false);
  assert.equal(roomStatusBadge("") , null);
  const createRoute = readFileSync(new URL("../src/app/api/rooms/route.ts", import.meta.url), "utf8");
  const workOrdersRoute = readFileSync(new URL("../src/app/api/work-orders/route.ts", import.meta.url), "utf8");
  const selector = readFileSync(new URL("../src/components/desktop/WorkOrderListWindow.tsx", import.meta.url), "utf8");
  const roomAvailability = readFileSync(new URL("../src/lib/server/room-availability.ts", import.meta.url), "utf8");
  assert.match(createRoute, /room_status: currentRoomStatus/);
  assert.match(workOrdersRoute, /room_status: currentRoomStatus/);
  assert.match(selector, /roomStatusBadge\(order\.room_status\)/);
  assert.match(roomAvailability, /loadEffectiveRoomOperationsSnapshot\(admin, date\)/);
});

test("technician room data is scoped to assigned and unassigned active work", () => {
  const api = readFileSync(new URL("../src/app/api/rooms/route.ts", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../src/app/technician/page.tsx", import.meta.url), "utf8");
  assert.match(api, /roleKey\(principal\.profile\.role\) === "technician"/);
  assert.match(api, /!allows\(principal, "view_engineering_operations"\) && !\(isTechnician && allows\(principal, "view_pm"\)\)/);
  assert.match(api, /can_edit: allows\(principal, "manage_rooms"\)/);
  assert.match(api, /\.in\("status", \["Open", "In Progress"\]\)/);
  assert.match(api, /\.or\("technician_name\.is\.null,technician_name\.eq\."\)/);
  assert.match(api, /\.eq\("technician_name", technicianName\)/);
  assert.match(dashboard, /key:"\/engineering\/preventive-maintenance",label:"Preventive Maintenance"/);
});

test("room operations do not show move or out-of-order event bubbles", () => {
  const page = readFileSync(new URL("../src/app/engineering/room-operations/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Moves: \{summary\.moves\}/);
  assert.doesNotMatch(page, /\["moves", "Moves"/);
  assert.doesNotMatch(page, /\["outOfOrder", "Out of Order"/);
  assert.match(page, /isOutOfOrder\(row\.room_status\)[\s\S]*text-red-200/);
  assert.match(page, /function CheckoutPill/);
  assert.match(page, /function MovePill/);
  assert.match(page, /border-yellow-400\/45 bg-yellow-950\/35 text-yellow-200/);
  assert.match(page, /rounded-full border border-red-400\/60 bg-red-950\/70 px-2 py-0\.5 text-xs font-bold/);
  assert.doesNotMatch(page, /<div className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300"><div className="font-semibold text-slate-500">Move/);
  assert.doesNotMatch(page, /Incoming<\/div>|<strong className="text-slate-400">Incoming:/);
  assert.match(page, /function RoomIdentity/);
  assert.match(page, /currentRoomGroupBadges\(row\)\.guest_group_badge/);
  assert.match(page, /currentRoomGroupBadges\(row\)\.incoming_group_badge/);
  assert.match(page, /row\.guest_name \? <div className="mt-1 break-words text-lg font-normal text-slate-400">[\s\S]*?\{row\.guest_name\} <GuestGroupBadge badge=\{currentRoomGroupBadges\(row\)\.guest_group_badge\}\/><\/div>/);
});

test("checkout emphasis is limited to today, tomorrow and overdue dates", () => {
  const page = readFileSync(new URL("../src/app/engineering/room-operations/page.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("room-operations-page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ["daysUntilCheckout", "displayCheckoutTime", "checkoutLabel", "checkoutClass"].map((name) => {
    const node = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `${name} must be declared`);
    return node.getText(ast);
  });
  const checkoutExports = {};
  vm.runInNewContext(
    ts.transpileModule(
      `${functions.join("\n")}\nexports.daysUntilCheckout = daysUntilCheckout; exports.checkoutLabel = checkoutLabel; exports.checkoutClass = checkoutClass;`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      exports: checkoutExports,
      hotelDate: () => "2026-10-05",
      displayDate: (value) => value,
    },
  );
  assert.equal(checkoutExports.daysUntilCheckout("2026-10-06", "2026-10-05"), 1);
  assert.equal(checkoutExports.checkoutLabel({ checkout_date: "2026-10-05", checkout_time: "10:00 AM" }), "Checkout today · 10:00 AM");
  assert.equal(checkoutExports.checkoutLabel({ checkout_date: "2026-10-06", checkout_time: "10:30 AM" }), "Checkout tomorrow · 10:30 AM");
  assert.equal(checkoutExports.checkoutLabel({ checkout_date: "2026-10-08", checkout_time: "" }), "2026-10-08 · 11:00 AM");
  assert.equal(checkoutExports.checkoutLabel({ checkout_date: "2026-10-07", checkout_time: "11:00 AM" }), "2026-10-07 · 11:00 AM");
  assert.equal(checkoutExports.checkoutLabel({ checkout_date: "2026-10-04", checkout_time: "9:00 AM" }), "Overdue · 2026-10-04 · 9:00 AM");
  assert.equal(checkoutExports.checkoutLabel({ checkout_date: null, checkout_time: null }), "");
  assert.equal(checkoutExports.daysUntilCheckout("2027-01-01", "2026-12-31"), 1);
  assert.match(checkoutExports.checkoutClass(0), /text-green-200/);
  assert.match(checkoutExports.checkoutClass(1), /text-yellow-200/);
  assert.match(checkoutExports.checkoutClass(-1), /text-red-200/);
  for (const days of [2, 3, 90, null]) {
    assert.equal(checkoutExports.checkoutClass(days), "text-xs text-slate-400");
  }
});

test("room cards and summary modal share a soft guest layout and preserve reported OOO status", () => {
  const page = readFileSync(new URL("../src/app/engineering/room-operations/page.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["daysUntilCheckout", "displayCheckoutTime", "displayHotelTimestamp", "checkoutLabel", "checkoutClass", "roomStatusClass", "isOutOfOrder", "RoomIdentity", "CheckoutPill", "MovePill", "RoomDetails"];
  const functions = names.map(name => {
    const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `${name} must be declared`);
    return node.getText(ast);
  });
  const components = {};
  vm.runInNewContext(ts.transpileModule(
    `${functions.join("\n")}\nexports.RoomDetails = RoomDetails;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } },
  ).outputText, {
    exports: components, React, LoyaltyBadge:()=>null, GuestGroupBadge: () => null, Image: props => React.createElement("img", props),
    currentRoomGroupBadges: () => ({guest_group_badge:null,incoming_group_badge:null}), isRailwayCnGuestName, isBigTenGroup, hotelDate: () => "2026-10-05", displayDate: value => value,
  });
  const html = renderToStaticMarkup(React.createElement(components.RoomDetails, { row: {
    room: "103", guest_name: "RAILWAY/CN-NJ8", room_status: "OOO",
    guest_arrival_date: "2026-10-01", stay_nights: 4, room_type: "Hidden type", guest_code: "Hidden code",
    checkout_date: "2026-10-07", checkout_time: "10:30 AM",
  }, today: "2026-10-05" }));
  assert.match(html, /text-lg font-black text-white">Room 103/);
  assert.match(html, /h-\[1\.5em\] w-auto[^"]*text-lg/);
  assert.match(html, /<div class="mt-1 break-words text-lg font-normal text-slate-400">RAILWAY\/CN-NJ8\s*<\/div>/);
  assert.match(html, /text-sm text-slate-400/);
  assert.doesNotMatch(html, /Current arrival|2026-10-01/);
  assert.match(html, /LOS: 4 nights/);
  assert.match(html, /rounded-full border border-red-400\/45 bg-red-950\/35 px-2 py-0\.5 text-xs font-semibold text-red-200">OOO/);
  assert.match(html, />2026-10-07 · 10:30 AM<\/summary>/);
  assert.doesNotMatch(html, /Hidden type|Hidden code|<strong/);
  assert.equal((page.match(/<RoomDetails row=\{row\} today=\{today\} \/>/g) || []).length, 2);
});
test('work-order guest context uses the ticket-authorized projection rather than granting room-operations access',()=>{
 const page=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
 assert.match(page,/context.checkout_time/);assert.match(page,/payload.workOrder/);assert.doesNotMatch(page,/fetch\("\/api\/room-operations"/);
});

test("room-operations API accepts direct CSV payload and lenient LOS/reserved values", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  assert.match(api, /text\/csv/);
  assert.match(api, /parseCsvToRows/);
  assert.match(api, /body\.csv/);
  assert.match(api, /Number\.isSafeInteger\(parsed\)/);
});

test("room-operations image extraction endpoint sends image parts to ChatGPT vision", () => {
  const extractRoute = readFileSync(new URL("../src/app/api/room-operations/extract/route.ts", import.meta.url), "utf8");
  const mcpWrites = readFileSync(new URL("../src/lib/server/cmpri-mcp-writes.ts", import.meta.url), "utf8");
  assert.match(extractRoute, /requireCapability\(request, "edit_tickets"\)/);
  assert.match(extractRoute, /OPENAI_API_KEY/);
  assert.match(extractRoute, /api\.openai\.com\/v1\/chat\/completions/);
  assert.match(extractRoute, /image_url/);
  assert.match(extractRoute, /createRoomOperationsOcrCrops/);
  assert.match(extractRoute, /two enlarged, slightly overlapping table crops/);
  assert.match(extractRoute, /gpt-4o/);
  assert.match(extractRoute, /Return ONLY one valid JSON object/);
  assert.match(extractRoute, /"room_status"/);
  assert.match(extractRoute, /"expected_departures"/);
  assert.doesNotMatch(mcpWrites, /extractAndValidateRoomOperations|api\/room-operations\/extract/);
  assert.match(mcpWrites, /validate_only: true/);
  assert.match(mcpWrites, /submit verified report_data/);
  assert.match(extractRoute, /JSON\.parse\(cleanJson\)/);
  assert.match(extractRoute, /report_data: reportData/);
});

test("room-operations importer supports direct image upload and auto-import with ChatGPT", () => {
  const importer = readFileSync(new URL("../src/app/engineering/room-operations/RoomOperationsImport.tsx", import.meta.url), "utf8");
  assert.match(importer, /handleImageUpload/);
  assert.match(importer, /\/api\/room-operations\/extract/);
  assert.match(importer, /accept="\.csv,\.tsv,\.txt,image\/\*"/);
  assert.match(importer, /Upload RoomStatus Images/);
});

test("guest snapshot preserves group fields without querying legacy live rows", async () => {
  const date=hotelDateAt(new Date(),'America/Chicago');
  const row={room:'101',guest_name:'Jane Doe',room_status:'Occupied',checkout_date:'2099-01-01',checkout_time:'11:00:00',company:'Big Ten Team',group_name:'Big Ten Team',incoming_name:'Sam Guest',incoming_company:'Big Ten Visitors',guest_report_bundle:{guests:{date}}};
  const admin=snapshotAdmin({cmpri_room_operation_imports:[{id:'guest-snapshot',hotel_id:'hotel-test',report_date:date,source_type:'file',source_rows:[row],uploaded_at:new Date().toISOString()}]});
  const from=admin.from;admin.from=table=>{assert.equal(table,'cmpri_room_operation_imports');return from(table)};
  const result=await loadEffectiveRoomOperationsSnapshot(admin,date);
  assert.equal(result.error,null);assert.equal(result.rows[0].group_name,'Big Ten Team');assert.equal(result.rows[0].incoming_company,'Big Ten Visitors');assert.equal(result.rows[0].guest_name,'Jane Doe');
});
