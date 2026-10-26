const roomIdentifier = {
  type: "string",
  description: "Exact active CMPRI room number, or MGR where applicable.",
  pattern: "^(?:\\d{2,4}|MGR)$",
};

const dateValue = {
  type: "string",
  description: "A date from the source report: YYYY-MM-DD, YYYY/M/D, M/D/YYYY (or M/D/YY), or compact DMon / DMonYY / DMonYYYY. Do not infer an unreadable date.",
};

const timeValue = {
  type: "string",
  description: "A time from the source report: H:MM, HH:MM, optional :SS, and optional AM/PM (for example 1:17 PM or 13:17). Use an empty string only when the source cell is blank or no time is printed; do not infer an unreadable time.",
  pattern: "^(?:|\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?)$",
};

const reservationValue = {
  anyOf: [
    { type: "boolean" },
    { type: "integer", minimum: 0 },
    { type: "string", enum: ["", "true", "false", "yes", "no", "y", "n", "1", "0", "reserved", "not reserved", "blk", "blocked", "unblocked", "x", "✓", "✔"] },
    { type: "string", pattern: "^\\d+$" },
  ],
  description: "Verified source indicator. Use true/false or a printed yes/no, reserved/blocked, or count value; omit when not shown.",
};

const roomStatusRowSchema = {
  type: "object",
  description: "One source-backed row for every room in Current Room Status, including vacant, occupied, blocked, OOO, and other out-of-order rooms. Do not add Expected Departures-only rooms.",
  properties: {
    room: roomIdentifier,
    room_status: { type: "string", minLength: 1, description: "Required exact occupancy/housekeeping/condition status as printed (for example Occupied, Vacant Ready, Vacant Dirty, Out of Order, or OOO)." },
    room_type: { type: "string", description: "Current room/guest Type field as printed." },
    guest_name: { type: "string", description: "Current guest Name field, not the incoming/block Name. Required for occupied rooms." },
    guest_code: { type: "string", description: "Optional current guest PP Code/Code field as printed. Preserve supplied RCNA; never invent a code or use PMS Guest Type or Room Type as a code." },
    guest_arrival_date: dateValue,
    checkout_date: { ...dateValue, description: "Current guest departure date. For a matching Expected Departures row, that report's checkout_date takes precedence." },
    checkout_time: { ...timeValue, description: "Explicit current guest checkout time. A matching Expected Departures checkout_time takes precedence. When checkout_date exists but neither report supplies a time, CMPRI stores 11:00 AM (11:00:00) and sets its generated checkout_time_explicit flag to false; a verified supplied time is marked explicit." },
    stay_nights: {
      anyOf: [
        { type: "integer", minimum: 0, maximum: 3650 },
        { type: "string", pattern: "^(?:|0|[1-9]\\d{0,2}|[1-2]\\d{3}|3[0-5]\\d{2}|36[0-4]\\d|3650)$" },
      ],
      description: "Current guest LOS. Required for occupied rooms.",
    },
    reserved: reservationValue,
    arrival_date: dateValue,
    arrival_time: timeValue,
    incoming_arrival_date: dateValue,
    incoming_arrival_time: timeValue,
    incoming_name: { type: "string", description: "Incoming/block Name from the columns to the right of Due In; never place this in guest_name. Required when a reservation is indicated." },
    incoming_type: { type: "string", description: "Incoming/block Type from the columns to the right of Due In." },
    incoming_code: { type: "string", description: "Incoming guest code, when printed." },
    incoming_block_indicator: { type: "string", description: "Exact incoming block/reservation indicator as printed." },
    incoming_reserved: reservationValue,
    move_from: { anyOf: [{ type: "string", enum: [""] }, roomIdentifier] },
    move_to: { anyOf: [{ type: "string", enum: [""] }, roomIdentifier] },
    source_page: {
      anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }],
      description: "Page number in the Room Status source, used to preserve source traceability.",
    },
  },
  required: ["room", "room_status"],
  allOf: [{
    if: {
      properties: { room_status: { pattern: "\\b[Oo][Cc][Cc][Uu][Pp][Ii][Ee][Dd]\\b" } },
      required: ["room_status"],
    },
    then: {
      required: ["guest_name", "room_type", "guest_arrival_date", "checkout_date", "stay_nights"],
      properties: {
        guest_name: { type: "string", minLength: 1 },
        room_type: { type: "string", minLength: 1 },
        guest_arrival_date: { type: "string", minLength: 1 },
        checkout_date: { type: "string", minLength: 1 },
        stay_nights: {
          anyOf: [
            { type: "integer", minimum: 0, maximum: 3650 },
            { type: "string", pattern: "^(?:0|[1-9]\\d{0,2}|[1-2]\\d{3}|3[0-5]\\d{2}|36[0-4]\\d|3650)$" },
          ],
        },
      },
    },
  }, {
    if: {
      anyOf: [
        { properties: { incoming_reserved: { const: true } }, required: ["incoming_reserved"] },
        { properties: { incoming_reserved: { type: "number", exclusiveMinimum: 0 } }, required: ["incoming_reserved"] },
        { properties: { incoming_reserved: { type: "string", pattern: "^(?:[1-9]\\d*|[Tt][Rr][Uu][Ee]|[Yy]|[Yy][Ee][Ss]|[Rr][Ee][Ss][Ee][Rr][Vv][Ee][Dd]|[Bb][Ll][Kk]|[Bb][Ll][Oo][Cc][Kk][Ee][Dd]|[Xx]|✓|✔)$" } }, required: ["incoming_reserved"] },
        { properties: { incoming_block_indicator: { type: "string", minLength: 1 } }, required: ["incoming_block_indicator"] },
        { properties: { incoming_name: { type: "string", minLength: 1 } }, required: ["incoming_name"] },
        { properties: { incoming_type: { type: "string", minLength: 1 } }, required: ["incoming_type"] },
        { properties: { incoming_code: { type: "string", minLength: 1 } }, required: ["incoming_code"] },
        { properties: { incoming_arrival_date: { type: "string", minLength: 1 } }, required: ["incoming_arrival_date"] },
        { properties: { incoming_arrival_time: { type: "string", minLength: 1 } }, required: ["incoming_arrival_time"] },
        { properties: { arrival_date: { type: "string", minLength: 1 } }, required: ["arrival_date"] },
        { properties: { arrival_time: { type: "string", minLength: 1 } }, required: ["arrival_time"] },
      ],
    },
    then: {
      required: ["incoming_name"],
      properties: { incoming_name: { type: "string", minLength: 1 } },
    },
  }],
  additionalProperties: false,
};

