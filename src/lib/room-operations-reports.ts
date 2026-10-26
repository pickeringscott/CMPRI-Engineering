export type PrintedReport = {
  printed_date: string;
  printed_time: string | null;
  source_filename?: string;
  timestamp_source?: "filename" | "printed";
  report_kind?: "pms_room_status" | "pms_in_house";
};

export type AcceptedReportVersion = PrintedReport & {
  fingerprint: string;
};

export type RoomCheckoutRecord = {
  checkout_date: string | null;
  checkout_time: string | null;
  room_status: string;
  guest_name: string;
  guest_code: string;
  room_type: string;
  guest_arrival_date: string | null;
  stay_nights: number;
  reserved: boolean;
  arrival_date: string | null;
  arrival_time: string | null;
};

export function hotelDateAt(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizePrintedDate(value: string) {
  const text = value.trim().replace(/^["']|["']$/g, "");
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const normalized = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    return validIsoDate(normalized) ? normalized : "";
  }
  const us = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (us) {
    const normalized = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    return validIsoDate(normalized) ? normalized : "";
  }
  const longDate = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longDate) {
    const month = new Date(`${longDate[1]} 1, 2000`).getMonth() + 1;
    const normalized = `${longDate[3]}-${String(month).padStart(2, "0")}-${longDate[2].padStart(2, "0")}`;
    return month && validIsoDate(normalized) ? normalized : "";
  }
  return "";
}

export function normalizePrintedTime(value: string | null | undefined) {
  const text = value?.trim() || "";
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || "0");
  const meridiem = match[4]?.toUpperCase();
  if (minutes > 59 || seconds > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) return null;
  if (meridiem) hours = (hours % 12) + (meridiem === "PM" ? 12 : 0);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function parsePrintedReport(raw: string, label: string): {
  report: PrintedReport | null;
  error: string | null;
} {
  const lines = raw.split(/\r?\n/);
  const dateLine = lines.find((line) => /\b(?:printed|print)\s*date\b|\bdate\s*printed\b/i.test(line));
  if (!dateLine) return { report: null, error: `${label} is missing its printed date.` };
  const dateValue = dateLine
    .replace(/^.*?\b(?:printed|print)\s*date\b|\bdate\s*printed\b/i, "")
    .replace(/^[\s:=,\t-]+/, "")
    .split(/[,\t]/)[0]
    .trim();
  const printedDate = normalizePrintedDate(dateValue);
  if (!printedDate) return { report: null, error: `${label} printed date is missing, invalid, or has no verifiable year.` };

  const timeLine = lines.find((line) => /\b(?:printed|print)\s*(?:generation\s*)?time\b|\bgeneration\s*time\b/i.test(line));
  if (!timeLine) return { report: { printed_date: printedDate, printed_time: null }, error: null };
  const rawTime = timeLine
    .replace(/^.*?\b(?:printed|print)\s*(?:generation\s*)?time\b|\bgeneration\s*time\b/i, "")
    .replace(/^[\s:=,\t-]+/, "")
    .split(/[,\t]/)[0]
    .trim();
  const printedTime = normalizePrintedTime(rawTime);
  if (!printedTime) return { report: null, error: `${label} printed generation time is present but cannot be verified.` };
  return { report: { printed_date: printedDate, printed_time: printedTime }, error: null };
}

export function reportReplacementError(
  label: string,
  incoming: PrintedReport | null,
  latest: AcceptedReportVersion | null,
  today: string,
  fingerprint: string,
) {
  if (!incoming) return `${label} printed date cannot be verified. Nothing was replaced.`;
  if (!validIsoDate(incoming.printed_date)) return `${label} printed date is invalid. Nothing was replaced.`;
  if (incoming.printed_date > today) {
    return `${label} is printed for ${incoming.printed_date}; future reports beyond the current hotel date ${today} cannot be imported. Nothing was replaced.`;
  }
  if (latest && latest.printed_date > incoming.printed_date) {
    return `${label} is older than the latest accepted source report (${latest.printed_date}). Nothing was replaced.`;
  }
  if (latest && latest.printed_date === incoming.printed_date) {
    if (latest.fingerprint === fingerprint) return null;
    if (!incoming.printed_time || !latest.printed_time) {
      return `${label} is another version from ${incoming.printed_date}, but its printed generation time cannot be compared with the latest accepted report. Nothing was replaced.`;
    }
    if (incoming.printed_time <= latest.printed_time) {
      return `${label} printed generation time ${incoming.printed_time} is not newer than the latest accepted version at ${latest.printed_time}. Nothing was replaced.`;
    }
  }
  return null;
}

export function checkoutDeadlinePassed(
  checkoutDate: string,
  checkoutTime: string,
  now: Date,
  timeZone: string,
) {
  if (!validIsoDate(checkoutDate)) return false;
  const time = normalizePrintedTime(checkoutTime);
  if (!time) return false;
  const [year, month, day] = checkoutDate.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const localTarget = Date.UTC(year, month - 1, day, hour, minute, second);
  let target = localTarget;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(target)).reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    const rendered = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    target += localTarget - rendered;
  }
  return now.getTime() >= target;
}

