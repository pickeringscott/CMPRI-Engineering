import type { ManualKnowledge, ManualSymptomRule } from "../manual-knowledge";

export function equipmentSearchAliases(value: string): string[] {
  return [value, ...(/\b(friedrich|frederick)\b/i.test(value) ? ["Friedrich", "Frederick"] : []),
    ...(/\bvert[ -]?i?[ -]?pak\b/i.test(value) ? ["Vert-I-Pak", "Vertipak", "Verti Pak"] : [])];
}

function symptomText(value: string) {
  return value.toLowerCase().replace(/\b(noisy|noises|loud)\b/g, "noise")
    .replace(/\b(rattling|rattles)\b/g, "rattle").replace(/\b(vibrating|vibrates)\b/g, "vibration")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** Route only text already extracted from verified documentation; never invent steps. */
export function guideRulesForIssue(knowledge: ManualKnowledge | null | undefined, issue: string): ManualSymptomRule[] {
  if (knowledge?.source?.verified !== true) return [];
  const evidence = " " + symptomText(issue) + " ";
  const rules = [...(knowledge.symptom_rules || []), ...(knowledge.manual_tests || []).filter(test => test.match?.length).map(test => ({
    match: test.match || [], steps: test.steps?.length ? test.steps : [test.test || test.action || ""].filter(Boolean), source_pages: test.source_pages,
  }))];
  const matched = rules.filter(rule => !!rule.match?.length && rule.match.some(phrase => {
    const normalized = symptomText(phrase);
    return normalized !== "" && evidence.includes(" " + normalized + " ");
  }));
  return matched;
}
