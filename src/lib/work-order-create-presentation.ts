import { profileHasRole, roleAllows } from "./server/roles";

/** Presentation only: never grants submission or technical permissions. */
export function keepCreateFormOpen(profile: { role: unknown; secondary_roles?: readonly unknown[] }, canSubmit: boolean) {
  return canSubmit && roleAllows(profile.role, "submit")
    && !["engineer", "technician", "system_admin"].some((role) => profileHasRole(profile, role as "engineer" | "technician" | "system_admin"));
}
