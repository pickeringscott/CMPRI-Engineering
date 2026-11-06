/**
 * CMPRI capability policy.
 *
 * - Engineer: technical control. Chief/Regional titles normalize here.
 * - Manager: open-work-order notes, read-only PM oversight, and operational pool logging.
 * - Technician: technical work-order/equipment access, but no user management.
 * - Front Desk / Housekeeping: submit-only; manager variants can read active work orders, add notes, and log pools.
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
  | "front_desk_manager"
  | "assistant_manager"
  | "housekeeping"
  | "system_admin"
  | "unknown";

export type Capability =
  | "submit"
  | "view_dashboard"
  | "view_engineering_operations"
  | "view_pool_log"
  | "operate_pool_log"
  | "receive_pool_closed_notifications"
  | "view_work_orders"
  | "add_work_order_notes"
  | "view_pm"
  | "edit_tickets"
  | "review_tickets"
  | "close_tickets"
  | "reopen"
  | "manage_assets"
  | "manage_rooms"
  | "manage_users"
  | "submit_feedback"
  | "review_feedback"
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

  manager: "manager",
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
  assistantgm: "assistant_manager",
  assistantgeneralmanager: "assistant_manager",
  assistantmanager: "assistant_manager",
  salesmanager: "front_desk",
  frontdeskmanager: "front_desk_manager",

  housekeeping: "housekeeping",
  leadhousekeeper: "housekeeping",
  executivehousekeeper: "housekeeping",

  systemadmin: "system_admin",
  sysadmin: "system_admin",
  systemadministrator: "system_admin",
  administrator: "system_admin",
  admin: "system_admin",
};

export function roleKey(value: unknown): CmpriRole {
  if (typeof value !== "string") return "unknown";
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return Object.hasOwn(aliases, key) ? aliases[key] : "unknown";
}

/** Keep the trusted Chief Engineer assignment distinct from its capability family.
 * Call only after the existing account-management authorization checks.
 * Historical generic engineer assignments are never inferred to be Chief Engineer.
 */
export function profileRoleForStorage(value: unknown): CmpriRole | "chief_engineer" {
  if (typeof value === "string"
    && value.trim().toLowerCase().replace(/[\s_-]+/g, "") === "chiefengineer") {
    return "chief_engineer";
  }
  return roleKey(value);
}

export function profileHasRole(
  profile: { role: unknown; secondary_roles?: readonly unknown[] },
  role: CmpriRole,
): boolean {
  const assignedRoles = [profile.role, ...(profile.secondary_roles || [])];
  return assignedRoles.some((assignedRole) => typeof assignedRole === "string"
    && assignedRole.split(/\s*(?:\/|\+|,|&|\band\b)\s*/i).some((roleLabel) => roleKey(roleLabel) === role));
}

/** Pool-only manual closure/reopening permission; does not grant engineering modules. */
export function roleCanEditSavedPoolLog(role: unknown): boolean {
  return ["system_admin", "manager", "assistant_manager"].includes(roleKey(role));
}

export function profileCanReopenPool(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return profileHasRole(profile, "engineer") || profileHasRole(profile, "manager") || profileHasRole(profile, "assistant_manager");
}

export function profileIsChiefEngineer(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  const assignedRoles = [profile.role, ...(profile.secondary_roles || [])];
  return assignedRoles.some((assignedRole) => typeof assignedRole === "string"
    && assignedRole.split(/\s*(?:\/|\+|,|&|\band\b)\s*/i)
      .some((roleLabel) => roleLabel.trim().toLowerCase().replace(/[\s_-]+/g, "") === "chiefengineer"));
}

