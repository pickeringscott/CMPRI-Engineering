import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows, type AccessProfile, type Capability, type Membership } from "./access";
import { createSupabaseAdmin } from "./supabase-admin";

const authOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

function createBearerClient(url: string, key: string, token: string): SupabaseClient {
  return createClient(url, key, {
    ...authOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function extractBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

export type AuthAttempt =
  | { ok: true; principal: import("./access").Principal; admin: SupabaseClient }
  | { ok: false; reason: "env-missing" | "no-bearer" | "verify-failed" | "profile-missing" | "profile-inactive" | "membership-missing" | "membership-inactive" | "membership-error" | "profile-error" | "exception"; detail?: string };

async function attemptAuth(request: NextRequest): Promise<AuthAttempt> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { ok: false, reason: "env-missing" };
  const bearer = extractBearer(request.headers.get("authorization"));
  if (!bearer) return { ok: false, reason: "no-bearer" };

  const verifier = createClient(url, key, authOptions);
  const sessionClient = createBearerClient(url, key, bearer);
  const admin = createSupabaseAdmin();
  const lookup = admin ?? sessionClient;

  try {
    const { data: userData, error: verifyError } = await verifier.auth.getUser(bearer);
    if (verifyError || !userData.user) {
      return { ok: false, reason: "verify-failed", detail: verifyError?.message };
    }
    const userId = userData.user.id;
    const email = userData.user.email ?? null;

    const { data: profileRow, error: profileError } = await lookup
      .from("profiles")
      .select("id, full_name, role, active, property_scope")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) return { ok: false, reason: "profile-error", detail: profileError.message };
    if (!profileRow) return { ok: false, reason: "profile-missing" };
    const profile = profileRow as AccessProfile;
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

    const principal = {
      identity: { id: userId, email },
      profile,
      hotelId: HOTEL_ID,
      membership,
      permissions: [],
    };
    return { ok: true, principal, admin: admin ?? sessionClient };
  } catch (error) {
    return { ok: false, reason: "exception", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function requireUserAttempt(request: NextRequest): Promise<AuthAttempt> {
  return attemptAuth(request);
}

export async function requireUser(request: NextRequest) {
  const result = await attemptAuth(request);
  return result.ok ? { principal: result.principal, admin: result.admin } : null;
}

export async function requireCapability(request: NextRequest, capability: Capability) {
  const auth = await requireUser(request);
  if (!auth || !allows(auth.principal, capability)) return null;
  return auth;
}
