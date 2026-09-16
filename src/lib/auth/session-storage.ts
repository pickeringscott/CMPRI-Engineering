export type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const SESSION_KEY = "cmpri:auth:v1";
export const REMEMBER_KEY = "cmpri:remember";

const AUTH_KEYS = [SESSION_KEY, `${SESSION_KEY}-code-verifier`, `${SESSION_KEY}-user`];

export function createSessionStoragePolicy(persistent: StoragePort, temporary: StoragePort) {
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
    remembered,
    setRemember(value: boolean) {
      clearAuth();
      persistent.setItem(REMEMBER_KEY, value ? "true" : "false");
    },
    clear() {
      clearAuth();
      try { persistent.removeItem(REMEMBER_KEY); } catch { throw new Error("Device session preference could not be cleared."); }
    },
    storage: {
      getItem(key: string) { return selected().getItem(key); },
      setItem(key: string, value: string) {
        other().removeItem(key);
        selected().setItem(key, value);
      },
      removeItem(key: string) {
        let failed = false;
        for (const store of [persistent, temporary]) {
          try { store.removeItem(key); } catch { failed = true; }
        }
        if (failed) throw new Error("Device session storage could not be cleared.");
      },
    } satisfies StoragePort,
  };
}