export function roomAfterScheduledCheckout<T extends RoomCheckoutRecord>(room: T) {
  return {
    ...room,
    room_status: "Vacant Dirty",
    guest_name: "",
    guest_code: "",
    room_type: "",
    guest_arrival_date: null,
    stay_nights: 0,
    checkout_date: null,
    checkout_time: null,
  };
}

export function canApplyScheduledCheckout(
  current: { import_id: string | null; checkout_date: string | null; checkout_time: string | null; room_status: string },
  expected: { import_id: string | null; checkout_date: string; checkout_time: string },
) {
  return current.import_id === expected.import_id
    && current.checkout_date === expected.checkout_date
    && normalizePrintedTime(current.checkout_time) === normalizePrintedTime(expected.checkout_time)
    && /\boccupied\b/i.test(current.room_status);
}

// These exports have no printed preamble. Only their exact, original export
// filenames establish the source timestamps (hotel local time, never upload time).
export function pmsFilenameReport(filename: string, kind: "pms_room_status" | "pms_in_house"): PrintedReport {
  const prefix = kind === "pms_room_status" ? "Room status" : "In House Guest List Details - AR";
  const match = filename.match(new RegExp(`^${prefix}_CMPRI_(\\d{4}-\\d{2}-\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})\\.csv$`, "i"));
  const time = match ? normalizePrintedTime(`${match[2]}:${match[3]}:${match[4]}`) : null;
  if (!match || !validIsoDate(match[1]) || !time) throw new Error(`${prefix}: original timestamped CMPRI CSV filename is required.`);
  return { printed_date: match[1], printed_time: time, source_filename: filename, timestamp_source: "filename", report_kind: kind };
}

