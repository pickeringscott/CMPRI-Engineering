import { manualTextContainsExactIdentity } from "./manual-document-match";
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
  const identityVerified = Boolean(identity.manufacturer && (identity.model_family || identity.model_number)
    && manualTextContainsExactIdentity(text, identity.manufacturer)
    && (manualTextContainsExactIdentity(text, identity.model_family) || manualTextContainsExactIdentity(text, identity.model_number)));
  const state = !text.trim() ? "failed" : !identityVerified ? "pending_identity" : passages.length ? "ready" : "pending_guidance";
  const knowledge: ManualKnowledge = {
    ...identity, manufacturer: identity.manufacturer || "", model_family: identity.model_family || "", model_number: identity.model_number || "",
    source: { title: fileName, source_file_name: fileName, verified: identityVerified, type: "Verbatim uploaded PDF excerpts", sha256 },
    source_passages: passages,
    error_codes: [], symptom_rules: [], general_checks: [], manual_tests: [],
  };
  return { state, knowledge, message: state === "failed" ? "PDF saved, but readable text could not be extracted. OCR or a readable PDF is required."
    : state === "pending_identity" ? "PDF saved. Its manufacturer and exact model must match the equipment before guidance can be verified."
    : state === "pending_guidance" ? "Equipment identity matched the PDF. No troubleshooting or diagnostic section was detected; open the complete manual for reference."
    : "Equipment identity matched the PDF. Troubleshooting and diagnostic excerpts from the uploaded PDF are available with page references." };
}

const stop = new Set("the and for with this that from have has was were been room unit equipment problem issue not does working work code error fault".split(" "));
export function relevantSourcePassages(passages: SourcePassage[], issue: string): SourcePassage[] {
  const words = [...new Set(issue.toLowerCase().match(/[a-z0-9]+/g) || [])].filter(word => word.length > 2 && !stop.has(word));
  const ranked = passages.map(passage => ({ passage, score: words.filter(word => new RegExp(`\\b${word}\\b`, "i").test(passage.text)).length }));
  return ranked.filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.passage);
}

/** Require an explicit diagnostic cue; temperatures and imported ticket IDs are not fault codes. */
export function reportedDiagnosticCode(text: string): string | null {
  const clean = text.split(/\n/).filter(line => !/original source ticket|canonical id|approved import row|source ticket id/i.test(line)).join("\n");
  const match = clean.match(/\b(?:error(?:\s+code)?|fault(?:\s+code)?|diagnostic\s+code|code)\s*(?:is\s+)?[:#=-]?\s*([a-z]{0,4}[- ]?\d{1,4}[a-z0-9-]{0,6})\b/i);
  return match ? match[1].replace(/[^a-z0-9]/gi, "").toUpperCase() : null;
}
