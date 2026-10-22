"use client";

import { getValidSession } from "@/lib/supabase/client";

export type CmpriClientSession = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    role: string;
    secondary_roles?: string[];
  };
  hotelId: string;
  landing: "/work-orders" | "/technician" | "/engineering" | "/front-desk";
  capabilities: string[];
};

export async function authorizationHeaders(): Promise<Record<string, string>> {
  const session = await getValidSession();
  if (!session?.access_token) throw new Error("Sign in again to continue.");
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function loadCmpriSession(): Promise<CmpriClientSession> {
  const headers = await authorizationHeaders();
  const response = await fetch("/api/session", { headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Your CMPRI session is no longer authorized.");
  return payload as CmpriClientSession;
}

export function hasCapability(session: CmpriClientSession | null | undefined, capability: string) {
  return Boolean(session?.capabilities?.includes(capability));
}
