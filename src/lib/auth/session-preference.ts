import { clearDeviceSessionStorage, remembersDevice, setRememberOnDevice, getValidSession } from "@/lib/supabase/client";

/** Compatibility helpers retained for existing pages. The real persistence policy lives in the Supabase storage adapter. */
export function setSessionPreference(keepSignedIn: boolean) {
  setRememberOnDevice(keepSignedIn);
}

export function clearSessionPreference() {
  clearDeviceSessionStorage();
}

/**
 * Session persistence is enforced by choosing localStorage only when Remember on
 * this device is enabled; otherwise the Supabase session lives in sessionStorage.
 * Existing pages call this helper before loading, so it also rejects absent sessions.
 */
export async function enforceSessionPreference() {
  const session = await getValidSession();
  if (!session) return false;
  remembersDevice();
  return true;
}
