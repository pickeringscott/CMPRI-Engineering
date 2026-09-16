/// <reference types="node" />
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSessionStoragePolicy, SESSION_KEY } from "@/lib/auth/session-storage";

const CMPRI_SUPABASE_URL = "https://uavotsoanubpowvyqaii.supabase.co";
const CMPRI_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_zk846u55k95wEKSqv5rVJA_ZIDwvRwx";

let client: SupabaseClient | undefined;
let policy: ReturnType<typeof createSessionStoragePolicy> | undefined;

function sessionPolicy() {
  if (typeof window === "undefined") throw new Error("CMPRI browser sessions are available only in the browser.");
  policy ??= createSessionStoragePolicy(window.localStorage, window.sessionStorage);
  return policy;
}

export function remembersDevice() {
  return sessionPolicy().remembered();
}

export function setRememberOnDevice(value: boolean) {
  sessionPolicy().setRemember(value);
}

export function clearDeviceSessionStorage() {
  sessionPolicy().clear();
}

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || CMPRI_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || CMPRI_SUPABASE_PUBLISHABLE_KEY;
  client ??= createSupabaseClient(url, key, {
    auth: {
      storageKey: SESSION_KEY,
      storage: sessionPolicy().storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

export async function signOutDevice() {
  const supabase = createClient();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } finally {
    clearDeviceSessionStorage();
  }
}

/**
 * Returns a session with a valid (non-expired) access token, refreshing it
 * from Supabase when necessary. The Supabase SDK's getSession() returns
 * whatever is in storage — including expired tokens — without refreshing,
 * so every caller that needs a live token must go through here instead.
 */
export async function getValidSession() {
  const supabase = createClient();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) return null;

  const expiresAt = data.session.expires_at;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt && expiresAt - now < 60) {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) throw refreshError;
    return refreshed.session;
  }
  return data.session;
}