/** Eligibility never grants access to another person's hours document. */
type HoursProfile = { id?: string; email?: string | null; role: unknown; secondary_roles?: readonly unknown[] };
/** Existing verified legacy assignment; not a display-name or generic-engineer grant. */
export function profileIsEstablishedHoursChief(profile: HoursProfile): boolean {
  return profile.id === '750f77bf-7d5d-4ca6-8421-e025edea87ba'
    && profile.email?.trim().toLowerCase() === 'maint.cmpri@hawkeyehotels.com'
    && roleKey(profile.role) === 'system_admin'
    && profile.secondary_roles?.some(role => typeof role === 'string' && role.trim().toLowerCase() === 'engineer') === true;
}
export function profileCanUseHoursTracker(profile: HoursProfile): boolean {
  return profileIsChiefEngineer(profile)
    || profileIsEstablishedHoursChief(profile)
    || profileHasRole(profile, "assistant_manager")
    || profileHasRole(profile, "front_desk_manager")
    || profileHasRole(profile, "technician");
}

export function profileIsChiefEngineerOrSystemAdmin(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return profileIsChiefEngineer(profile) || profileHasRole(profile, "system_admin");
}

const TECHNICAL: readonly Capability[] = [
  "submit",
  "add_work_order_notes",
  "view_dashboard",
  "edit_tickets",
  "close_tickets",
  "manage_assets",
  "manage_rooms",
  "operate_integrations",
];

const TECHNICIAN: readonly Capability[] = [
  "submit",
  "add_work_order_notes",
  "view_dashboard",
  "edit_tickets",
  "close_tickets",
];

