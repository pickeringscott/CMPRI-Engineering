import type { ManualKnowledge } from "./manual-knowledge";

export type SourcePassage = import("./manual-knowledge").ManualProvenance & { page: number; printed_label?:string; text: string; kind: "diagnostic" | "troubleshooting" | "reference"; source_file_name?: string; source_url?: string; html?: string; origin?: 'pdf' | 'ocr' | 'reviewed' };
export type SourceIdentity = { manufacturer: string | null; model_family: string | null; model_number: string | null };

/** Explicit source headings are discovery hints, never inferred repair instructions. */
function procedureHeadings(text: string): string[] {
  const lines = text.split(/\n/).map(line => line.trim()).filter(Boolean);
  const headingCase = (line: string) => line === line.toUpperCase()
    || line.split(/\s+/).every(word => /^(?:the|of|and|for|to|a|an|with|in)$/i.test(word) || /^[A-Z0-9]/.test(word));
  const headings: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length > 140 || /[.!?]$/.test(line) || !headingCase(line)
      || !/^(?:component\s+)?(?:test(?:ing|s)?|inspect(?:ion|ing)?|check(?:ing|s)?|diagnos(?:is|tics?|ing))\b|\b(?:test(?:ing|s)?|inspection|diagnos(?:is|tics?|ing))$|\b(?:troubleshooting|fault codes?|error codes?)\b/i.test(line)) continue;
    let title = line;
    // Wrapped headings remain one discovery label; page content is never cut up.
    for (let next = index + 1; next < Math.min(index + 3, lines.length); next++) {
      const continuation = lines[next];
      if (continuation.length > 90 || /[.!?]$/.test(continuation) || !headingCase(continuation)
        || /^(?:WARNING|CAUTION|DANGER|NOTE)\b/.test(continuation)) break;
      title += ` ${continuation}`;
    }
    headings.push(title);
  }
  return headings;
}

/** Preserve source text, including table rows. No generated repair instructions. */
export function manualSourcePassages(text: string): SourcePassage[] {
  const pages = [...text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)];
  return pages.flatMap<SourcePassage>((match) => {
    const body = match[2].trim();
    if (/table of contents/i.test(body) || (body.match(/\.{5,}/g) || []).length > 3) return [];
    if (!/troubleshoot|fault|error\s+code|diagnostic|problem\s+(?:cause|solution)|possible\s+cause/i.test(body)) {
      return procedureHeadings(body).length ? [{ page: Number(match[1]), text: body, kind: "reference" as const }] : [];
    }
    return [{ page: Number(match[1]), text: body, kind: /fault|error\s+code|diagnostic/i.test(body) ? "diagnostic" as const : "troubleshooting" as const }];
  });
}

/** Index readable source pages without claiming that they contain repair steps. */
export function manualReferencePages(text: string): SourcePassage[] {
  return [...text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)].flatMap(match => {
    const page = Number(match[1]), body = match[2].trim();
    if (!Number.isSafeInteger(page) || page < 1 || !body || /table of contents/i.test(body) || (body.match(/\.{5,}/g) || []).length > 3) return [];
    return [{ page, text: body, kind: "reference" as const }];
  });
}

/** Index illustrated parts pages next to their own parts lists without inventing procedures. */
export function manualPartsPassages(text: string): SourcePassage[] {
  const pages = [...text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)]
    .map(match => ({ page: Number(match[1]), text: match[2].trim() }));
  const selected = new Map<number, SourcePassage>();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const header = page.text.match(/\b(?:ref(?:erence)?\s+)?part\s+(?:no\.?|number)\s+description\b/i);
    if (!header || /table of contents/i.test(page.text)) continue;
    selected.set(page.page, { ...page, kind: "reference" });
    const previous = pages[index - 1];
    if (!previous || previous.page !== page.page - 1) continue;
    const title = page.text.slice(0, header.index).replace(/^.*?\b(?:do not copy or transmit)\b/i, "");
    const words = title.toLowerCase().match(/[a-z]{4,}/g) || [];
    const meaningful = words.filter(word => !/^(parts|drawing|models|figure|copyright|alliance|laundry|systems)$/.test(word));
    if (meaningful.some(word => new RegExp(`\\b${word}\\b`, "i").test(previous.text))) {
      selected.set(previous.page, { ...previous, kind: "reference" });
    }
  }
  return [...selected.values()].sort((a, b) => a.page - b.page);
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

const stop = new Set("the and for with this that from have has was were been room unit equipment appliance machine dryer washer heater boiler problem issue not does working work code error fault".split(" "));
function sourceSearchText(value: string): string {
  return value.toLowerCase()
    .replace(/\b(?:leaking|leaks|leakage|leaked)\b/g, "leak")
    .replace(/\b(?:dripping|drips|dripped)\b/g, "drip")
    .replace(/\b(?:cooling|cools|cooled)\b/g, "cool")
    .replace(/\b(?:heating|heats|heated|heaters?)\b/g, "heat")
    .replace(/\b(?:draining|drains|drained)\b/g, "drain")
    .replace(/\b(?:filling|fills|filled)\b/g, "fill")
    .replace(/\b(?:noisy|noises)\b/g, "noise");
}

/** Reduce ordinary plural and tense endings for source-page discovery. */
function sourceSearchWords(value: string): string[] {
  return (sourceSearchText(value).match(/[a-z0-9]+/g) || []).filter(word => word.length > 2 && !stop.has(word)).map(word => {
    if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (word.length > 5 && word.endsWith('ing')) {
      let stem = word.slice(0, -3);
      if (/(.)\1$/.test(stem)) stem = stem.slice(0, -1);
      return stem;
    }
    if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
    if (word.length > 5 && /(?:sses|ches|shes|xes)$/.test(word)) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }).filter(word=>!stop.has(word));
}

const sourceWordCache = new WeakMap<SourcePassage, { text: string; words: Set<string>; headings: Set<string>[] }>();

/** Find possible source pages, retaining the original PDF for context. */
export function relevantSourcePassages(passages: SourcePassage[], issue: string, technicianContext = ''): SourcePassage[] {
  const words = [...new Set(sourceSearchWords(issue))];
  const contextWords = [...new Set(sourceSearchWords(technicianContext))];
  if (!words.length && !contextWords.length) return [];
  const ranked = passages.map(passage => {
    let cached = sourceWordCache.get(passage);
    if (!cached || cached.text !== passage.text) {
      cached = { text: passage.text, words: new Set(sourceSearchWords(passage.text)),
        headings: procedureHeadings(passage.text).map(heading => new Set(sourceSearchWords(heading))) };
      sourceWordCache.set(passage, cached);
    }
    const bodyMatches = words.filter(word => cached.words.has(word)).length;
    const headingMatches = Math.max(0, ...cached.headings.map(heading => words.filter(word => heading.has(word)).length));
    const contextMatches = contextWords.filter(word => cached.words.has(word)).length;
    return { passage, score: bodyMatches + headingMatches * 3, contextScore: contextMatches };
  });
  // Technician findings refine an issue match and can add references. They must
  // not let a long history outrank the reported issue itself.
  return ranked.filter(item => item.score > 0 || item.contextScore > 0)
    .sort((a, b) => Number(b.score>0)-Number(a.score>0)
      || Number(b.score>0&&b.passage.kind!=='reference')-Number(a.score>0&&a.passage.kind!=='reference')
      || b.score-a.score || b.contextScore-a.contextScore).map(item => item.passage);
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
