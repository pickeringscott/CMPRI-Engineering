import { isMaintenanceChiefDisplay } from "../account-display";
import { profileIsChiefEngineer } from "../server/roles";

/** Presentation only. Never use this account mapping for capabilities or authorization.
 * Verified maintenance profile: system_admin with secondary engineer; keep it intact.
 */
export function usesChiefEngineerMobileLayout(profile: {
  email?: string | null; role: string; secondary_roles?: readonly string[];
}) {
  return profileIsChiefEngineer(profile) || isMaintenanceChiefDisplay(profile);
}
