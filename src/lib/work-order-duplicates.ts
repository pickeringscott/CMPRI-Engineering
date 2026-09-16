type Candidate = { location_id?: unknown; asset_id?: unknown; issue?: unknown; status?: unknown };
const terminal = new Set(["closed", "cancelled", "canceled", "will not do", "duplicate"]);
function words(issue: unknown) {
  return String(issue || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}
export function likelyDuplicate(a: Candidate, b: Candidate) {
  if (!a.location_id || a.location_id !== b.location_id || terminal.has(String(b.status || "Open").toLowerCase().trim())) return false;
  if (a.asset_id && b.asset_id && a.asset_id !== b.asset_id) return false;
  const left = words(a.issue), right = words(b.issue);
  if (!left.length || !right.length) return false;
  if (left.join(" ") === right.join(" ")) return true;
  // Preserve negation: "cooling" must not collapse into "not cooling".
  const negation = new Set(["not", "no", "never", "sin"]);
  if (left.some(word => negation.has(word)) !== right.some(word => negation.has(word))) return false;
  const ignored = new Set(["a", "an", "the", "is", "are", "in", "at", "room"]);
  const canonical = (word: string) => ["leaks", "leaking"].includes(word) ? "leak" : word;
  const x = new Set(left.filter(word => !ignored.has(word)).map(canonical));
  const y = new Set(right.filter(word => !ignored.has(word)).map(canonical));
  const overlap = [...x].filter(word => y.has(word)).length;
  return overlap >= 2 && overlap / Math.min(x.size, y.size) >= 0.8 && overlap / Math.max(x.size, y.size) >= 0.5;
}
