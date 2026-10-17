/** Resolve a reload without overriding a valid user selection with an old link. */
export function resolvePoSelection(ids: string[], current: string, linked: string | null) {
  if (current && ids.includes(current)) return {id: current, missingLink: false};
  if (linked) return {id: ids.includes(linked) ? linked : '', missingLink: !ids.includes(linked)};
  return {id: ids[0] || '', missingLink: false};
}
