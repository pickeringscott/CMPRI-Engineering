import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { detectRoomMoves } from "../src/lib/room-operations.ts";
import { roomKey, roomStatusBadge } from "../src/lib/room-availability.ts";

const importerSource = readFileSync(new URL("../src/app/engineering/room-operations/RoomOperationsImport.tsx", import.meta.url), "utf8");
const importerAst = ts.createSourceFile("room-operations-importer.tsx", importerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const parserFunctions = [
  "normalizeHeader",
  "parseDelimitedLine",
  "parseReport",
  "normalizeRoom",
  "parseRoomStatusReport",
  "parseExpectedDepartures",
  "mergeRoomOperations",
].map((name) => {
  const node = importerAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${name} must be declared`);
  return node.getText(importerAst);
});
const parserExports = {};
vm.runInNewContext(ts.transpileModule(
  `${parserFunctions.join("\n")}\nexports.parseRoomStatusReport = parseRoomStatusReport; exports.parseExpectedDepartures = parseExpectedDepartures; exports.mergeRoomOperations = mergeRoomOperations;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: parserExports });

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

test("room status and expected departures merge by room with an 11 AM checkout default", () => {
  const statusRows = parserExports.parseRoomStatusReport([
    "Room\tRoom Status\tGuest Name\tRoom Type\tLOS\tReserved",
    "316\tOccupied\tCasey Guest\tKING\t2\tNo",
    "MGR\tOut of Order\t\tSERVICE\t\tNo",
  ].join("\n"));
  const departureRows = parserExports.parseExpectedDepartures([
    "Room\tDeparture Date\tCheckout Time\tGuest Name",
    "316\t\t\tCasey Guest",
    "412\t9/30/2026\t10:30 AM\tJordan Guest",
  ].join("\n"));
  const rows = parserExports.mergeRoomOperations(statusRows, departureRows, "2026-09-30");
  const room316 = rows.find((row) => row.room === "316");
  const room412 = rows.find((row) => row.room === "412");
  const mgr = rows.find((row) => row.room === "MGR");
  assert.equal(rows.length, 3);
  assert.equal(room316.checkout_date, "2026-09-30");
  assert.equal(room316.checkout_time, "11:00 AM");
  assert.equal(room316.room_status, "Occupied");
  assert.equal(room412.checkout_time, "10:30 AM");
  assert.equal(room412.room_status, "");
  assert.equal(mgr.room_status, "Out of Order");
  assert.equal(mgr.room, "MGR");
});

test("report parsers fail instead of dropping unknown or duplicate rooms", () => {
  assert.throws(() => parserExports.parseRoomStatusReport("Room\tRoom Status\n?\tOccupied"), /room was not recognized/);
  assert.throws(() => parserExports.parseRoomStatusReport("Room\tRoom Status\n316\tOccupied\n316\tVacant"), /more than once/);
  assert.throws(() => parserExports.parseExpectedDepartures("Guest\tCheckout Time\nCasey\t11 AM"), /missing a Room column/);
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

test("room-operations uploads are manual, limited to retained dates, and preserve MGR", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const sql = readFileSync(new URL("../supabase/cmpri_v1_0_room_operations.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations_archive/20260930040000_cmpri_daily_room_operations.sql", import.meta.url), "utf8");
  assert.match(api, /\["paste", "file"\]/);
  assert.match(api, /isRetainedDate\(reportDate\)/);
  assert.match(api, /roomValue/);
  assert.match(api, /room !== "MGR" && !knownRooms\.has\(room\)/);
  assert.match(api, /\\d\{2,4\}\|MGR/);
  assert.match(api, /"11:00 AM"/);
  assert.match(api, /if \(date !== today\)[\s\S]*move_from: "", move_to: ""/);
  assert.match(api, /detectRoomMoves\(yesterdayRows \|\| \[\], data \|\| \[\]\)/);
  assert.doesNotMatch(api, /cmpri_room_operation_imports/);
  assert.match(api, /auth\.admin\.rpc\("cmpri_replace_room_operations"/);
  assert.match(api, /roomOperationsNotification/);
  assert.match(api, /guest_code: typeof row\.guest_code === "string" \? row\.guest_code : ""/);
  assert.match(api, /\.select\("room, guest_name, guest_code, move_from, move_to"\)/);
  assert.match(api, /notification_key: notification\.id/);
  assert.match(api, /target_path: notification\.target_path/);
  assert.match(sql, /report_date < timezone\('America\/Chicago', now\(\)\)::date - 1/);
  assert.match(sql, /report_date = p_report_date/);
  assert.match(sql, /p_source_type not in \('paste', 'file'\)/);
  assert.match(migration, /p_source_type not in \('paste', 'file'\)/);
  assert.match(migration, /delete from public\.cmpri_room_operation_imports[\s\S]*report_date < timezone\('America\/Chicago', now\(\)\)::date - 1/);
  assert.match(migration, /create or replace function public\.cmpri_replace_room_operations/);
  assert.match(migration, /p_report_date not between/);
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
  assert.match(commit, /rows: preview\.rows/);
  assert.match(commit, /report_date: preview\.date/);
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
});

test("room imports reject incomplete room/status snapshots and image uploads preflight before saving", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const importer = importerSource;
  assert.match(api, /const missingRooms = \[\.\.\.knownRooms\]\.filter/);
  assert.match(api, /const missingStatuses = rows\.filter/);
  assert.match(api, /status: 422/);
  assert.match(api, /Nothing was saved/);
  assert.match(importer, /validate_only: true/);
  assert.match(importer, /rows: validationPayload\.rows/);
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
  assert.match(createRoute, /room_status: currentRoomStatus/);
  assert.match(workOrdersRoute, /room_status: currentRoomStatus/);
  assert.match(selector, /roomStatusBadge\(order\.room_status\)/);
});

test("room operations do not show move or out-of-order event bubbles", () => {
  const page = readFileSync(new URL("../src/app/engineering/room-operations/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Moves: \{summary\.moves\}/);
  assert.doesNotMatch(page, /\["moves", "Moves"/);
  assert.doesNotMatch(page, /\["outOfOrder", "Out of Order"/);
  assert.doesNotMatch(page, /rounded-full[^>]*>Move \{/);
  assert.match(page, /isOutOfOrder\(row\.room_status\)[\s\S]*text-red-200/);
});

test("work-order room context reads today's checkout time from the room snapshot", () => {
  const page = readFileSync(new URL("../src/app/work-orders/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /fetch\("\/api\/room-operations", \{ headers, cache: "no-store" \}\)/);
  assert.match(page, /item\.room \|\| ""\)\.trim\(\)\.toUpperCase\(\) === room\.toUpperCase\(\)/);
  assert.match(page, /Today(?:&apos;|')s checkout time/);
  assert.match(page, /checkoutTime = String\(roomOperation\?\.checkout_time \|\| ""\)/);
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
  assert.match(extractRoute, /requireCapability\(request, "edit_tickets"\)/);
  assert.match(extractRoute, /OPENAI_API_KEY/);
  assert.match(extractRoute, /api\.openai\.com\/v1\/chat\/completions/);
  assert.match(extractRoute, /image_url/);
  assert.match(extractRoute, /gpt-4o/);
  assert.match(extractRoute, /Room,Room Status,Guest Name,Room Type,LOS,Reserved/);
});

test("room-operations importer supports direct image upload and auto-import with ChatGPT", () => {
  const importer = readFileSync(new URL("../src/app/engineering/room-operations/RoomOperationsImport.tsx", import.meta.url), "utf8");
  assert.match(importer, /handleImageUpload/);
  assert.match(importer, /\/api\/room-operations\/extract/);
  assert.match(importer, /accept="\.csv,\.tsv,\.txt,image\/\*,\.pdf"/);
  assert.match(importer, /Upload RoomStatus Images/);
});
