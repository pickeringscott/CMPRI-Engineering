import { profileHasRole } from "../server/roles";
import type { Principal } from "../server/access";

/** Senior Management gets the Chief menu's module reads, without edit grants. */
export function canReadChiefModules(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return profileHasRole(profile, "senior_management");
}

export function canReadChiefModuleData(principal: Principal): boolean {
  const { identity, profile, hotelId, membership } = principal;
  return Boolean(identity.id && hotelId && profile.active === true && membership.active === true
    && profile.id === identity.id && membership.user_id === identity.id
    && membership.hotel_id === hotelId && canReadChiefModules(profile));
}