const expectedDepartureRowSchema = {
  type: "object",
  description: "A checkout row from Expected Departures. It is matched to, and merged into, the same room's Current Room Status row.",
  properties: {
    room: roomIdentifier,
    checkout_date: dateValue,
    checkout_time: timeValue,
    source_page: {
      anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }],
      description: "Page number in the Expected Departures source.",
    },
  },
  required: ["room"],
  additionalProperties: false,
};

const printedReportMetadata = {
  type: "object",
  properties: {
    printed_date: {
      type: "string",
      format: "date",
      description: "Required date visibly printed on this report, normalized to YYYY-MM-DD. For example, source text 10Oct26 becomes 2026-10-10. May be older than today if newer than stored source data; future dates are rejected.",
    },
    printed_time: {
      ...timeValue,
      description: "Exact printed generation time, if present, in H:MM AM/PM or 24-hour HH:MM[:SS] form. Required to replace a different accepted version for the same date; never substitute upload time.",
    },
    pages: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      minItems: 1,
      description: "Every page number represented by rows from this report. Include each source page.",
    },
  },
  required: ["printed_date", "pages"],
};

const reportDataSchema = {
  type: "object",
  description: "Normalized report evidence. The server validates all report metadata, rows, active-room coverage, and conditional guest/reservation requirements before saving.",
  properties: {
    room_status: {
      ...printedReportMetadata,
      description: "Current Room Status report. Its printed date is the authoritative report date.",
      properties: {
        ...printedReportMetadata.properties,
        rows: {
          type: "array",
          items: roomStatusRowSchema,
          minItems: 1,
          maxItems: 500,
          description: "Complete Current Room Status rows; occupied rooms require guest_name, room_type, guest_arrival_date, checkout_date, and stay_nights.",
        },
      },
      required: [...printedReportMetadata.required, "rows"],
      additionalProperties: false,
    },
    expected_departures: {
      anyOf: [
        {
          ...printedReportMetadata,
          description: "Optional Expected Departures report, matched to Current Room Status by room. Its printed date must match Current Room Status.",
          properties: {
            ...printedReportMetadata.properties,
            rows: { type: "array", items: expectedDepartureRowSchema },
          },
          required: [...printedReportMetadata.required, "rows"],
          additionalProperties: false,
        },
        { type: "null", description: "Use null when no Expected Departures report is supplied." },
      ],
    },
  },
  required: ["room_status"],
  additionalProperties: false,
};

