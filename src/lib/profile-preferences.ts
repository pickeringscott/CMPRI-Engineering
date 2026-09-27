export type ProfilePreferences = {
  language: "en" | "es";
  appearance: "light" | "dark";
  notifications: {
    new_work_orders: boolean;
    status_changes: boolean;
    mentions: boolean;
  };
};

export const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  language: "en",
  appearance: "dark",
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
    notifications: {
      new_work_orders: notifications.new_work_orders !== false,
      status_changes: notifications.status_changes !== false,
      mentions: notifications.mentions !== false,
    },
  };
}
