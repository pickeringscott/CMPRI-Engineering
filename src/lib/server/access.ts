import { membershipAllows, profileAllows, profileHasRole, profileIsChiefEngineer, roleKey, type Capability } from "./roles";
export type { Capability } from "./roles";

export type AccessIdentity = { id: string; email: string | null };
export type AccessProfile = {
  id: string;
  email: string | null;
  role: string;
  secondary_roles?: string[];
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
  return principal.permissions.filter(
    (row) => {
      const role = roleKey(row.role);
      return role !== "unknown"
        && profileHasRole(principal.profile, role)
        && names.includes(String(row.permission || ""));
    },
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

const CHIEF_ENGINEER_WORK_ORDER_CAPABILITIES: readonly Capability[] = [
  "view_work_orders",
  "add_work_order_notes",
  "edit_tickets",
  "review_tickets",
  "close_tickets",
  "reopen",
];

/**
 * Submit and read-dashboard access are hard application policy for active property members.
 * Other mutations require both the named-role policy and a database grant; Chief Engineer
 * work-order controls are granted directly by role.
 */
export function allows(principal: Principal, capability: Capability): boolean {
  if (principal.profile.active !== true || principal.membership.active !== true) return false;
  if (capability === "add_work_order_notes" && roleKey(principal.profile.role) === "unknown") return false;
  if (capability === "view_work_orders" || capability === "add_work_order_notes") {
    return Boolean(principal.identity.id && principal.hotelId
      && principal.profile.id === principal.identity.id
      && principal.membership.user_id === principal.identity.id
      && principal.membership.hotel_id === principal.hotelId);
  }
  if (profileIsChiefEngineer(principal.profile) && CHIEF_ENGINEER_WORK_ORDER_CAPABILITIES.includes(capability)) return true;
  if (!membershipAllows(principal.membership.role, capability)) return false;
  if (!profileAllows(principal.profile, capability)) return false;

  // The bootstrap system administrator is intentionally full-control and must not be
  // locked out by stale or missing permission rows in legacy databases.
  if (profileHasRole(principal.profile, "system_admin")) return true;

  const required = GRANTS[capability];
  if (!required) return true;
  return hasAnyGrant(principal, required);
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
