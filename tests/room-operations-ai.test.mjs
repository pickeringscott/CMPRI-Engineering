import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { MAX_AI_ROOM_OPERATION_ROWS, validateAiRoomOperationsImport } from "../src/lib/ai/room-operations-import.ts";

const engineeringSource = readFileSync(new URL("../src/app/engineering/page.tsx", import.meta.url), "utf8");
const engineeringAst = ts.createSourceFile("engineering-page.tsx", engineeringSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const parserFunctions = ["normalizeHeader", "parseDelimitedLine", "parseRoomOperationsText"].map((name) => {
  const node = engineeringAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `${name} must be declared`);
  return node.getText(engineeringAst);
});
const parserExports = {};
vm.runInNewContext(ts.transpileModule(`${parserFunctions.join("\n")}\nexports.parseRoomOperationsText = parseRoomOperationsText;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: parserExports });
const parseExtractedTable = parserExports.parseRoomOperationsText;

const row = (room, overrides = {}) => ({
  room,
  checkout_date: "2026-09-26",
  checkout_time: "11:00 AM",
  room_status: "Vacant Dirty",
  arrival_date: "2026-09-26",
  arrival_time: "4:00 PM",
  move_from: "",
  move_to: "",
  room_type: "KING",
  guest_arrival_date: "2026-09-25",
  stay_nights: 2,
  reserved: false,
  ...overrides,
});

test("AI room-operations import requires an explicit valid report date", () => {
  assert.throws(() => validateAiRoomOperationsImport({ report_date: "", rows: [row("101")] }), /Report date must use YYYY-MM-DD/);
  assert.throws(() => validateAiRoomOperationsImport({ report_date: "2026-02-30", rows: [row("101")] }), /Report date must use YYYY-MM-DD/);
});

test("AI room-operations import normalizes rows and drops guest personal data", () => {
  const prepared = validateAiRoomOperationsImport({
    report_date: "2026-09-26",
    rows: [row("Room 101", { guest_name: "Private Guest", guest_code: "MEMBER123" })],
  });
  assert.equal(prepared.rows[0].room, "101");
  assert.equal(prepared.rows[0].reserved, false);
  assert.equal("guest_name" in prepared.rows[0], false);
  assert.equal("guest_code" in prepared.rows[0], false);
  assert.equal(prepared.rows[0].guest_arrival_date, "");
});

test("AI room-operations import rejects duplicates, malformed values, and oversized batches", () => {
  assert.throws(() => validateAiRoomOperationsImport({ report_date: "2026-09-26", rows: [row("101"), row("Room 101")] }), /appears more than once/);
  assert.throws(() => validateAiRoomOperationsImport({ report_date: "2026-09-26", rows: [row("101", { stay_nights: 5000 })] }), /stay nights is invalid/);
  assert.throws(() => validateAiRoomOperationsImport({ report_date: "2026-09-26", rows: Array.from({ length: MAX_AI_ROOM_OPERATION_ROWS + 1 }, (_, index) => row(String(index + 100))) }), /Prepare between/);
});

test("picture extraction stages validated rows and does not write before Commit", () => {
  const source = readFileSync(new URL("../src/app/engineering/page.tsx", import.meta.url), "utf8");
  const start = source.indexOf("async function handleRoomOpsImage");
  const end = source.indexOf("\n  useEffect(() => {", start);
  const photoHandler = source.slice(start, end);
  assert.match(photoHandler, /setRoomOpsInput\(extracted\)/);
  assert.match(photoHandler, /previewRoomOperationsText\(extracted, "photo"\)/);
  assert.doesNotMatch(photoHandler, /commitRoomOperationsImport/);
  assert.match(source, /function previewRoomOperationsText\(raw: string, source: RoomOperationImportSource\)/);
  assert.match(source, /prepareRoomOperationsImport\(parseRoomOperationsText\(raw\), source\)/);
});

test("validation-only request returns normalized rows before the existing RPC", () => {
  const route = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const validateBranch = route.indexOf("if (body.validate_only === true)");
  const rpcCall = route.indexOf("auth.admin.rpc(\"cmpri_replace_room_operations\"");
  assert.ok(validateBranch >= 0 && rpcCall > validateBranch);
  assert.match(route.slice(validateBranch, rpcCall), /return NextResponse\.json\(\{ ok: true, date: reportDate, count: rows\.length, rows \}/);
});

test("Commit uses only validated preview rows and reports success only after verified readback", () => {
  const source = readFileSync(new URL("../src/app/engineering/page.tsx", import.meta.url), "utf8");
  const start = source.indexOf("async function commitRoomOperationsImport");
  const end = source.indexOf("\n  async function handleRoomOpsFile", start);
  const commit = source.slice(start, end);
  assert.match(commit, /rows: roomOpsPreview\.rows/);
  assert.match(commit, /report_date: roomOpsPreview\.date/);
  assert.match(commit, /payload\.ok !== true \|\| !payload\.import_id/);
  assert.match(commit, /fetchRoomOperations\(roomOpsPreview\.date\)/);
  assert.match(commit, /saved\.rows\.length === roomOpsPreview\.rows\.length/);
  assert.match(commit, /actual\.guestCode === expected\.guest_code/);
  assert.match(commit, /actual\.reserved === expected\.reserved/);
  assert.ok(commit.indexOf("fetchRoomOperations(roomOpsPreview.date)") < commit.indexOf("were saved and verified"));
});

test("existing extraction parser preserves all recognized operational cells", () => {
  const extracted = [
    "Room\tCheckout Date\tCheckout Time\tRoom Status\tCheck-in Date\tCheck-in Time\tMove From\tMove To\tGuest Name\tRoom Type\tGuest Code\tARV\tLOS\tReserved",
    "316\t9/15/2026\t11:00 AM\tVacant Dirty\t9/15/2026\t4:00 PM\t316\t412\tGuest\tKING\tCODE\t9/12/2026\t3\tYes",
  ].join("\n");
  const [row] = parseExtractedTable(extracted);
  assert.equal(row.room, "316");
  assert.equal(row.checkoutDate, "9/15/2026");
  assert.equal(row.checkoutTime, "11:00 AM");
  assert.equal(row.roomStatus, "Vacant Dirty");
  assert.equal(row.arrivalDate, "9/15/2026");
  assert.equal(row.arrivalTime, "4:00 PM");
  assert.equal(row.moveFrom, "316");
  assert.equal(row.moveTo, "412");
  assert.equal(row.guestName, "Guest");
  assert.equal(row.roomType, "KING");
  assert.equal(row.guestCode, "CODE");
  assert.equal(row.guestArrivalDate, "9/12/2026");
  assert.equal(row.stayNights, 3);
  assert.equal(row.reserved, true);
});

test("extraction parser refuses to drop a row without a recognized room", () => {
  const extracted = "Room\tCheckout Date\tRoom Status\tLOS\tReserved\n316\t9/15/2026\tVacant Dirty\t3\tNo\n?\t9/15/2026\tVacant Ready\t2\tNo";
  assert.throws(() => parseExtractedTable(extracted), /Line 3: room number was not recognized\. No rows were discarded/);
});

test("extraction parser rejects ambiguous stay and reserved values", () => {
  const header = "Room\tLOS\tReserved";
  assert.throws(() => parseExtractedTable(`${header}\n316\tthree\tYes`), /Line 2: length of stay must be a whole number/);
  assert.throws(() => parseExtractedTable(`${header}\n316\t3\tmaybe`), /Line 2: reserved value 'maybe' is not recognized/);
  assert.throws(() => parseExtractedTable(`${header}\n316\t\tYes`), /Line 2: length of stay is blank/);
  assert.throws(() => parseExtractedTable(`${header}\n316\t3\t`), /Line 2: reserved value is blank/);
  assert.throws(() => parseExtractedTable("Room\tReserved\n316\tNo"), /missing a Length of Stay/);
  assert.throws(() => parseExtractedTable("Room\tLOS\n316\t3"), /missing a Reserved/);
});

test("room-operations API preserves existing source types and service-role RPC mapping", () => {
  const api = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  const sql = readFileSync(new URL("../supabase/cmpri_v1_0_room_operations.sql", import.meta.url), "utf8");
  assert.match(api, /\["paste", "file", "photo", "ai"\]/);
  assert.match(api, /auth\.admin\.rpc\("cmpri_replace_room_operations"/);
  for (const parameter of ["p_hotel_id", "p_report_date", "p_actor_id", "p_actor_name", "p_source_type", "p_rows"]) assert.match(api, new RegExp(`${parameter}:`));
  assert.match(sql, /p_source_type not in \('paste', 'file', 'photo'\)/);
  assert.match(sql, /grant execute on function public\.cmpri_replace_room_operations[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /'ai'/);
});