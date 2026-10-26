type Candidate = { location_id?: unknown; asset_id?: unknown; issue?: unknown; status?: unknown };
const terminal = new Set(["completed", "done", "closed", "cancelled", "canceled", "will not do", "duplicate"]);
const ignored = new Set(["a", "an", "the", "is", "are", "in", "at", "of", "do", "does", "did", "be", "been", "being", "has", "have", "had", "it", "its", "still", "to", "for", "and", "room", "unit", "issue", "problem", "please", "guest", "reported", "needs", "need", "with"]);
const negation = new Set(["not", "no", "never", "isnt", "wont", "cannot", "cant", "sin"]);
const synonym: Record<string, string> = {
  ac: "hvac",
  air: "hvac",
  conditioner: "hvac",
  television: "tv",
  televisions: "tv",
  fridge: "refrigerator",
  fridges: "refrigerator",
  cooling: "cool",
  cooled: "cool",
  cold: "cool",
  heating: "heat",
  heated: "heat",
  leaks: "leak",
  leaking: "leak",
  leaked: "leak",
  cracked: "crack",
  cracks: "crack",
  cracking: "crack",
  clogged: "clog",
  clogging: "clog",
  faucets: "faucet",
  taps: "faucet",
  lights: "light",
  bulbs: "light",
  displays: "display",
  screens: "display",
  display: "display",
  signal: "display",
  picture: "display",
  pictures: "display",
};
function words(issue: unknown) {
  const text = String(issue || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/isn't|isnt|won't|wont|can't|cant|cannot|will not|is not/g, " not ");
  return text.match(/[\p{L}\p{N}]+/gu) || [];
}
function canonicalWords(issue: unknown) {
  return words(issue)
    .filter((word) => !ignored.has(word))
    .map((word) => synonym[word] || word);
}
// Apply the same issue comparison within a report and against saved tickets.
// Proposed rows have no terminal history to exclude.
export function duplicateWithinReport(a: Candidate, b: Candidate) {
  return likelyDuplicate(a, { ...b, status: "Open" });
}

export function likelyDuplicate(a: Candidate, b: Candidate) {
  if (!a.location_id || a.location_id !== b.location_id || terminal.has(String(b.status || "Open").toLowerCase().trim())) return false;
  if (a.asset_id && b.asset_id && a.asset_id !== b.asset_id) return false;
  const left = words(a.issue), right = words(b.issue);
  if (!left.length || !right.length) return false;
  if (left.join(" ") === right.join(" ")) return true;
  if (left.some(word => negation.has(word)) !== right.some(word => negation.has(word))) return false;
  const x = new Set(canonicalWords(a.issue));
  const y = new Set(canonicalWords(b.issue));
  // Repeated failure boilerplate must not inflate similarity between different
  // fixtures (e.g. reading/microwave light "not working at all"). Negation was
  // compared above and still distinguishes opposite reports.
  const genericFailure = new Set(["not", "no", "never", "sin", "working", "work", "works", "broken", "out", "faulty", "damaged", "off", "on", "stopped", "failing", "repair", "fix", "replace", "all"]);
  // Action words still contribute to existing fuzzy review candidates such as
  // "replace missing kitchen utensils" versus "replace missing kitchen supplies".
  const informative = (word: string) => !genericFailure.has(word) || ["repair", "fix", "replace"].includes(word);
  const specificX = new Set([...x].filter(informative));
  const specificY = new Set([...y].filter(informative));
  const overlap = [...specificX].filter(word => specificY.has(word)).length;
  if (overlap >= 2 && overlap / Math.min(specificX.size, specificY.size) >= 0.8 && overlap / Math.max(specificX.size, specificY.size) >= 0.5) return true;
  const contained = specificX.size > 0 && specificY.size > 0
    && ([...specificX].every(word => specificY.has(word)) || [...specificY].every(word => specificX.has(word)));
  const fullOverlap = [...x].filter(word => y.has(word)).length;
  if (contained && fullOverlap >= 2 && fullOverlap / Math.min(x.size, y.size) >= 0.8 && fullOverlap / Math.max(x.size, y.size) >= 0.5) return true;

  const symptomWords = new Set(["cool", "heat", "leak", "clog", "display", "picture", "signal", "light", "faucet", "drain", "lock", "door", "power"]);
  const sharedSymptoms = [...x].filter((word) => y.has(word) && symptomWords.has(word));
  // "Light" + "not working" or "out" describes many separate fixtures.
  // The symptom fallback needs a shared identifying word, not generic failure
  // language. Keep the similarity/containment check above for near duplicates.
  return sharedSymptoms.length >= 1 && [...x].some((word) => y.has(word) && !symptomWords.has(word) && !genericFailure.has(word));
}
