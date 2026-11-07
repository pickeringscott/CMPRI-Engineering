let registration: Promise<void> | undefined;

/** One registration per page; animation frames and individual leaves never request data. */
export function ensureThanksgivingCache(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve();
  registration ??= (async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    // Ask the browser to protect the device's saved assets from automatic eviction.
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch {}
  })().catch(() => { registration = undefined; });
  return registration;
}
