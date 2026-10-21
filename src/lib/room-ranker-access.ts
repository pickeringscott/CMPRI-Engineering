import type { Principal } from "@/lib/server/access";
import { profileHasRole } from "@/lib/server/roles";

const SCOTT_ROOM_RANKER_EMAIL = "maint.cmpri@hawkeyehotels.com";

type RoomRankerProfile = {
  role: unknown;
  secondary_roles?: readonly unknown[];
  email?: string | null;
};

const ROOM_RANKER_VIEW_ROLES = [
  "front_desk_manager",
  "assistant_manager",
  "technician",
  "manager",
] as const;

export function isScottRoomRankerAccount(identityEmail: string | null, profileEmail: string | null | undefined) {
  return identityEmail?.trim().toLowerCase() === SCOTT_ROOM_RANKER_EMAIL
    && profileEmail?.trim().toLowerCase() === SCOTT_ROOM_RANKER_EMAIL;
}

export function roomRankerRoleCanView(profile: RoomRankerProfile) {
  return ROOM_RANKER_VIEW_ROLES.some((role) => profileHasRole(profile, role));
}

export function roomRankerProfileCanView(profile: RoomRankerProfile, _identityEmail: string | null) {
  // Keep existing callers compatible; legacy visibility is now role-based only.
  void _identityEmail;
  return profileHasRole(profile, "engineer");
}

export function canViewRoomRanker(principal: Principal) {
  return roomRankerProfileCanView(principal.profile, principal.identity.email);
}

export function canEditRoomRanker(principal: Principal) {
  return canViewRoomRanker(principal) && isScottRoomRankerAccount(principal.identity.email, principal.profile.email);
}

export function canAccessTroubleshootingGuides(profile: RoomRankerProfile) {
  if (profileHasRole(profile, "engineer") || profileHasRole(profile, "technician")) return false;
  return roomRankerRoleCanView(profile);
}
