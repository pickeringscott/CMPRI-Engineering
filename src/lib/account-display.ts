const ROLE_LABELS: Record<string, string> = {
  engineer: "Engineer",
  chief_engineer: "Engineer",
  engineering_manager: "Engineer",
  regional_maintenance: "Engineer",
  manager: "General Manager",
  general_manager: "General Manager",
  gm: "General Manager",
  senior_management: "Senior Management",
  technician: "Maintenance Technician",
  maintenance_technician: "Maintenance Technician",
  front_desk: "Front Desk",
  assistant_gm: "Front Desk",
  assistant_manager: "Front Desk",
  sales_manager: "Front Desk",
  housekeeping: "Lead Housekeeper",
  lead_housekeeper: "Lead Housekeeper",
  executive_housekeeper: "Lead Housekeeper",
  system_admin: "System Administrator",
  system_administrator: "System Administrator",
};

export function roleDisplayName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ROLE_LABELS[normalized] || value;
}

export function dashboardTitleForRole(role: string) {
  return `${roleDisplayName(role)} Dashboard`;
}