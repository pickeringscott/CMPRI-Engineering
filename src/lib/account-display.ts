const ROLE_LABELS: Record<string, string> = {
  engineer: "Engineer",
  chief_engineer: "Chief Engineer",
  engineering_manager: "Engineer",
  regional_maintenance: "Engineer",
  manager: "General Manager",
  general_manager: "General Manager",
  gm: "General Manager",
  senior_management: "Senior Management",
  technician: "Maintenance Technician",
  maintenance_technician: "Maintenance Technician",
  front_desk: "Front Desk",
  assistant_gm: "Assistant General Manager",
  assistant_general_manager: "Assistant General Manager",
  assistant_manager: "Assistant General Manager",
  sales_manager: "Front Desk",
  front_desk_manager: "Front Desk Manager",
  housekeeping: "Lead Housekeeper",
  lead_housekeeper: "Lead Housekeeper",
  executive_housekeeper: "Lead Housekeeper",
  system_admin: "System Administrator",
  system_administrator: "System Administrator",
};

export function roleDisplayName(value: string | readonly string[], secondaryRoles: readonly string[] = []) {
  const roles = Array.isArray(value) ? value : [value];
  const labels = [...roles, ...secondaryRoles].map((role) => {
    const normalized = role.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return ROLE_LABELS[normalized] || role;
  });
  return [...new Set(labels)].join(" + ");
}

export function dashboardTitleForRole(role: string) {
  return `${roleDisplayName(role)} Dashboard`;
}

export type AccountDisplayProfile = {
  email?: string | null;
  role?: string | null;
  secondary_roles?: readonly string[];
};

/** Verified account presentation only; never use this resolver for authorization. */
export function isMaintenanceChiefDisplay(profile: AccountDisplayProfile): boolean {
  return profile.email?.trim().toLowerCase() === "maint.cmpri@hawkeyehotels.com"
    && ["systemadmin", "systemadministrator", "administrator", "admin"].includes((profile.role || "").toLowerCase().replace(/[\s_-]+/g, ""))
    && profile.secondary_roles?.some(role => role.trim().toLowerCase() === "engineer") === true;
}

export function accountRoleDisplayName(profile: AccountDisplayProfile): string {
  return isMaintenanceChiefDisplay(profile)
    ? "Chief Engineer"
    : roleDisplayName(profile.role || "", profile.secondary_roles || []);
}
