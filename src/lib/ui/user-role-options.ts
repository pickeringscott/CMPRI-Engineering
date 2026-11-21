import { profileRoleForStorage } from '@/lib/server/roles';

/** Presentation only: choices remain the exact assignment labels supplied by the server. */
export function uniqueUserRoleChoices(roles: readonly string[]): string[] {
  const seen = new Set<string>();
  return roles.filter(role => {
    const stored = profileRoleForStorage(role);
    const key = stored === 'unknown' ? role : stored;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve storage aliases without promoting a historical Engineer into Chief Engineer. */
export function userRoleChoice(currentRole: string | null | undefined, roles: readonly string[]): string {
  const current = currentRole || '';
  if (roles.includes(current)) return current;
  const stored = profileRoleForStorage(current);
  return stored === 'unknown' ? current : roles.find(role => profileRoleForStorage(role) === stored) || current;
}
