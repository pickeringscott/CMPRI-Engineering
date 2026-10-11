const ACTIONS: Record<string, string> = {
  verify: "check", verified: "check", check: "check", checked: "check", inspect: "check", inspected: "check",
  test: "test", tested: "test", measure: "measure", measured: "measure",
  replace: "replace", replaced: "replace", swap: "replace", swapped: "replace",
  clean: "clean", cleaned: "clean", reset: "reset", reseat: "reseat", reseated: "reseat",
};
const FILLER = new Set("the a an is was were has have been already completed complete done perform performed and then for to of that it its according manual procedure manufacturer instructions confirm ensure".split(" "));

function words(text: string) {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((word) => word && !FILLER.has(word)).map((word) => ACTIONS[word] || word);
}

/** Remove only a documented completed action; never infer a repair or generate guidance. */
export function troubleshootingStepAlreadyDone(step: string, notes: string, actions: string[] = []): boolean {
  // Preserve a manufacturer's explicit subsequent/repeated check.
  if (/\b(recheck|retest|repeat|again|after|under load)\b/i.test(step)) return false;
  const required = new Set(words(step));
  const stepCodes = [...step.matchAll(/\bcode\s*([a-z]?\d+)\b/gi)].map((match) => match[1].toLowerCase());
  const clauses = [notes, ...actions].flatMap((text) => text.toLowerCase().replace(/[’]/g, "'")
    .split(/[.;\n]+|\b(?:but|however)\b/));
  return clauses.some((clause) => {
    // Future, uncertain, and explicitly unfinished work is not evidence of completion.
    if (/\?|\bto be\b|\b(need|needs|should|will|would|could|might|please|plan|planned|pending|maybe|perhaps|if|must)\b|\b(?:not|never|haven't|hasn't|didn't|wasn't|isn't)\b.{0,25}\b(?:checked|verified|tested|measured|replaced|cleaned|reset|reseated|done|completed)\b|\b(?:check|test|replacement|reset|cleaning)\s+(?:not|incomplete)\b/.test(clause)) return false;
    if (stepCodes.length === 1 && !/\bcodes\b|\bcode\s*[a-z]?\d+\s*(?:and|or|\/|,)\s*\d+/i.test(step)) {
      const code = stepCodes[0];
      if (new RegExp(`\\bnot\\s+code\\s*${code}\\b|\\bcode\\s*${code}\\b\\s+(?:(?:is|was|has been)\\s+)?(?:ruled out|not present|absent)\\b`, "i").test(clause)) return true;
    }
    if (!/\b(verified|checked|inspected|tested|measured|replaced|swapped|cleaned|reset|reseated|completed|done)\b|\bbreaker (?:is |was )?not tripped\b/.test(clause)) return false;
    if (![...required].some((word) => Object.values(ACTIONS).includes(word))) return false;
    // At least an action and a specific object must agree. A basic check does not
    // suppress a deeper measurement or a step containing another component.
    if (required.size < 2) return false;
    const completed = new Set(words(clause.replace(/\bbreaker (?:is |was )?not tripped\b/g, "breaker checked")));
    return [...required].every((word) => completed.has(word));
  });
}
