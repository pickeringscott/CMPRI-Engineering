import type { NextRequest } from "next/server";
import { requireUserAttempt } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { landingPath, type Capability } from "@/lib/server/roles";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Authorization",
};

const REASON_MESSAGES: Record<string, string> = {
  "env-missing": "CMPRI is not connected to its database. Please contact the administrator.",
  "no-bearer": "Your session was not sent to CMPRI. Please sign in again.",
  "verify-failed": "CMPRI could not verify your sign-in session. Please sign in again.",
  "profile-error": "CMPRI could not read your account profile.",
  "profile-missing": "Your CMPRI profile is missing. Please contact the administrator.",
  "profile-inactive": "Your CMPRI account is inactive. Please contact the administrator.",
  "membership-error": "CMPRI could not read your property membership.",
  "membership-missing": "Your account is not assigned to this property.",
  "membership-inactive": "Your property membership is inactive.",
  "permission-error": "CMPRI could not read your role permissions.",
  "exception": "CMPRI encountered an unexpected error while verifying access.",
};

export async function GET(request: NextRequest) {
  const attempt = await requireUserAttempt(request);
  if (!attempt.ok) {
    const base = REASON_MESSAGES[attempt.reason] ?? "This account is inactive, unavailable, or not authorized for CMPRI.";
    const suffix = attempt.detail ? ` (${attempt.reason}: ${attempt.detail})` : ` (${attempt.reason})`;
    const message = `${base}${suffix}`;
    return Response.json(
      { error: message, reason: attempt.reason, detail: attempt.detail },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  const capabilities: Capability[] = [
    "submit", "view_dashboard", "edit_tickets", "review_tickets", "close_tickets",
    "reopen", "manage_assets", "manage_rooms", "manage_users", "view_profiles", "operate_integrations",
  ];
  const landing = landingPath(attempt.principal.profile.role);
  if (!landing) {
    return Response.json({ error: "This account role is not recognized by CMPRI." }, { status: 403, headers: NO_STORE_HEADERS });
  }
  return Response.json({
    user: {
      id: attempt.principal.profile.id,
      name: attempt.principal.profile.full_name,
      email: attempt.principal.identity.email,
      role: attempt.principal.profile.role,
    },
    hotelId: attempt.principal.hotelId,
    landing,
    capabilities: capabilities.filter((capability) => allows(attempt.principal, capability)),
  }, { headers: NO_STORE_HEADERS });
}
