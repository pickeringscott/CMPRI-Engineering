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
  id?: string;
  email?: string | null;
  role: unknown;
  secondary_roles?: readonly unknown[];
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WORK_ORDER_PUSH_ROLES = new Set([
  "chiefengineer", "systemadmin", "sysadmin", "systemadministrator", "administrator", "admin",
  "technician", "maintenancetechnician",
]);
const SCHEDULE_ROLES = new Set([
  "housekeeping", "leadhousekeeper", "executivehousekeeper",
  "engineer", "engineering", "chiefengineer", "engineeringmanager", "regionalmaintenance", "regionalengineer",
  "technician", "maintenancetechnician",
  "manager", "generalmanager", "gm",
  "frontdeskmanager",
  "assistantgm", "assistantgeneralmanager", "assistantmanager",
  "systemadmin", "sysadmin", "systemadministrator", "administrator", "admin",
]);

function profileRoleLabels(profile: WebPushEligibleProfile) {
  return [profile.role, ...(profile.secondary_roles || [])]
    .flatMap((role) => typeof role === "string"
      ? role.split(/\s*(?:\/|\+|,|&|\band\b)\s*/i)
      : [])
    .map((role) => role.trim().toLowerCase().replace(/[^a-z]/g, ""));
}

export function isWebPushEligibleProfile(profile: WebPushEligibleProfile) {
  return profileRoleLabels(profile).some((role) => WORK_ORDER_PUSH_ROLES.has(role));
}

export function isNotificationScheduleEligibleProfile(profile: WebPushEligibleProfile) {
  return profileRoleLabels(profile).some((role) => SCHEDULE_ROLES.has(role));
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

export function isStaffNotesPushEligibleProfile(profile: WebPushEligibleProfile) {
  const roles = profileRoleLabels(profile);
  return !roles.includes("frontdesk") && roles.some(role => SCHEDULE_ROLES.has(role));
}
