import type { NextRequest } from "next/server";
import { canReadChiefModuleData } from "@/lib/dashboard/chief-module-access";
import { allows } from "./access";
import { requireUserAttempt } from "./auth";

type ChiefModuleCapability = "manage_assets" | "manage_users" | "review_feedback";

export async function requireChiefModuleRead(request: NextRequest, capability: ChiefModuleCapability) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok) return null;
  const canManage = allows(auth.principal, capability);
  if (!canManage && (auth.mcp || !canReadChiefModuleData(auth.principal))) return null;
  return { ...auth, canManage };
}
