import type { Principal } from "../server/access";
import { isChiefMenuRole } from "./menu-access";

/** Chief menu roles can view these modules. The existing capabilities still govern edits. */
export function canReadChiefModules(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return isChiefMenuRole(profile);
}

export function canReadChiefModuleData(principal: Principal): boolean {
  const { identity, profile, hotelId, membership } = principal;
  return Boolean(identity.id && hotelId && profile.active === true && membership.active === true
    && profile.id === identity.id && membership.user_id === identity.id
    && membership.hotel_id === hotelId && canReadChiefModules(profile));
}
