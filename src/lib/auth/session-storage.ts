export type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const SESSION_KEY = "cmpri:auth:v1";
export const REMEMBER_KEY = "cmpri:remember";
const LOGOUT_GENERATION_KEY = "cmpri:auth:logout-generation";

const AUTH_KEYS = [SESSION_KEY, `${SESSION_KEY}-code-verifier`, `${SESSION_KEY}-user`];

export function createSessionStoragePolicy(persistent: StoragePort, temporary: StoragePort) {
  let signedOut = false;
  // sessionStorage is shared by this app window and its same-origin frames.
  // Keep the marker across reloads so old frame clients remain revoked.
  const generation = temporary.getItem(LOGOUT_GENERATION_KEY);
  const revoked = () => signedOut || temporary.getItem(LOGOUT_GENERATION_KEY) !== generation;
  const remembered = () => persistent.getItem(REMEMBER_KEY) === "true";
  const selected = () => (remembered() ? persistent : temporary);
  const other = () => (remembered() ? temporary : persistent);

  function clearAuth() {
    const failures: unknown[] = [];
    for (const store of [persistent, temporary]) {
      for (const key of AUTH_KEYS) {
        try { store.removeItem(key); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new Error("Device session storage could not be cleared.");
  }

  return {
    revoked,
    remembered,
    setRemember(value: boolean) {
      clearAuth();
      persistent.setItem(REMEMBER_KEY, value ? "true" : "false");
    },
    revoke() {
      // Invalidate every existing adapter in this app window, including the
      // parent page when Sign Out was clicked inside a profile iframe.
      signedOut = true;
      try { temporary.setItem(LOGOUT_GENERATION_KEY, crypto.randomUUID()); }
      finally { this.clear(); }
    },
    clear() {
      clearAuth();
      try { persistent.removeItem(REMEMBER_KEY); } catch { throw new Error("Device session preference could not be cleared."); }
    },
    storage: {
      getItem(key: string) { return revoked() ? null : selected().getItem(key); },
      setItem(key: string, value: string) {
        if (revoked()) return;
        other().removeItem(key);
        selected().setItem(key, value);
      },
      removeItem(key: string) {
        if (revoked()) return;
        let failed = false;
        for (const store of [persistent, temporary]) {
          try { store.removeItem(key); } catch { failed = true; }
        }
        if (failed) throw new Error("Device session storage could not be cleared.");
      },
    } satisfies StoragePort,
  };
}