const CAPABILITIES: Readonly<Record<CmpriRole, readonly Capability[]>> = {
  unknown: [],
  front_desk: ["submit", "view_work_orders", "add_work_order_notes", "submit_feedback", "view_profiles"],
  front_desk_manager: ["submit", "view_pool_log", "operate_pool_log", "view_work_orders", "add_work_order_notes", "receive_pool_closed_notifications", "submit_feedback", "view_profiles"],
  assistant_manager: ["submit", "view_pool_log", "operate_pool_log", "view_work_orders", "add_work_order_notes", "receive_pool_closed_notifications", "submit_feedback", "view_profiles"],
  housekeeping: ["submit", "view_work_orders", "add_work_order_notes", "submit_feedback", "view_profiles"],
  technician: [...TECHNICIAN, "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "submit_feedback"],
  engineer: [...TECHNICAL, "view_engineering_operations", "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "submit_feedback", "review_feedback", "review_tickets", "reopen", "manage_users", "view_profiles"],
  manager: ["submit", "view_dashboard", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "view_work_orders", "add_work_order_notes", "view_pm", "view_profiles"],
  senior_management: ["submit_feedback", "view_dashboard", "view_engineering_operations", "view_work_orders", "add_work_order_notes", "view_pm", "view_profiles"],
  system_admin: [...TECHNICAL, "view_engineering_operations", "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "submit_feedback", "review_feedback", "review_tickets", "reopen", "manage_users", "view_profiles"],
};

export function roleAllows(role: unknown, capability: Capability): boolean {
  if (capability === "receive_pool_closed_notifications") return roleKey(role) !== "unknown";
  if (capability === "review_feedback") {
    if (typeof role !== "string") return false;
    const normalized = role.trim().toLowerCase().replace(/[^a-z]/g, "");
    return ["engineer", "chiefengineer", "systemadmin", "systemadministrator", "administrator", "admin"].includes(normalized);
  }
  return CAPABILITIES[roleKey(role)].includes(capability);
}

export function membershipAllows(role: unknown, capability: Capability): boolean {
  switch (typeof role === "string" ? role.trim().toLowerCase() : "") {
    case "admin":
      return true;
    case "manager":
      return ["submit", "view_dashboard", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "view_work_orders", "add_work_order_notes", "view_pm", "submit_feedback", "view_profiles"].includes(capability);
    case "technician":
      return ["submit", "view_dashboard", "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "add_work_order_notes", "edit_tickets", "close_tickets", "submit_feedback", "view_profiles"].includes(capability);
    case "viewer":
      return ["view_dashboard", "view_engineering_operations", "view_work_orders", "add_work_order_notes", "view_pm", "submit_feedback", "view_profiles"].includes(capability);
    default:
      return false;
  }
}

export function profileAllows(
  profile: { role: unknown; secondary_roles?: readonly unknown[] },
  capability: Capability,
): boolean {
  if (capability === "review_feedback") {
    return [profile.role, ...(profile.secondary_roles || [])].some((assignedRole) =>
      typeof assignedRole === "string"
      && assignedRole.split(/\s*(?:\/|\+|,|&|\band\b)\s*/i).some((label) => roleAllows(label, capability)));
  }
  return (Object.keys(CAPABILITIES) as CmpriRole[])
    .some((role) => profileHasRole(profile, role) && roleAllows(role, capability));
}

export function canReadEquipment(role: unknown): boolean {
  return ["engineer", "technician", "system_admin"].includes(roleKey(role));
}

export function canEditEquipment(role: unknown): boolean {
  return ["engineer", "system_admin"].includes(roleKey(role));
}

export const isFrontDesk = (role: unknown) => ["front_desk", "front_desk_manager", "assistant_manager"].includes(roleKey(role));
export const isSubmitOnlyRole = (role: unknown) =>
  ["front_desk", "housekeeping"].includes(roleKey(role));
export const isReadOnlyRole = (role: unknown) => roleKey(role) === "senior_management";

export function receivesOrdinaryWorkOrderNotifications(role: unknown): boolean {
  return ["engineer", "technician"].includes(roleKey(role));
}

export function receivesWorkOrderNotifications(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return profileIsChiefEngineerOrSystemAdmin(profile) || profileHasRole(profile, "technician");
}

export function receivesPoolClosedNotifications(profile: { role: unknown; secondary_roles?: readonly unknown[] }): boolean {
  return [profile.role, ...(profile.secondary_roles || [])].some(role => roleKey(role) !== 'unknown');
}

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
  if (caller === "engineer") return ["technician", "front_desk", "front_desk_manager", "assistant_manager", "housekeeping"].includes(target);
  if (caller === "manager") return ["technician", "front_desk", "front_desk_manager", "assistant_manager", "housekeeping"].includes(target);
  return false;
}

export function canManageTargetProfile(
  callerProfile: { role: unknown; secondary_roles?: readonly unknown[] },
  targetRole: unknown,
): boolean {
  return (Object.keys(CAPABILITIES) as CmpriRole[])
    .some((role) => profileHasRole(callerProfile, role) && canManageTargetRole(role, targetRole));
}

export function canSuperviseDraftRole(callerRole: unknown, targetRole: unknown): boolean {
  const caller = roleKey(callerRole);
  const target = roleKey(targetRole);
  if (caller === "system_admin") return target !== "system_admin" && target !== "unknown";
  if (caller === "engineer" || caller === "manager") {
    return ["technician", "front_desk", "front_desk_manager", "assistant_manager", "housekeeping"].includes(target);
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
 * Chief Engineer, General Manager,
 * Maintenance Technician, Front Desk, Assistant General Manager, Front Desk Manager,
 * Lead Housekeeper.
 * System Administrator remains a protected internal capability, not a business-role choice.
 *
 * Retired/hidden titles remain in aliases above so historical records continue
 * to resolve safely without making those titles assignable to new users.
 */
export const ASSIGNABLE_ROLE_LABELS = [
  "Chief Engineer",
  "General Manager",
  "Maintenance Technician",
  "Front Desk",
  "Assistant General Manager",
  "Front Desk Manager",
  "Lead Housekeeper",
] as const;

export function assignableRoleLabels(callerRole: unknown): string[] {
  return ASSIGNABLE_ROLE_LABELS.filter((label) => canManageTargetRole(callerRole, label));
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
    case "front_desk":
    case "front_desk_manager":
    case "assistant_manager":
    case "housekeeping":
      return "technician";
    default:
      return "viewer";
  }
}

export function landingPath(role: unknown): "/work-orders" | "/technician" | "/engineering" | "/front-desk" | null {
  const key = roleKey(role);
  if (key === "unknown") return null;
  if (key === "technician") return "/technician";
  if (key === "front_desk") return "/front-desk";
  return key === "housekeeping" ? "/work-orders" : "/engineering";
}
