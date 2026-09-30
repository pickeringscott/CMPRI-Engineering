import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { resolvePrincipal, type Permission, type Principal, allows } from "@/lib/server/access";
import { HOTEL_ID } from "@/lib/constants";
import { canReadEquipment, roleKey } from "@/lib/server/roles";
import { assistantPolicy } from "@/lib/ai/assistant-policy";
import { CMPRI_MCP_RESOURCE, CMPRI_MCP_WRITE_SCOPE, validMcpScope } from "@/lib/server/cmpri-mcp-oauth-scope";

export type McpIdentity = {
  admin: SupabaseClient;
  principal: Principal;
  readAllWorkOrders: boolean;
  readAssignedWorkOrders: boolean;
  readOwnWorkOrders: boolean;
  readEquipment: boolean;
  canWrite: boolean;
};

async function hashToken(token: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function isMutatingMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export async function mcpIdentity(authorization: string | null): Promise<McpIdentity | null> {
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!bearer) return null;
  const admin = createSupabaseAdmin();
  if (!admin) throw new Error("CMPRI database access is unavailable.");

  const tokenHash = await hashToken(bearer);
  const [{ data: oauthToken, error: oauthError }, { data: personalToken, error: personalError }] = await Promise.all([
    admin.from("cmpri_mcp_oauth_tokens")
    .select("user_id, scope, expires_at, resource")
    .eq("token_hash", tokenHash)
    .eq("token_type", "access_token")
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle(),
    admin.from("cmpri_personal_mcp_links")
      .select("user_id, scope, expires_at, resource")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
  ]);
  if (oauthError || personalError) throw new Error("CMPRI could not verify the AI connection.");
  const token = personalToken || oauthToken;
  if (!token || !validMcpScope(token.scope) || token.resource !== CMPRI_MCP_RESOURCE) return null;

  const [{ data: userResult, error: userError }, { data: profileRow, error: profileError }] = await Promise.all([
    admin.auth.admin.getUserById(token.user_id),
    admin.from("profiles")
      .select("id, email, full_name, role, active, property_scope")
      .eq("id", token.user_id)
      .maybeSingle(),
  ]);
  if (userError || !userResult.user || profileError || !profileRow) return null;
  if (!userResult.user.email || !profileRow.email
    || userResult.user.email.trim().toLowerCase() !== profileRow.email.trim().toLowerCase()
    || profileRow.active !== true) return null;

  const { data: membershipRow, error: membershipError } = await admin.from("hotel_members")
    .select("user_id, hotel_id, role, active")
    .eq("user_id", token.user_id)
    .eq("hotel_id", HOTEL_ID)
    .maybeSingle();
  if (membershipError || !membershipRow || membershipRow.active !== true) return null;

  let permissions: Permission[] = [];
  if (roleKey(profileRow.role) !== "system_admin") {
    const { data, error } = await admin.from("role_permissions").select("role, permission, allowed");
    if (error) throw new Error("CMPRI could not verify the account permissions.");
    permissions = (data || []) as Permission[];
  }
  const principal = resolvePrincipal(
    { id: userResult.user.id, email: userResult.user.email },
    HOTEL_ID,
    profileRow,
    membershipRow,
    permissions,
  );
  if (!principal || (!allows(principal, "view_dashboard") && !allows(principal, "submit"))) return null;

  const policy = assistantPolicy({
    viewDashboard: allows(principal, "view_dashboard"),
    submit: allows(principal, "submit"),
    editTickets: allows(principal, "edit_tickets"),
    reviewTickets: allows(principal, "review_tickets"),
    manageAssets: allows(principal, "manage_assets"),
    operateIntegrations: allows(principal, "operate_integrations"),
  }, {
    canRead: canReadEquipment(profileRow.role),
    canEdit: false,
    assignedWorkOnly: roleKey(profileRow.role) === "technician",
  });

  return {
    admin,
    principal,
    readAllWorkOrders: policy.readAllWorkOrders,
    readAssignedWorkOrders: policy.readAssignedWorkOrders,
    readOwnWorkOrders: policy.readOwnWorkOrders,
    readEquipment: policy.readEquipment,
    canWrite: token.scope === CMPRI_MCP_WRITE_SCOPE,
  };
}
