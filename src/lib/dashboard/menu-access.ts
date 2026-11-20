import { profileHasRole, roleKey, type CmpriRole } from "../server/roles";

type MenuProfile = { role: unknown; secondary_roles?: readonly unknown[] };
const CHIEF_MENU_ROLES = ["engineer", "senior_management", "system_admin"] as const;

function hasMenuRole(profile: MenuProfile, roles: readonly CmpriRole[]): boolean {
  return roles.some(role => profileHasRole(profile, role));
}

export function isChiefMenuRole(profile: MenuProfile): boolean {
  return hasMenuRole(profile, CHIEF_MENU_ROLES);
}

export function canOpenGss(profile: MenuProfile): boolean {
  return hasMenuRole(profile, [...CHIEF_MENU_ROLES, "manager", "assistant_manager", "front_desk_manager", "technician"]);
}

export function canOpenRoomOperations(profile: MenuProfile): boolean {
  return hasMenuRole(profile, [...CHIEF_MENU_ROLES, "manager", "technician"]);
}

export function canOpenEnseo(profile: MenuProfile): boolean {
  return hasMenuRole(profile, [...CHIEF_MENU_ROLES, "technician"]);
}

export function canOpenWeather(profile: MenuProfile): boolean {
  return roleKey(profile.role) !== "unknown";
}
