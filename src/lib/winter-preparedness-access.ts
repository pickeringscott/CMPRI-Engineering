import { profileHasRole } from './server/roles';

/** Checklist-specific access: does not grant access to any other Ops feature. */
export function canUseWinterPreparedness(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return (['engineer', 'system_admin', 'manager', 'assistant_manager', 'front_desk_manager'] as const)
    .some(role => profileHasRole(profile, role));
}
