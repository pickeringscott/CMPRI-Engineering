let registration: Promise<void> | undefined;

/** Only the generated artwork allowlist is cached; game frames never fetch app data. */
export function ensureFootballCache(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve();
  registration ??= (async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch {}
  })().catch(() => { registration = undefined; });
  return registration;
}
