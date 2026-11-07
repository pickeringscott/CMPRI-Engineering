/// <reference types="node" />
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSessionStoragePolicy, SESSION_KEY } from "@/lib/auth/session-storage";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase/config";
import { installDeviceDataCache, clearDeviceDataCache } from "@/lib/data-cache/browser";

export const OAUTH_PENDING_KEY = "cmpri:auth:oauth-pending";

let client: SupabaseClient | undefined;
let policy: ReturnType<typeof createSessionStoragePolicy> | undefined;
let signingOut = false;
let cacheAuthWatch = false;

function sessionPolicy() {
  if (typeof window === "undefined") throw new Error("CMPRI browser sessions are available only in the browser.");
  policy ??= createSessionStoragePolicy(window.localStorage, window.sessionStorage);
  return policy;
}

export function remembersDevice() {
  return sessionPolicy().remembered();
}

export function setRememberOnDevice(value: boolean) {
  if (signingOut || policy?.revoked()) {
    // Keep the old client's adapter revoked if its logout completes late.
    client = undefined;
    policy = undefined;
  }
  sessionPolicy().setRemember(value);
  signingOut = false;
}

export function clearDeviceSessionStorage() {
  void clearDeviceDataCache();
  sessionPolicy().clear();
}

export function createClient() {
  installDeviceDataCache();
  client ??= createSupabaseClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storageKey: SESSION_KEY,
      storage: sessionPolicy().storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  if (!cacheAuthWatch && typeof client.auth.onAuthStateChange === 'function') {
    cacheAuthWatch = true;
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) queueMicrotask(() => { void clearDeviceDataCache(); });
    });
  }
  return client;
}

export async function signOutDevice() {
  signingOut = true;
  await clearDeviceDataCache();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Remote revocation is best effort; leaving this device must not wait
    // indefinitely for initialization, refresh, or the logout network request.
    await Promise.race([
      createClient().auth.signOut({ scope: "local" }),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, 3000); }),
    ]);
  } catch {
    // Local cleanup below is still required when the SDK rejects.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    try {
      window.sessionStorage.removeItem(OAUTH_PENDING_KEY);
    } finally {
      sessionPolicy().revoke();
    }
  }
}

/**
 * Returns a session with a valid (non-expired) access token, refreshing it
 * from Supabase when necessary. The Supabase SDK's getSession() returns
 * whatever is in storage — including expired tokens — without refreshing,
 * so every caller that needs a live token must go through here instead.
 */
export async function getValidSession() {
  if (signingOut || sessionPolicy().revoked()) return null;
  const supabase = createClient();
  const { data, error } = await supabase.auth.getSession();
  if (signingOut || sessionPolicy().revoked()) return null;
  if (error) throw error;
  if (!data.session) return null;

  const expiresAt = data.session.expires_at;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt && expiresAt - now < 60) {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (signingOut || sessionPolicy().revoked()) return null;
    if (refreshError) throw refreshError;
    return refreshed.session;
  }
  return data.session;
}
