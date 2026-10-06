export type NotificationDay = {
  enabled: boolean;
  start: string;
  end: string;
};

export type NotificationSchedule = Record<
  "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday",
  NotificationDay
>;

export type PhoneNotificationSettings = {
  timezone: string;
  schedule: NotificationSchedule;
};

export type WebPushEligibleProfile = {
  role: unknown;
  secondary_roles?: readonly unknown[];
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ELIGIBLE_ROLE_NAMES = new Set(["chiefengineer", "maintenancetechnician"]);
const NON_ELIGIBLE_ENGINEERING_TITLES = new Set(["engineeringmanager", "regionalmaintenance", "regionalengineer"]);

function normalizedRoleLabels(value: unknown) {
  if (typeof value !== "string") return [];
  return value.split(/\s*(?:\/|\+|,|&|\band\b)\s*/i)
    .map((label) => label.trim().toLowerCase().replace(/[^a-z]/g, ""));
}

export function isWebPushEligibleProfile(profile: WebPushEligibleProfile) {
  const allRoles = [profile.role, ...(profile.secondary_roles || [])].flatMap(normalizedRoleLabels);
  if (allRoles.some((role) => ELIGIBLE_ROLE_NAMES.has(role))) return true;
  if (allRoles.some((role) => NON_ELIGIBLE_ENGINEERING_TITLES.has(role))) return false;
  const primaryRoles = normalizedRoleLabels(profile.role);
  return primaryRoles.includes("engineer") || primaryRoles.includes("technician");
}

export function defaultNotificationSchedule(): NotificationSchedule {
  return Object.fromEntries(WEEK_DAYS.map((day) => [day, { enabled: false, start: "09:00", end: "17:00" }])) as NotificationSchedule;
}

export function normalizeNotificationSettings(value: unknown): PhoneNotificationSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { timezone?: unknown; schedule?: unknown };
  if (typeof candidate.timezone !== "string" || !candidate.timezone.trim()) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate.timezone }).format();
  } catch {
    return null;
  }
  if (!candidate.schedule || typeof candidate.schedule !== "object" || Array.isArray(candidate.schedule)) return null;
  const schedule = {} as NotificationSchedule;
  for (const day of WEEK_DAYS) {
    const entry = (candidate.schedule as Record<string, unknown>)[day];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as { enabled?: unknown; start?: unknown; end?: unknown };
    if (typeof item.enabled !== "boolean" || typeof item.start !== "string" || typeof item.end !== "string"
      || !TIME_PATTERN.test(item.start) || !TIME_PATTERN.test(item.end)) return null;
    schedule[day] = { enabled: item.enabled, start: item.start, end: item.end };
  }
  return { timezone: candidate.timezone, schedule };
}

export function isWithinNotificationSchedule(settings: PhoneNotificationSettings, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: settings.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  const day = part("weekday").toLowerCase() as keyof NotificationSchedule;
  const currentMinute = Number(part("hour")) * 60 + Number(part("minute"));
  const today = settings.schedule[day];
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (today.enabled) {
    const start = minute(today.start);
    const end = minute(today.end);
    if (start === end || (start < end && currentMinute >= start && currentMinute < end)) return true;
    if (start > end && currentMinute >= start) return true;
  }
  const dayIndex = DAY_NAMES.indexOf(day);
  const previousDay = DAY_NAMES[(dayIndex + DAY_NAMES.length - 1) % DAY_NAMES.length] as keyof NotificationSchedule;
  const previous = settings.schedule[previousDay];
  return previous.enabled && minute(previous.start) > minute(previous.end) && currentMinute < minute(previous.end);
}