const commonInputProperties = {
  status_filename: { type: "string", description: "Original Room status_CMPRI_YYYY-MM-DD_HH-MM-SS.csv filename, required for the new PMS pair." },
  departures_filename: { type: "string", description: "Original In House Guest List Details - AR_CMPRI_YYYY-MM-DD_HH-MM-SS.csv filename, required for the new PMS pair." },
  source: {
    type: "string",
    enum: ["paste", "file"],
    description: "Optional import provenance category. Defaults to file. This does not establish report freshness.",
  },
  report_date: {
    type: "string",
    format: "date",
    description: "Optional consistency check only: if supplied, must equal room_status.printed_date. It cannot replace or establish the printed report date.",
  },
  validate_only: {
    type: "boolean",
    description: "Optional true to validate and return the normalized rows without saving.",
  },
};

const csvHeaders = [
  "Canonical headers are Room; Room Status; Room Type; Guest Name; Guest Code; Guest Arrival Date; Checkout Date; Checkout Time; LOS; Reserved; Arrival Date; Arrival Time; Incoming Arrival Date; Incoming Arrival Time; Incoming Guest Name; Incoming Room Type; Incoming Guest Code; Incoming Block Indicator; Incoming Reserved; Move From; Move To; Source Page.",
  "All recognized header aliases (case-insensitive, whitespace-normalized, with substring matching for aliases at least four characters long): Room: ROOM, ROOM #, ROOM NUMBER, RM #, RM. Room status: ROOM STATUS, HOUSEKEEPING STATUS, HK STATUS, ROOM CONDITION, CONDITION, STATUS. Current guest name: GUEST NAME, GUEST / NAME, GUEST, NAME. Room type: ROOM TYPE, RM TYPE, ROOM TYPE CODE, TYPE. LOS: LOS, LENGTH OF STAY, NIGHTS. Current reservation: RESERVED, BLOCKED, BLK, BLK'D, BLK’D, BLKD. Checkout date: CHECKOUT DATE, CHECK OUT DATE, DEPARTURE DATE, DEP DATE, DEP. Checkout time: CHECKOUT TIME, CHECK OUT TIME, DEPARTURE TIME, DEP TIME, DPLM, TIME. Incoming arrival date: INCOMING ARRIVAL DATE (exact match), DUE IN, CHECKIN DATE, CHECK-IN DATE, ARRIVAL DATE. Incoming arrival time: INCOMING ARRIVAL TIME, CHECKIN TIME, CHECK-IN TIME, ARRIVAL TIME. Current guest code: GUEST CODE, GUEST TYPE CODE, RATE CODE, MEMBER CODE, CODE. Current guest arrival: CURRENT GUEST ARRIVAL DATE, GUEST ARRIVAL DATE, GUEST ARRIVAL, ARV DATE, ARV. Incoming name: INCOMING GUEST NAME, BLOCK NAME, INCOMING NAME. Incoming type: INCOMING ROOM TYPE, BLOCK TYPE, INCOMING TYPE. Incoming code: INCOMING GUEST CODE, BLOCK CODE, INCOMING CODE. Incoming block indicator: INCOMING BLOCK INDICATOR, BLOCK INDICATOR, RESERVATION INDICATOR. Incoming reservation: INCOMING RESERVED, INCOMING BLOCKED, INCOMING BLOCK, RESERVATION. Source page: SOURCE PAGE, PAGE. Move from: MOVE FROM, MOVED FROM, FROM ROOM. Move to: MOVE TO, MOVED TO, TO ROOM.",
  "Legacy CSVs require a printed-date line (Printed Date, Print Date, or Date Printed). Add a printed-time line (Printed Time, Print Time, Printed Generation Time, or Generation Time) when printed. Date line format must be YYYY-MM-DD, M/D/YYYY, or Month D, YYYY; normalize compact printed dates such as 10Oct26 to ISO (2026-10-10). New PMS Room status plus In House Guest List CSVs start with headers: submit the unmodified pair as status_csv/departures_csv with their original status_filename/departures_filename. Their filename timestamps establish provenance; do not fabricate printed preambles or guest codes.",
].join(" ");

