import { profileHasRole } from './server/roles';

type WinterProfile = { role: unknown; secondary_roles?: readonly unknown[] };

/** Checklist-specific access: does not grant access to any other Ops feature. */
export function canEditWinterPreparedness(profile: WinterProfile): boolean {
  return (['engineer', 'system_admin', 'manager', 'assistant_manager', 'front_desk_manager'] as const)
    .some(role => profileHasRole(profile, role));
}

export function canUseWinterPreparedness(profile: WinterProfile): boolean {
  return canEditWinterPreparedness(profile)
    || profileHasRole(profile, 'technician')
    || profileHasRole(profile, 'senior_management');
}