function pmsTable(raw: string) {
  const records: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') {
      if (quoted && raw[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(cell.trim()); cell = "";
      if (char === "\n") { if (row.some(Boolean)) records.push(row); row = []; }
    } else cell += char;
  }
  if (quoted) throw new Error("PMS CSV has an unterminated quoted field.");
  row.push(cell.trim());
  if (row.some(Boolean)) records.push(row);
  const headers = (records.shift() || []).map(value => value.replace(/^\uFEFF/, "").toUpperCase());
  if (new Set(headers).size !== headers.length) throw new Error("PMS CSV has duplicate headers.");
  return { headers, rows: records.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`PMS CSV row ${index + 2} has ${cells.length} fields; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, col) => [header, cells[col]]));
  }) };
}

export function isPmsRoomStatus(raw: string) {
  const header = raw.trimStart().split(/\r?\n/, 1)[0];
  return /(?:^|,)"?INVENTORY STATUS"?(?:,|$)/i.test(header)
    && /(?:^|,)"?HK CONDITION"?(?:,|$)/i.test(header);
}

export function preparePmsReportPair(statusCsv: string, guestCsv: string, statusFilename: string, guestFilename: string) {
  const statusMeta = pmsFilenameReport(statusFilename, "pms_room_status");
  const guestMeta = pmsFilenameReport(guestFilename, "pms_in_house");
  if (statusMeta.printed_date !== guestMeta.printed_date) throw new Error("PMS reports must have the same export date.");
  const status = pmsTable(statusCsv), guests = pmsTable(guestCsv);
  for (const [table, required] of [[status, ["ROOM NUMBER", "INVENTORY STATUS", "HK CONDITION", "BLOCK STATUS", "ROOM TYPE", "NEXT RESERVATION DATE"]], [guests, ["ROOM NUMBER", "GUEST NAME", "ROOM TYPE", "ARRIVAL", "DEPARTURE", "NIGHTS"]]] as const) {
    for (const header of required) if (!table.headers.includes(header)) throw new Error(`PMS report is missing ${header}.`);
  }
  const byRoom = new Map<string, Record<string, string>>();
  const roomNumber = (value: string) => {
    if (!/^(?:\d{2,4}|MGR)$/.test(value)) throw new Error(`PMS room identifier '${value}' cannot be mapped.`);
    return value;
  };
  for (const guest of guests.rows) {
    const room = roomNumber(guest["ROOM NUMBER"]);
    if (byRoom.has(room)) throw new Error(`In House Guest List maps Room ${room} more than once.`);
    byRoom.set(room, guest);
  }
  const seen = new Set<string>();
  const rows = status.rows.map((source) => {
    const room = roomNumber(source["ROOM NUMBER"]);
    if (seen.has(room)) throw new Error(`Room Status maps Room ${room} more than once.`);
    seen.add(room);
    const guest = byRoom.get(room);
    const inventory = source["INVENTORY STATUS"], hk = source["HK CONDITION"], block = source["BLOCK STATUS"];
    const occupied = inventory === "OCC - Occupied";
    const vacant = inventory === "VAC - Vacant";
    if (!occupied && !vacant) throw new Error(`Room ${room}: unsupported inventory status '${inventory}'.`);
    if (occupied !== Boolean(guest)) throw new Error(`Room ${room}: occupancy conflicts between the two PMS exports. Obtain a matching report pair; nothing was replaced.`);
    const conditions: Record<string, string> = { "D - Dirty": "Dirty", "VReady - Vacant Ready": "Ready", "OC - Occupied Clean": "Clean", "VC - Vacant Clean": "Clean", "OI - Occupied Inspected": "Inspected", "VI - Vacant Inspected": "Inspected" };
    if (!conditions[hk]) throw new Error(`Room ${room}: unsupported HK condition '${hk}'.`);
    if (block && !/^(?:OOO|Out of Order|OOO - Out of Order)$/i.test(block)) throw new Error(`Room ${room}: unsupported block status '${block}'.`);
    if (block && occupied) throw new Error(`Room ${room}: occupied and out-of-order statuses conflict.`);
    const nextDate = source["NEXT RESERVATION DATE"];
    if (nextDate && !normalizePrintedDate(nextDate)) throw new Error(`Room ${room}: invalid next reservation date.`);
    if (guest) {
      for (const header of ["GUEST NAME", "ROOM TYPE", "ARRIVAL", "DEPARTURE", "NIGHTS"]) if (!guest[header] || guest[header] === "[UNREADABLE]") throw new Error(`Room ${room}: missing ${header} in In House Guest List.`);
      if (!/^\d+$/.test(guest.NIGHTS) || Number(guest.NIGHTS) > 3650) throw new Error(`Room ${room}: invalid NIGHTS.`);
      const arrival = normalizePrintedDate(guest.ARRIVAL), departure = normalizePrintedDate(guest.DEPARTURE);
      if (!arrival || !departure || arrival > statusMeta.printed_date || departure < statusMeta.printed_date || arrival > departure) throw new Error(`Room ${room}: invalid current guest stay dates.`);
    }
    const codes = ["GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE"].map(key => guest?.[key] || "").filter(Boolean);
    if (new Set(codes).size > 1) throw new Error(`Room ${room}: conflicting supplied guest codes.`);
    return {
      room, room_status: block ? "Out of Order" : `${occupied ? "Occupied" : "Vacant"} ${conditions[hk]}`,
      room_type: guest?.["ROOM TYPE"] || source["ROOM TYPE"], guest_name: guest?.["GUEST NAME"] || "",
      guest_code: codes[0] || "", guest_arrival_date: guest ? normalizePrintedDate(guest.ARRIVAL) : "",
      checkout_date: guest ? normalizePrintedDate(guest.DEPARTURE) : "", stay_nights: guest?.NIGHTS || 0,
      // A date alone does not establish an incoming guest or a complete reservation.
      next_reservation_date: nextDate ? normalizePrintedDate(nextDate) : "", source_page: "1",
      source_inventory_status: inventory, source_hk_condition: hk, source_block_status: block,
      source_room_type: source["ROOM TYPE"], source_reports: [statusMeta, guestMeta],
    };
  });
  for (const room of byRoom.keys()) if (!seen.has(room)) throw new Error(`In House Guest List Room ${room} is absent from Room Status.`);
  if (!rows.length) throw new Error("PMS Room Status contains no rooms.");
  return {
    room_status: { ...statusMeta, pages: [1], rows },
    expected_departures: { ...guestMeta, pages: [1], rows: rows.filter(row => row.guest_name).map(row => ({ room: row.room, checkout_date: row.checkout_date, source_report_kind: "pms_in_house" })) },
  };
}
