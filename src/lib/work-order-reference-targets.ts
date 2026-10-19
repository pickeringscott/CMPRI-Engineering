import { workOrderReferences } from "./work-order-reference.js";
import { plainTextParts } from "./plain-text-links";

/** Only explicit ticket references outside URLs; bare room/part numbers are ignored. */
export function workOrderReferenceTargets(text: string) {
  const urls = plainTextParts(text).filter(part => part.href);
  const outsideUrl = (start: number, end: number) => !urls.some(url => start < url.end && end > url.start);
  const refs = workOrderReferences(text).filter(ref => outsideUrl(ref.start, ref.end));
  const prefixes: string[] = [];
  for (const match of text.matchAll(/@(?:WO-)?[a-f0-9-]{8,36}\b/gi)) {
    const start = match.index!;
    if (!outsideUrl(start, start + match[0].length) || refs.some(ref => start < ref.end && start + match[0].length > ref.start)) continue;
    const prefix = match[0].replace(/^@(?:WO-)?/i, "").replaceAll("-", "").toLowerCase();
    if (/^[a-f0-9]{8,32}$/.test(prefix)) prefixes.push(prefix);
  }
  return [...new Set([...refs.map(ref => `number:${ref.number}`), ...prefixes.map(prefix => `id:${prefix}`)])];
}
