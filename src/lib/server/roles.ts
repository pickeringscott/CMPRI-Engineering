/**
 * CMPRI uses four flat capability levels with selectable display titles:
 *
 *   - Engineer level: full technical access + user management + ticket review.
 *     Selectable titles: Engineer, Chief Engineer, Engineering Manager,
 *     Regional Maintenance, Regional Engineer, General Manager, Senior Management,
 *     VP Facilities, Regional Director Operations, District Manager.
 *
 *   - Technician level: technical access to work orders, equipment, rooms, and
 *     integrations — but cannot manage users or review/approve tickets.
 *     Selectable titles: Maintenance Technician.
 *
 *   - Front Desk level: submit-only, can view profiles.
 *     Selectable titles: Front Desk, Assistant GM, Assistant Manager, Sales Manager.
 *
 *   - Housekeeping level: submit-only, can view profiles.
 *     Selectable titles: Housekeeping, Lead Housekeeper, Executive Housekeeper.
 *
 * system_admin is retained as an internal bootstrap role.
 *
 * Within each level, all titles share the same capabilities — the title is a display
 * label, not a hierarchy. Any engineer can manage technician, front desk, and
 * housekeeping accounts. Technicians can edit work orders but not manage users.
 */
export type CmpriRole =
  | "engineer"
  | "technician"
  | "front_desk"
  | "housekeeping"
  | "system_admin"
  | "unknown";

export type Capability =
  | "submit"
  | "view_dashboard"
  | "edit_tickets"
  | "review_tickets"
  | "close_tickets"
  | "reopen"
  | "manage_assets"
  | "manage_rooms"
  | "manage_users"
  | "view_profiles"
  | "operate_integrations";

const aliases: Readonly<Record<string, CmpriRole>> = {
  engineer: "engineer",
  engineers: "engineer",
  engineering: "engineer",
  chiefengineer: "engineer",
  engineeringmanager: "engineer",
  regionalmaintenance: "engineer",
  regionalengineer: "engineer",
  generalmanager: "engineer",
  gm: "engineer",
  seniormanagement: "engineer",
  uppermanagement: "engineer",
  vpfacilities: "engineer",
  regionaldirectoroperations: "engineer",
  districtmanager: "engineer",
  technician: "technician",
  maintenancetechnician: "technician",
  frontdesk: "front_desk",
  assistantgm: "front_desk",
  assistantgeneralmanager: "front_desk",
  assistantmanager: "front_desk",
  salesmanager: "front_desk",
  housekeeping: "housekeeping",
  leadhousekeeper: "housekeeping",
  executivehousekeeper: "housekeeping",
  systemadmin: "system_admin",
  systemadministrator: "system_admin",
  administrator: "system_admin",
  admin: "system_admin",
};

export function roleKey(value: unknown): CmpriRole {
  if (typeof value !== "string") return "unknown";
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return Object.hasOwn(aliases, key) ? aliases[key] : "unknown";
}

const TECHNICAL: readonly Capability[] = [
  "submit",
  "view_dashboard",
  "edit_tickets",
  "close_tickets",
  "manage_assets",
  "manage_rooms",
  "operate_integrations",
];

const CAPABILITIES: Readonly<Record<CmpriRole, readonly Capability[]>> = {
  unknown: [],
  front_desk: ["submit", "view_profiles"],
  housekeeping: ["submit", "view_profiles"],
  technician: TECHNICAL,
  engineer: [...TECHNICAL, "review_tickets", "reopen", "manage_users"],
  system_admin: [...TECHNICAL, "review_tickets", "reopen", "manage_users"],
};

export function roleAllows(role: unknown, capability: Capability): boolean {
  return CAPABILITIES[roleKey(role)].includes(capability);
}

export const isFrontDesk = (role: unknown) => roleKey(role) === "front_desk";
export const isSubmitOnlyRole = (role: unknown) =>
  ["front_desk", "housekeeping"].includes(roleKey(role));
export const isReadOnlyRole = () => false;

const MANAGEABLE_TARGETS: readonly CmpriRole[] = [
  "engineer",
  "technician",
  "front_desk",
  "housekeeping",
];

export function canManageTargetRole(callerRole: unknown, targetRole: unknown): boolean {
  const caller = roleKey(callerRole);
  const target = roleKey(targetRole);
  if (target === "system_admin") return false;
  if (caller === "system_admin") return true;
  return caller === "engineer" && MANAGEABLE_TARGETS.includes(target);
}

/** Draft supervision: engineers can act on any other engineer's, technician's, or submitter's drafts. */
export function canSuperviseDraftRole(callerRole: unknown, targetRole: unknown): boolean {
  return canManageTargetRole(callerRole, targetRole);
}

export function canChangeAccount(
  caller: { id: string; role: unknown },
  target: { id: string; role: unknown },
  proposedRole: unknown = target.role,
): boolean {
  return Boolean(caller.id && target.id && caller.id !== target.id)
    && canManageTargetRole(caller.role, target.role)
    && canManageTargetRole(caller.role, proposedRole);
}

export const ASSIGNABLE_ROLE_LABELS = [
  "Engineer",
  "Chief Engineer",
  "Engineering Manager",
  "Regional Maintenance",
  "Regional Engineer",
  "General Manager",
  "Senior Management",
  "VP Facilities",
  "Regional Director Operations",
  "District Manager",
  "Maintenance Technician",
  "Front Desk",
  "Assistant GM",
  "Assistant Manager",
  "Sales Manager",
  "Housekeeping",
  "Lead Housekeeper",
  "Executive Housekeeper",
] as const;

const ENGINEER_TITLES = [
  "Engineer",
  "Chief Engineer",
  "Engineering Manager",
  "Regional Maintenance",
  "Regional Engineer",
  "General Manager",
  "Senior Management",
  "VP Facilities",
  "Regional Director Operations",
  "District Manager",
];

const TECHNICIAN_TITLES = [
  "Maintenance Technician",
];

const FRONT_DESK_TITLES = [
  "Front Desk",
  "Assistant GM",
  "Assistant Manager",
  "Sales Manager",
];

const HOUSEKEEPING_TITLES = [
  "Housekeeping",
  "Lead Housekeeper",
  "Executive Housekeeper",
];

const ALL_MANAGEABLE_TITLES = [...ENGINEER_TITLES, ...TECHNICIAN_TITLES, ...FRONT_DESK_TITLES, ...HOUSEKEEPING_TITLES];

export function assignableRoleLabels(callerRole: unknown): string[] {
  const caller = roleKey(callerRole);
  if (caller !== "engineer" && caller !== "system_admin") return [];
  return ALL_MANAGEABLE_TITLES;
}

export function roleDisplayTitle(role: string | null | undefined): string {
  if (!role) return "Unknown";
  return ALL_MANAGEABLE_TITLES.includes(role) ? role : role;
}

export function landingPath(role: unknown): "/work-orders" | "/engineering" | null {
  const key = roleKey(role);
  if (key === "unknown") return null;
  return ["front_desk", "housekeeping"].includes(key) ? "/work-orders" : "/engineering";
}
