import { isRecognizedChiefEngineer } from "./server/roles";

export type TimeFormat = "12h" | "24h";

export type ProfilePreferences = {
  language: "en" | "es";
  appearance: "light" | "dark";
  time_format?: TimeFormat;
  notification_mode: "in_app" | "email" | "both";
  notifications: {
    new_work_orders: boolean;
    status_changes: boolean;
    mentions: boolean;
  };
};

export const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  language: "en",
  appearance: "dark",
  notification_mode: "both",
  notifications: { new_work_orders: true, status_changes: true, mentions: true },
};

export function normalizeProfilePreferences(value: unknown): ProfilePreferences {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const notifications = source.notifications && typeof source.notifications === "object" && !Array.isArray(source.notifications)
    ? source.notifications as Record<string, unknown>
    : {};
  return {
    language: source.language === "es" ? "es" : "en",
    appearance: source.appearance === "light" ? "light" : "dark",
    ...(source.time_format === "12h" || source.time_format === "24h" ? { time_format: source.time_format } : {}),
    notification_mode: source.notification_mode === "in_app" || source.notification_mode === "email" || source.notification_mode === "both"
      ? source.notification_mode
      : "both",
    notifications: {
      new_work_orders: notifications.new_work_orders !== false,
      status_changes: notifications.status_changes !== false,
      mentions: notifications.mentions !== false,
    },
  };
}

export function resolveProfileTimeFormat(
  preferences: unknown,
  profile: Parameters<typeof isRecognizedChiefEngineer>[0],
): TimeFormat {
  return normalizeProfilePreferences(preferences).time_format ?? (isRecognizedChiefEngineer(profile) ? "24h" : "12h");
}

export function disableProfileNotifications(value: unknown): ProfilePreferences {
  const preferences = normalizeProfilePreferences(value);
  return {
    ...preferences,
    notification_mode: "in_app",
    notifications: { new_work_orders: false, status_changes: false, mentions: false },
  };
}