const csvValue = {
  type: "string",
  minLength: 1,
  description: `${csvHeaders} The printed-date line must use YYYY-MM-DD, M/D/YYYY, or Month D, YYYY; for compact source dates such as 10Oct26, normalize to ISO (2026-10-10).`,
};

const inputOptions = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { ...commonInputProperties, ...properties },
  required,
  additionalProperties: false,
});

export const ROOM_OPERATIONS_IMPORT_INPUT_SCHEMA = {
  type: "object",
  description: "Complete input contract for room_operations.import. Supply exactly one input mode: normalized report_data, Current Room Status CSV (and optionally a separate Expected Departures CSV), or CSV aliases. For example, a printed timestamp 10Oct26 01:17 PM is supplied in report_data as printed_date 2026-10-10 and printed_time 01:17 PM. Preserve the actual printed date; older-than-today reports can replace older stored source data, including legacy snapshots. Future reports are rejected. Expected Departures must match the Room Status printed date. Different versions from the same date require a later verifiable printed time. Expected Departures is joined to Current Room Status by room; supplied Expected Departures checkout date/time takes precedence. If a matched Expected Departures row has no checkout date, the Room Status report date is used. Expected Departures-only rooms are ignored. Checkout defaults to 11:00 AM when no explicit time is available. The server creates source_import_id, source_report_date, source_uploaded_at, checkout_source_report_date, checkout_source_uploaded_at, and checkout_time_explicit; do not provide these. The complete snapshot and room coverage are validated before the single database replacement; failures leave the previously accepted snapshot unchanged.",
  oneOf: [
    inputOptions({
      report_data: reportDataSchema,
    }, ["report_data"]),
    inputOptions({
      status_csv: csvValue,
      departures_csv: { ...csvValue, description: `Optional separate Expected Departures CSV, or required In House Guest List CSV for the new PMS Room Status export. New PMS pairs use status_filename/departures_filename timestamps and explicit room-number joins. INVENTORY STATUS plus HK CONDITION establish status; ARRIVAL/DEPARTURE identify current stay. Guest Type, Room Type and Reservation Alias are never guest codes or reservation flags. Conflicts are rejected; next reservation date alone does not identify an incoming guest. ${csvHeaders}` },
    }, ["status_csv"]),
    inputOptions({
      csv: csvValue,
    }, ["csv"]),
    inputOptions({
      text: csvValue,
    }, ["text"]),
    inputOptions({
      content: csvValue,
    }, ["content"]),
    inputOptions({
      file: csvValue,
    }, ["file"]),

  ],
} as const;

export const ROOM_OPERATIONS_IMPORT_INSTRUCTIONS = "Read all supplied report photos in ChatGPT. Extract every source-backed field in input_schema into report_data, keeping current guest and incoming/block columns separate. Preserve printed dates/times and source pages; do not substitute today's date or upload time, invent unreadable values, or omit rooms. Ask for unresolved source details. Submit action room_operations.import with input {report_data, validate_only: true}; inspect validation errors and normalized rows, then save the identical data with validate_only omitted or false only when the user requested import. Validation is not a saved import. This connected route does not accept images or call server AI/OCR. After save success, read room_operations and verify the source date, count, OOO rooms and moves.";

export const ROOM_OPERATIONS_IMPORT_CONTRACT = {
  action: "room_operations.import",
  instructions: ROOM_OPERATIONS_IMPORT_INSTRUCTIONS,
  input_schema: ROOM_OPERATIONS_IMPORT_INPUT_SCHEMA,
} as const;
