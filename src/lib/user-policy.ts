import {
  ASSIGNABLE_ROLE_LABELS,
  assignableRoleLabels,
  canManageTargetRole,
  roleAllows,
} from "@/lib/server/roles";

export const USER_ROLES = [...ASSIGNABLE_ROLE_LABELS];

export function canReadUsers(role: unknown) {
  return roleAllows(role, "manage_users") || roleAllows(role, "view_profiles");
}

export function canManageRole(callerRole: unknown, targetRole: unknown) {
  return canManageTargetRole(callerRole, targetRole);
}

export function assignableRoles(callerRole: unknown) {
  return assignableRoleLabels(callerRole);
}
