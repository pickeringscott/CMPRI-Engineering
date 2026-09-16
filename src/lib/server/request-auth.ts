import type { NextRequest } from "next/server";
import { requireUser } from "./auth";

/** Compatibility facade for routes that need authenticated server data. */
export async function authenticatedUser(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return null;
  return {
    principal: auth.principal,
    user: {
      id: auth.principal.identity.id,
      email: auth.principal.identity.email ?? undefined,
    },
    profile: auth.principal.profile,
    membership: auth.principal.membership,
    admin: auth.admin,
  };
}
