import type { ManualKnowledge } from "./manual-knowledge";

export type SourcePassage = { page: number; text: string; kind: "diagnostic" | "troubleshooting"; source_file_name?: string; source_url?: string };
export type SourceIdentity = { manufacturer: string | null; model_family: string | null; model_number: string | null };

/** Preserve source text, including table rows. No generated repair instructions. */
export function manualSourcePassages(text: string): SourcePassage[] {
  const pages = [...text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)];
  return pages.flatMap((match) => {
    const body = match[2].trim();
    if (/table of contents/i.test(body) || (body.match(/\.{5,}/g) || []).length > 3) return [];
    if (!/troubleshoot|fault|error\s+code|diagnostic|problem\s+(?:cause|solution)|possible\s+cause/i.test(body)) return [];
    return [{ page: Number(match[1]), text: body, kind: /fault|error\s+code|diagnostic/i.test(body) ? "diagnostic" as const : "troubleshooting" as const }];
  });
}

export function prepareUploadedGuide(text: string, identity: SourceIdentity, fileName: string, sha256: string) {
  const passages = manualSourcePassages(text);
  // The Assets modal supplies the equipment association. The attached PDF is
  // the selected source; text extraction does not need a second identity review.
  const identityVerified = Boolean(text.trim());
  const state = !text.trim() ? "failed" : passages.length ? "ready" : "pending_guidance";
  const knowledge: ManualKnowledge = {
    ...identity, manufacturer: identity.manufacturer || "", model_family: identity.model_family || "", model_number: identity.model_number || "",
    source: { title: fileName, source_file_name: fileName, verified: identityVerified, type: "Verbatim uploaded PDF excerpts", sha256 },
    source_passages: passages,
    error_codes: [], symptom_rules: [], general_checks: [], manual_tests: [],
  };
  return { state, knowledge, message: state === "failed" ? "PDF saved, but readable text could not be extracted. OCR or a readable PDF is required."
    : state === "pending_guidance" ? "No troubleshooting or diagnostic section was detected; open the complete manual for reference."
    : "Troubleshooting and diagnostic excerpts from the uploaded PDF are available with page references." };
}

const stop = new Set("the and for with this that from have has was were been room unit equipment problem issue not does working work code error fault".split(" "));
function sourceSearchText(value: string): string {
  return value.toLowerCase()
    .replace(/\b(?:leaking|leaks|leakage|leaked)\b/g, "leak")
    .replace(/\b(?:dripping|drips|dripped)\b/g, "drip")
    .replace(/\b(?:cooling|cools|cooled)\b/g, "cool")
    .replace(/\b(?:heating|heats|heated)\b/g, "heat")
    .replace(/\b(?:draining|drains|drained)\b/g, "drain")
    .replace(/\b(?:filling|fills|filled)\b/g, "fill")
    .replace(/\b(?:noisy|noises)\b/g, "noise");
}

/** Find possible source pages, retaining the original PDF for context. */
export function relevantSourcePassages(passages: SourcePassage[], issue: string): SourcePassage[] {
  const words = [...new Set(sourceSearchText(issue).match(/[a-z0-9]+/g) || [])].filter(word => word.length > 2 && !stop.has(word));
  const ranked = passages.map(passage => {
    const text = sourceSearchText(passage.text);
    return { passage, score: words.filter(word => new RegExp(`\\b${word}\\b`, "i").test(text)).length };
  });
  return ranked.filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.passage);
}

/** Require a positive diagnostic report; negated/hypothetical mentions are not reports. */
export function reportedDiagnosticCode(text: string): string | null {
  const clean = text.split(/\n/).filter(line => !/original source ticket|canonical id|approved import row|source ticket id/i.test(line)).join("\n")
    .replace(/[’‘]/g, "'").replace(/\bcan't\b/gi, 'cannot').replace(/\bwon't\b/gi, 'will not')
    .replace(/\b(is|was|does|do|did|has|have|are|were|could|would|should)n't\b/gi, '$1 not');
  const clauses = clean.split(/[;\n.!?]+/);
  for (const clause of clauses) {
    const matches = clause.matchAll(/\b(?:error(?:\s+code)?|fault(?:\s+code)?|diagnostic\s+code|code)\s*(?:is\s+)?[:#=-]?\s*([a-z]{0,4}[- ]?\d{1,4}[a-z0-9-]{0,6})\b/gi);
    for (const match of matches) {
      // Scope neighboring negations without splitting a literal code such as
      // AND-42 or BUT-10 into words before its identifier has been captured.
      const before = clause.slice(0, match.index).split(/\b(?:but|however|instead|yet|and)\b/i).at(-1)!.trim();
      const after = clause.slice(match.index! + match[0].length).split(/\b(?:but|however|instead|yet|and)\b/i)[0].trim();
      const negatedBefore = /\b(?:no|not|without)(?:\s+(?:any|an?|the|active|current|actual))?\s*$/i.test(before)
        || /\b(?:not|cannot|never|no longer)\s+(?:see(?:ing)?|show(?:ing|s)?|display(?:ing|s)?|observe(?:d)?|report(?:ing)?|find|have|receive|getting)(?:\s+(?:any|an?|the))?\s*$/i.test(before);
      const hypothetical = /\b(?:if|unless|whether|maybe|possibly|perhaps|suspected|might|could|unsure|not sure)\b[^,]*$/i.test(before);
      const negatedAfter = /^(?:(?:has been|have been|had been|is|was|does|did|will|can|could|has|have|had|are|were)\s+)?(?:not|no longer|never)\s+(?:(?:been|be)\s+)?(?:display(?:ed|ing)?|show(?:n|ing)?|present|visible|active|appear(?:ed|ing)?|report(?:ed|ing)?|occur(?:red|ring)?|seen|observed|found|detected|confirmed|recorded|there|on\s+(?:the\s+)?(?:screen|display|panel)|coming up|come up)\b/i.test(after)
        || /^(?:(?:is|was|has been)\s+)?(?:absent|cleared|resolved|unconfirmed)\b/i.test(after);
      if (!negatedBefore && !hypothetical && !negatedAfter) return match[1].replace(/[^a-z0-9]/gi, '').toUpperCase();
    }
  }
  return null;
}
