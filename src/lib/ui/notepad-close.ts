export const NOTEPAD_CLOSE_REQUEST = "cmpri-notepad-close-request";
export type NotepadCloseRequest = { requestId: string; onReady: () => void };

/** Ask only this editor to finish its input and save before its owning surface closes. */
export function requestNotepadClose(container: Element | null | undefined, onReady: () => void): boolean {
  const host = container?.matches(".cmpri-notepad-host") ? container : container?.querySelector(".cmpri-notepad-host");
  const view = host?.ownerDocument.defaultView;
  if (!host || !view) return true;
  return host.dispatchEvent(new view.CustomEvent<NotepadCloseRequest>(NOTEPAD_CLOSE_REQUEST, {
    cancelable: true, detail: { requestId: crypto.randomUUID(), onReady },
  }));
}
