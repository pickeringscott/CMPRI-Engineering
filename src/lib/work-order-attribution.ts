import { isFrontDesk, isSubmitOnlyRole } from "@/lib/server/roles";

export function validFirstName(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]{0,79}$/u.test(value.trim());
}

export function workOrderAttribution(
  user: { id: string; email?: string },
  profile: { active?: boolean | null; role?: string | null; full_name?: string | null },
  staffName: unknown,
) {
  if (profile.active !== true) throw new Error("Your account is inactive. Sign in with an active account.");
  const frontDesk = isFrontDesk(profile.role);
  const submitOnly = isSubmitOnlyRole(profile.role);
  const name = typeof staffName === "string" ? staffName.trim() : "";
  if (frontDesk && !validFirstName(staffName)) {
    throw new Error("Enter your first name before submitting (up to 80 characters).");
  }
  return {
    created_by: user.id,
    creator_account_user_id: user.id,
    creator_name: frontDesk ? name : profile.full_name?.trim() || user.email || "Unknown User",
    submitted_by_name: frontDesk ? name : null,
    creator_source: submitOnly ? "department_pending_verification" : "signed_in_user",
    status: submitOnly ? "Pending Verification" : "Open",
  };
}
