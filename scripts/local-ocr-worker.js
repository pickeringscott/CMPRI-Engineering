/* Same-origin bootstrap for the pinned Tesseract worker. */
let initialized = false;
const nonce = self.location.hash.slice(1);
const channel = nonce && typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(`cmpri-local-ocr-${nonce}`)
  : null;
function stop() {
  clearTimeout(watchdog);
  channel?.close();
  self.close();
}
// createWorker does not expose its worker handle until initialization finishes.
// A stalled initialization must never leave a worker running indefinitely.
const watchdog = setTimeout(() => { if (!initialized) stop(); }, 45_000);
if (channel) channel.onmessage = event => { if (event.data === 'cancel') stop(); };
const send = self.postMessage.bind(self);
self.postMessage = function (message, ...rest) {
  if (!initialized && message?.status === 'reject') {
    send(message, ...rest);
    stop();
    return;
  }
  if (!initialized && message?.action === 'initialize' && message?.status === 'resolve') {
    initialized = true;
    clearTimeout(watchdog);
    channel?.close();
  }
  send(message, ...rest);
};
importScripts(new URL('worker.min.js', self.location.href).href);
