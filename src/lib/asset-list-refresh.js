/** Queue one follow-up when a save arrives during an older list request. No cache.
 * @param {() => Promise<void>} run
 */
export function queuedAssetRefresh(run) {
  let pending = null, again = false;
  return function refresh() {
    if (pending) { again = true; return pending; }
    pending = (async () => { do { again = false; await run(); } while (again); })().finally(() => { pending = null; });
    return pending;
  };
}
/** @param {MessageEvent} event @param {string} origin @param {Window} parent @param {string} token */
export function isAssetListRefresh(event, origin, parent, token) {
  return Boolean(token && event.origin === origin && event.source === parent
    && event.data?.type === "cmpri-assets-changed" && event.data.modalToken === token
    && typeof event.data.assetId === "string" && event.data.assetId);
}
