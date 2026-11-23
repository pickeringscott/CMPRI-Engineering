/** One notebook surface, including previously saved Notes and Staff Notes links. */
export const NOTEPAD_PATH = "/notepad";
export function isNotepadPath(path: string) {
  return path === NOTEPAD_PATH || path === "/notes" || path === "/staff-notes";
}

export function notepadTargetId(url: URL): string | undefined {
  if (!isNotepadPath(url.pathname)) return undefined;
  let id = url.searchParams.get("note") || "";
  if (!id && url.hash.startsWith("#note-")) {
    try { id = decodeURIComponent(url.hash.slice(6)); } catch { return undefined; }
  }
  return /^[a-z0-9][a-z0-9_-]{0,199}$/i.test(id) ? id : undefined;
}

/** Retain the first saved notebook position while removing the retired duplicate. */
export function notepadLayoutKey(key: string) {
  if (["/notes", "/staff-notes"].includes(key)) return NOTEPAD_PATH;
  if (/^\/(?:notes|staff-notes)::/.test(key)) return NOTEPAD_PATH + "::Notepad";
  return key;
}
