export const EMPLOYMENT_REVIEWER_ID = "750f77bf-7d5d-4ca6-8421-e025edea87ba";
export function canReviewEmployment(identity: { id: string; email?: string | null }) {
  return identity.id === EMPLOYMENT_REVIEWER_ID && identity.email?.trim().toLowerCase() === "maint.cmpri@hawkeyehotels.com";
}
