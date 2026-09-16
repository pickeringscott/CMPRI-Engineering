/**
 * CMPRI capability policy.
 *
 * - Engineer: technical control. Chief/Regional titles normalize here.
 * - Manager: management review/approval and subordinate account control, but no technical editing.
 * - Technician: technical work-order/equipment access, but no user management.
 * - Front Desk / Housekeeping: submit-only roles.
 * - Senior Management: read-only oversight.
 * - system_admin: bootstrap/full-control role.
 *
 * Historical/retired titles remain in aliases so existing records continue to
 * resolve correctly, but only current titles are exposed for new assignments.
 */
export type CmpriRole =
  | "engineer"
  | "manager"
  | "senior_management"
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

  generalmanager: "manager",
  gm: "manager",

  seniormanagement: "senior_management",
  uppermanagement: "senior_management",
  vpfacilities: "senior_management",
  regionaldirectoroperations: "senior_management",
  districtmanager: "senior_management",

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
  engineer: [...TECHNICAL, "review_tickets", "reopen", "manage_users", "view_profiles"],
  manager: ["submit", "view_dashboard", "review_tickets", "manage_users", "view_profiles"],
  senior_management: ["view_dashboard", "view_profiles"],
  system_admin: [...TECHNICAL, "review_tickets", "reopen", "manage_users", "view_profiles"],
};

export function roleAllows(role: unknown, capability: Capability): boolean {
  return CAPABILITIES[roleKey(role)].includes(capability);
}

export const isFrontDesk = (role: unknown) => roleKey(role) === "front_desk";
export const isSubmitOnlyRole = (role: unknown) =>
  ["front_desk", "housekeeping"].includes(roleKey(role));
export const isReadOnlyRole = (role: unknown) => roleKey(role) === "senior_management";

/**
 * Equal roles cannot manage one another. Engineers and General Managers may
 * manage subordinate operational roles; system_admin is the only role that may
 * manage engineers/managers/senior-management accounts.
 */
export function canManageTargetRole(callerRole: unknown, targetRole: unknown): boolean {
  const caller = roleKey(callerRole);
  const target = roleKey(targetRole);
  if (target === "unknown" || target === "system_admin") return false;
  if (caller === "system_admin") return true;
  if (caller === "engineer") return ["technician", "front_desk", "housekeeping"].includes(target);
  if (caller === "manager") return ["technician", "front_desk", "housekeeping"].includes(target);
  return false;
}

export function canSuperviseDraftRole(callerRole: unknown, targetRole: unknown): boolean {
  const caller = roleKey(callerRole);
  const target = roleKey(targetRole);
  if (caller === "system_admin") return target !== "system_admin" && target !== "unknown";
  if (caller === "engineer" || caller === "manager") {
    return ["technician", "front_desk", "housekeeping"].includes(target);
  }
  return false;
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

/**
 * Titles currently available in User Management.
 *
 * Current list:
 * Chief Engineer, Engineering Manager, Regional Maintenance, General Manager,
 * Maintenance Technician, Front Desk, Assistant Manager, Sales Manager,
 * Lead Housekeeper.
 *
 * Retired/hidden titles remain in aliases above so historical records continue
 * to resolve safely without making those titles assignable to new users.
 */
export const ASSIGNABLE_ROLE_LABELS = [
  "Chief Engineer",
  "Engineering Manager",
  "Regional Maintenance",
  "General Manager",
  "Maintenance Technician",
  "Front Desk",
  "Assistant Manager",
  "Sales Manager",
  "Lead Housekeeper",
] as const;

const ENGINEER_TITLES = [
  "Chief Engineer",
  "Engineering Manager",
  "Regional Maintenance",
];

const MANAGER_TITLES = ["General Manager"];

const SENIOR_TITLES: string[] = [];

const TECHNICIAN_TITLES = ["Maintenance Technician"];

const FRONT_DESK_TITLES = [
  "Front Desk",
  "Assistant Manager",
  "Sales Manager",
];

const HOUSEKEEPING_TITLES = ["Lead Housekeeper"];

const ALL_MANAGEABLE_TITLES = [
  ...ENGINEER_TITLES,
  ...MANAGER_TITLES,
  ...SENIOR_TITLES,
  ...TECHNICIAN_TITLES,
  ...FRONT_DESK_TITLES,
  ...HOUSEKEEPING_TITLES,
];

export function assignableRoleLabels(callerRole: unknown): string[] {
  const caller = roleKey(callerRole);
  if (caller === "system_admin") return ALL_MANAGEABLE_TITLES;
  if (caller === "engineer" || caller === "manager") {
    return [...TECHNICIAN_TITLES, ...FRONT_DESK_TITLES, ...HOUSEKEEPING_TITLES];
  }
  return [];
}

export function roleDisplayTitle(role: string | null | undefined): string {
  if (!role) return "Unknown";
  return role;
}

export function membershipRole(role: unknown): "admin" | "manager" | "technician" | "viewer" {
  switch (roleKey(role)) {
    case "system_admin":
    case "engineer":
      return "admin";
    case "manager":
      return "manager";
    case "technician":
      return "technician";
    default:
      return "viewer";
  }
}

export function landingPath(role: unknown): "/work-orders" | "/engineering" | null {
  const key = roleKey(role);
  if (key === "unknown") return null;
  return ["front_desk", "housekeeping"].includes(key) ? "/work-orders" : "/engineering";
}
