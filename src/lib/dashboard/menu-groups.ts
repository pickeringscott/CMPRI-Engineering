import { roleKey } from "../server/roles";

type MenuAction = { key: string; label: string };

export const WEATHER_MENU_PATH = "/previews/cmpri-weather-preview.html";
export const DASHBOARD_TAB_LABELS = ["Daily Work", "Rooms & Reports", "Safety & Logs", "Assets & Inventory", "Account", "Admin"] as const;
type DashboardTab = typeof DASHBOARD_TAB_LABELS[number];

const menuActions: Record<DashboardTab, readonly string[]> = {
  "Daily Work": ["work-order-list", "/engineering", "/technician", "/notepad", "/engineering/preventive-maintenance", "/engineering/employment"],
  "Rooms & Reports": ["/engineering/room-operations", "/engineering/room-ranking", "/engineering/gss", "/management/rooms", "/engineering/enseo-assignments"],
  "Safety & Logs": ["/engineering/pool-log", WEATHER_MENU_PATH, "/engineering/winter-preparedness"],
  "Assets & Inventory": ["/engineering/purchasing", "/engineering/parts", "/management/equipment"],
  "Account": ["/engineering/hours-tracker", "/profile", "sign-out"],
  "Admin": ["/management/users", "/feedback"],
};

const limitedActions: Partial<Record<DashboardTab, readonly string[]>> = {
  "Rooms & Reports": ["work-order-list", "/engineering/room-ranking"],
  "Safety & Logs": [WEATHER_MENU_PATH, "/notepad"],
  "Account": ["sign-out"],
};

export function usesThreeTabDashboard(role: unknown): boolean {
  const key = roleKey(role);
  return key === "front_desk" || key === "housekeeping";
}

/** Group only actions that the caller has already authorized. */
export function dashboardMenuGroups<T extends MenuAction>(
  role: unknown, actions: readonly T[], chiefMenu = false,
): Array<{ label: DashboardTab; items: T[]; centered: boolean }> {
  const key = roleKey(role);
  const limited = usesThreeTabDashboard(key);
  const tabs = DASHBOARD_TAB_LABELS.filter(tab =>
    limited ? Object.hasOwn(limitedActions, tab) : tab !== "Admin" || (key !== "manager" && key !== "technician"));
  return tabs.map(label => {
    const housekeepingAccount = key === "housekeeping" && label === "Account";
    const keys = housekeepingAccount ? ["/profile", "sign-out"] : limited ? limitedActions[label] ?? [] : menuActions[label];
    const items = keys.flatMap(href => actions.filter(action => action.key === href
      && (!housekeepingAccount || href !== "/profile" || action.label === "Manage Profile")));
    if (chiefMenu && label === "Account") {
      const profileIndex = items.findIndex(action => action.label === "Manage Profile");
      const hoursIndex = items.findIndex(action => action.key === "/engineering/hours-tracker");
      if (profileIndex >= 0 && hoursIndex >= 0 && hoursIndex < profileIndex) {
        const [hours] = items.splice(hoursIndex, 1);
        items.splice(profileIndex, 0, hours);
      }
    }
    return { label, items, centered: limited && label === "Account" };
  });
}
