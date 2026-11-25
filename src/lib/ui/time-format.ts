import type { TimeFormat } from "@/lib/profile-preferences";

export const TIME_FORMAT_MESSAGE = "cmpri-time-format-updated";
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

export function isTimeFormat(value: unknown): value is TimeFormat {
  return value === "12h" || value === "24h";
}

export function timeFormatOptions(format: TimeFormat) {
  return { hourCycle: format === "24h" ? "h23" : "h12" } as const;
}

/** Format a local clock value without moving it to another time zone. */
export function formatWallTime(value: string, format: TimeFormat, locale = "en-US"): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?$/i.exec(value.trim());
  if (!match) return value;

  const [, hours, minutes, seconds, period] = match;
  const hour = Number(hours);
  const minute = Number(minutes);
  const second = Number(seconds ?? "0");
  if (minute > 59 || second > 59 || (period ? hour < 1 || hour > 12 : hour > 23)) return value;

  const hourOfDay = period ? hour % 12 + (period.toLowerCase() === "p" ? 12 : 0) : hour;
  const key = [locale, format, Boolean(seconds)].join(":");
  let formatter = wallClockFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      hour: format === "24h" ? "2-digit" : "numeric",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      ...timeFormatOptions(format),
    });
    wallClockFormatters.set(key, formatter);
  }
  return formatter.format(new Date(Date.UTC(2000, 0, 1, hourOfDay, minute, second)));
}
