export type PrintedReport = {
  printed_date: string;
  printed_time: string | null;
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
  if (incoming.printed_date !== today) {
    return `${label} is printed for ${incoming.printed_date}; a new replacement requires a report printed for the current hotel date ${today}. Nothing was replaced.`;
  }
  if (latest && latest.printed_date > incoming.printed_date) {
    return `${label} is older than the latest accepted source report (${latest.printed_date}). Nothing was replaced.`;
  }
  if (latest && latest.printed_date === incoming.printed_date) {
    if (latest.fingerprint === fingerprint) return null;
    if (!incoming.printed_time || !latest.printed_time) {
      return `${label} is another version from ${today}, but its printed generation time cannot be compared with the latest accepted report. Nothing was replaced.`;
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
