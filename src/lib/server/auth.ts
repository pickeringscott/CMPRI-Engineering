import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase/config";
import { allows, type AccessProfile, type Capability, type Membership, type Permission } from "./access";
import { profileHasRole } from "./roles";
import { createSupabaseAdmin } from "./supabase-admin";
import { isMutatingMethod, mcpIdentity } from "./cmpri-mcp-auth";

const authOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

function createBearerClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    ...authOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function extractBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

function isInvalidApiKey(message: string) {
  return /invalid api key/i.test(message);
}

export type AuthAttempt =
  | { ok: true; principal: import("./access").Principal; admin: SupabaseClient; mcp: boolean }
  | { ok: false; reason: "no-bearer" | "verify-failed" | "email-mismatch" | "profile-missing" | "profile-inactive" | "membership-missing" | "membership-inactive" | "membership-error" | "profile-error" | "permission-error" | "exception"; detail?: string };

async function attemptAuth(request: NextRequest): Promise<AuthAttempt> {
  const bearer = extractBearer(request.headers.get("authorization"));
  if (!bearer) return { ok: false, reason: "no-bearer" };

  const verifier = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, authOptions);
  const sessionClient = createBearerClient(bearer);
  const admin = createSupabaseAdmin();
  let lookup = admin ?? sessionClient;

  try {
    if (bearer.startsWith("cmpri_mcp_")) {
      const mcp = await mcpIdentity(request.headers.get("authorization"));
      if (!mcp) return { ok: false, reason: "verify-failed" };
      if (isMutatingMethod(request.method) && !mcp.canWrite) {
        return { ok: false, reason: "verify-failed", detail: "This ChatGPT connection is read-only." };
      }
      return { ok: true, principal: mcp.principal, admin: mcp.admin, mcp: true };
    }
    const { data: userData, error: verifyError } = await verifier.auth.getUser(bearer);
    if (verifyError || !userData.user) {
      const mcp = await mcpIdentity(request.headers.get("authorization"));
      if (mcp) {
        if (isMutatingMethod(request.method) && !mcp.canWrite) {
          return { ok: false, reason: "verify-failed", detail: "This ChatGPT connection is read-only." };
        }
        return { ok: true, principal: mcp.principal, admin: mcp.admin, mcp: true };
      }
      return { ok: false, reason: "verify-failed", detail: verifyError?.message };
    }
    const userId = userData.user.id;
    const email = userData.user.email ?? null;

    let { data: profileRow, error: profileError } = await lookup
      .from("profiles")
      .select("id, email, full_name, role, secondary_roles, active, property_scope")
      .eq("id", userId)
      .maybeSingle();
    if (admin && profileError && isInvalidApiKey(profileError.message)) {
      console.error("Supabase admin key was rejected; retrying profile access with the authenticated user client.");
      lookup = sessionClient;
      ({ data: profileRow, error: profileError } = await lookup
        .from("profiles")
        .select("id, email, full_name, role, secondary_roles, active, property_scope")
        .eq("id", userId)
        .maybeSingle());
    }
    if (profileError) return { ok: false, reason: "profile-error", detail: profileError.message };
    if (!profileRow) return { ok: false, reason: "profile-missing" };
    const profile = profileRow as AccessProfile;
    if (!email || !profile.email || email.trim().toLowerCase() !== profile.email.trim().toLowerCase()) {
      return { ok: false, reason: "email-mismatch" };
    }
    if (profile.active !== true) return { ok: false, reason: "profile-inactive" };

    const { data: memberRow, error: memberError } = await lookup
      .from("hotel_members")
      .select("user_id, hotel_id, role, active")
      .eq("user_id", userId)
      .eq("hotel_id", HOTEL_ID)
      .maybeSingle();
    if (memberError) return { ok: false, reason: "membership-error", detail: memberError.message };
    if (!memberRow) return { ok: false, reason: "membership-missing" };
    const membership = memberRow as Membership;
    if (membership.active !== true) return { ok: false, reason: "membership-inactive" };

    let permissionRows: Permission[] = [];
    if (!profileHasRole(profile, "system_admin")) {
      const { data, error: permissionError } = await lookup
        .from("role_permissions")
        .select("role, permission, allowed");
      if (permissionError) return { ok: false, reason: "permission-error", detail: permissionError.message };
      permissionRows = (data ?? []) as Permission[];
    }

    const principal = {
      identity: { id: userId, email },
      profile,
      hotelId: HOTEL_ID,
      membership,
      permissions: permissionRows,
    };
    return { ok: true, principal, admin: lookup, mcp: false };
  } catch (error) {
    return { ok: false, reason: "exception", detail: error instanceof Error ? error.message : String(error) };
  }
}

const requestAuth = new WeakMap<NextRequest, Promise<AuthAttempt>>();
function verifiedRequest(request: NextRequest) {
  let pending = requestAuth.get(request);
  if (!pending) { pending = attemptAuth(request); requestAuth.set(request, pending); }
  return pending;
}

export async function requireUserAttempt(request: NextRequest): Promise<AuthAttempt> {
  return verifiedRequest(request);
}

export async function requireUser(request: NextRequest) {
  const result = await verifiedRequest(request);
  return result.ok ? { principal: result.principal, admin: result.admin } : null;
}

export async function requireCapability(request: NextRequest, capability: Capability) {
  const auth = await requireUser(request);
  if (!auth || !allows(auth.principal, capability)) return null;
  return auth;
}
