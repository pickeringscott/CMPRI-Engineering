import { roleAllows, roleKey, type Capability } from "./roles";
export type { Capability } from "./roles";

export type AccessIdentity = { id: string; email: string | null };
export type AccessProfile = {
  id: string;
  role: string;
  active: boolean;
  full_name: string | null;
  property_scope?: string | null;
};
export type Membership = {
  user_id: string;
  hotel_id: string;
  active: boolean;
  role: string | null;
};
export type Permission = { role: string; permission: string; allowed: boolean };
export type Principal = {
  identity: AccessIdentity;
  profile: AccessProfile;
  hotelId: string;
  membership: Membership;
  permissions: readonly Permission[];
};

export type Lookup<T> = { data: T | null; error: unknown };
export type AuthSource = {
  verify: (token: string) => Promise<Lookup<AccessIdentity>>;
  profile: (id: string) => Promise<Lookup<AccessProfile>>;
  membership: (id: string, hotelId: string) => Promise<Lookup<Membership>>;
  permissions: (role: string) => Promise<Lookup<Permission[]>>;
};

function matchingGrants(principal: Principal, names: readonly string[]) {
  const role = roleKey(principal.profile.role);
  return principal.permissions.filter(
    (row) => roleKey(row.role) === role && names.includes(String(row.permission || "")),
  );
}

/** Missing grants fail closed. Conflicting rows also fail closed: an explicit deny beats an allow. */
export function hasAnyGrant(principal: Principal, names: readonly string[]): boolean {
  const rows = matchingGrants(principal, names);
  return rows.length > 0 && rows.some((row) => row.allowed === true) && !rows.some((row) => row.allowed === false);
}

export function resolvePrincipal(
  identity: AccessIdentity,
  hotelId: string,
  profile: AccessProfile | null,
  membership: Membership | null,
  permissions: readonly Permission[],
): Principal | null {
  if (!identity.id || !hotelId || !profile) return null;
  if (profile.active !== true) return null;
  if (!membership || membership.active !== true) return null;
  return { identity, profile, hotelId, membership, permissions };
}

const GRANTS: Partial<Record<Capability, readonly string[]>> = {
  edit_tickets: ["manage_work_orders", "edit_work_orders", "update_work_orders"],
  review_tickets: ["manage_work_orders", "approve_work_orders", "review_work_orders"],
  close_tickets: ["close_work_orders", "manage_work_orders"],
  reopen: ["close_work_orders", "manage_work_orders"],
  manage_assets: ["manage_assets"],
  manage_rooms: ["manage_assets", "manage_rooms"],
  manage_users: ["manage_users"],
  operate_integrations: ["manage_pm", "manage_integrations"],
};

/**
 * Submit and read-dashboard access are hard application policy for active property members.
 * Mutations beyond submission require both the named-role policy and a database grant.
 */
export function allows(principal: Principal, capability: Capability): boolean {
  if (principal.profile.active !== true || principal.membership.active !== true) return false;
  if (!roleAllows(principal.profile.role, capability)) return false;
  const required = GRANTS[capability];
  if (!required) return true;
  return principal.permissions.length === 0 ? true : hasAnyGrant(principal, required);
}

/** No access cache: every request rechecks identity, activation, exact-property membership and grants. */
export async function authenticate(
  authorization: string | null,
  hotelId: string,
  source: AuthSource,
): Promise<Principal | null> {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return null;
  try {
    const identity = await source.verify(match[1]);
    if (identity.error || !identity.data?.id) return null;
    const profile = await source.profile(identity.data.id);
    if (profile.error || !profile.data || profile.data.active !== true) return null;
    const membership = await source.membership(identity.data.id, hotelId);
    if (membership.error) return null;
    return resolvePrincipal(identity.data, hotelId, profile.data, membership.data, []);
  } catch {
    return null;
  }
}
