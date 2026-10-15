/** Presentation only: never pad, date-convert, renumber, or use an internal ID. */
/** @param {unknown} value @returns {string | null} */
export function workOrderNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
  const match = String(value).trim().match(/^@?(?:(?:WO\s*[#-]?\s*|work\s+order\s*#?\s*|#))?(\d+)$/i);
  return match?.[1] || null;
}

/** @param {unknown} value @param {string} [fallback] */
export function formatWorkOrder(value, fallback = "Work order") {
  const number = workOrderNumber(value);
  return number ? `WO#${number}` : fallback;
}

/** Explicit references only. Ordinary numbers and room labels are never tickets. */
/** @param {string} text */
export function workOrderReferences(text) {
  /** @type {Array<{ start: number, end: number, number: string, label: string }>} */
  const matches = [];
  const pattern = /(?<![\p{L}\p{N}_])(?:@?WO\s*[#-]?\s*|@?work\s+order\s*#?\s*|@?#|@)(\d+)(?![\p{L}\p{N}_-])/giu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (/\broom\s*$/i.test(text.slice(0, start))) continue;
    matches.push({ start, end: start + match[0].length, number: match[1], label: formatWorkOrder(match[1]) });
  }
  return matches;
}

/** Render/export a copy; stored note and notification history stays untouched. */
/** @param {string} text */
export function formatWorkOrderReferences(text) {
  let result = "", at = 0;
  for (const ref of workOrderReferences(text)) {
    result += text.slice(at, ref.start) + ref.label;
    at = ref.end;
  }
  return result + text.slice(at);
}

/** Format the identifier slot of existing generated ticket notifications, not room text.
 * @param {{message: string, work_order_id?: string | null}} notification
 */
export function formatWorkOrderNotification(notification) {
  const text = formatWorkOrderReferences(notification.message);
  if (!notification.work_order_id) return text;
  return text.replace(/^(New )?(\d+)(?=:| \(| was | viewed )/, (_, prefix, number) => `${prefix || ""}${formatWorkOrder(number)}`);
}

/** Search a known ticket field; legacy explicit prefixes never match a room number.
 * @param {unknown} displayId @param {string} query
 */
export function workOrderReferenceMatches(displayId, query) {
  const number = workOrderNumber(query);
  return number !== null && workOrderNumber(displayId)?.includes(number) === true;
}
