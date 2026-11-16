type Candidate = { location_id?: unknown; asset_id?: unknown; issue?: unknown; status?: unknown };
const terminal = new Set(["completed", "done", "closed", "cancelled", "canceled", "will not do", "duplicate"]);
const ignored = new Set(["a", "an", "the", "is", "are", "in", "at", "room", "unit", "issue", "problem", "please", "guest", "reported", "needs", "need", "with"]);
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
/** Match specific faults even when a repeat report uses different words. */
function reportedFaults(issue: unknown) {
  const text = String(issue || "").toLowerCase();
  const faults = new Set<string>();
  // Keep pressure problems separate from leaks, loose handles, temperature,
  // and pressure problems at another fixture in the same room.
  const lowPressure = /\b(?:low|weak|poor|little|reduced|no)\b[^.;\n]{0,30}\b(?:pressure|flow)\b|\b(?:pressure|flow)\b[^.;\n]{0,30}\b(?:low|weak|poor|little|reduced|drizzl\w*)\b/;
  if (lowPressure.test(text) && !/\b(?:not|isn['’]?t|no)\s+(?:have\s+)?(?:very\s+)?(?:low|weak|poor|reduced)\b/.test(text)) {
    for (const fixture of ["shower", "sink", "toilet"] as const) {
      if (new RegExp(`\\b${fixture}(?:head)?\\b`).test(text)) faults.add(`${fixture}:low-pressure`);
    }
  }
  // An inability to turn the room heat on and 'no heat' describe the same fault.
  if (!/\b(?:water|boiler|oven|stove|cooktop|dryer)\b/.test(text)
    && /\b(?:no|without)\s+heat\b|\b(?:not|isn['’]?t)\s+heating\b|\bheat(?:ing)?\s+(?:doesn['’]?t|does\s+not|won['’]?t|will\s+not|isn['’]?t|is\s+not)\s+(?:turn\s+on|work(?:ing)?|com(?:e|ing)\s+on)\b/.test(text)) {
    faults.add("room-heat:not-working");
  }
  return faults;
}

export function likelyDuplicate(a: Candidate, b: Candidate) {
  if (!a.location_id || a.location_id !== b.location_id || terminal.has(String(b.status || "Open").toLowerCase().trim())) return false;
  if (a.asset_id && b.asset_id && a.asset_id !== b.asset_id) return false;
  const left = words(a.issue), right = words(b.issue);
  if (!left.length || !right.length) return false;
  if (left.join(" ") === right.join(" ")) return true;
  const faults = reportedFaults(a.issue);
  if ([...reportedFaults(b.issue)].some(fault => faults.has(fault))) return true;
  if (left.some(word => negation.has(word)) !== right.some(word => negation.has(word))) return false;
  const x = new Set(canonicalWords(a.issue));
  const y = new Set(canonicalWords(b.issue));
  const overlap = [...x].filter(word => y.has(word)).length;
  if (overlap >= 2 && overlap / Math.min(x.size, y.size) >= 0.8 && overlap / Math.max(x.size, y.size) >= 0.5) return true;

  const symptomWords = new Set(["cool", "heat", "leak", "clog", "display", "picture", "signal", "light", "faucet", "drain", "lock", "door", "power"]);
  const sharedSymptoms = [...x].filter((word) => y.has(word) && symptomWords.has(word));
  return sharedSymptoms.length >= 1 && [...x].some((word) => y.has(word) && !symptomWords.has(word));
}
