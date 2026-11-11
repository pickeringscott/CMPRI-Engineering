import type { ManualHtmlPage } from './manual-document-html';
import type { ManualSymptomRule } from './manual-knowledge';

const numberedHeading = /^(\d+)[.)]\s+(.+)$/;
const letteredAction = /^([a-z])[.)]\s+(.+)$/i;
const troubleshooting = /^(?:[\p{L}\p{N} &/-]+\s+)?troubleshooting\s*:?$/iu;
const qualification = /^(?:note|warning|caution|danger|important)\b\s*:?/i;
const instruction = /^(?:check|inspect|verify|clean|disconnect|connect|reconnect|unplug|turn|remove|replace|test|measure|record|confirm|ensure|clear|tighten|loosen|restart|reset|open|close|adjust|set|use|drain|fill|isolate|stop|allow|wait|contact|observe|listen|press|hold|release|restore|repair|flush|lubricate|make sure|do not|repeat|refer|follow|perform)\b/i;
const sentenceEnd = /[.!?]["'”’)]*$/;
const failure = /\b(?:cannot|can't|does not|doesn't|will not|won't|not|no|fails?|failure|malfunction|error|fault|leaks?|leaking|overheats?|overheating|stuck|blocked)\b/i;
const standaloneTitle = (line: string) => !/[.!?;:]$/.test(line)
  && line.split(/\s+/).every(word => /^[A-Z0-9]/.test(word) || /^(?:&|and|or|of|the|for|to|on|in)$/.test(word));
const conditional = /\b(?:if|when|while|during|after|before|only|unless|with|without|and)\b/i;

function symptomTitle(value: string): boolean {
  return value.length <= 180 && failure.test(value) && !instruction.test(value)
    && !/[.!?;:]$/.test(value) && !/\.{3}|\t|\|/.test(value);
}

function titleMatches(title: string): string[] {
  const alternatives = title.split('/').map(part => part.trim());
  // Never manufacture aliases by supplying omitted shared words or dropping
  // operating conditions. Every additional match is a literal complete phrase.
  return alternatives.length > 1 && !conditional.test(title)
    && alternatives.every(part => symptomTitle(part) && part.split(/\s+/).length >= 2)
    ? [...new Set([title, ...alternatives])] : [title];
}

function hasInstruction(text: string): boolean {
  return instruction.test(text) || /^(?:if|when|only if|after|before|unless)\b[^.!?]*,\s*/i.test(text)
    && instruction.test(text.replace(/^(?:if|when|only if|after|before|unless)\b[^.!?]*,\s*/i, ''));
}

function completeProcedure(lines: string[]): boolean {
  const starts = lines.flatMap((line, index) => letteredAction.test(line) ? [index] : []);
  if (starts.length < 2 || starts.length > 26) return false;
  if (!starts.every((index, order) => lines[index].match(letteredAction)![1].toLowerCase() === String.fromCharCode(97 + order))) return false;
  // A preamble is retained, including its troubleshooting subheading, but
  // unrelated titles, tables and competing lists make association ambiguous.
  const preamble = lines.slice(0, starts[0]);
  if (preamble.some(line => /^(?:[•●▪*-]|\d+[.)])\s/.test(line) || line.includes('|'))) return false;
  for (let i = 0; i < preamble.length; i++) {
    const line = preamble[i];
    if (troubleshooting.test(line) || qualification.test(line)) continue;
    if (standaloneTitle(line)) return false;
    if (i === preamble.length - 1 && !sentenceEnd.test(line)) return false;
  }
  for (let order = 0; order < starts.length; order++) {
    const start = starts[order];
    const end = starts[order + 1] ?? lines.length;
    const chunk = [lines[start].match(letteredAction)![2], ...lines.slice(start + 1, end)];
    if (!hasInstruction(chunk[0])) return false;
    // Notes may be attached only after the final action. Keep the entire
    // procedure together so no note or prerequisite can be separated from it.
    const note = chunk.findIndex((line, index) => index > 0 && qualification.test(line));
    if (note >= 0 && order !== starts.length - 1) return false;
    const actionLines = note >= 0 ? chunk.slice(0, note) : chunk;
    if (!sentenceEnd.test(actionLines.at(-1) || '') || !sentenceEnd.test(chunk.at(-1) || '')) return false;
    for (let index = 1; index < chunk.length; index++) {
      const line = chunk[index];
      if (line.includes('|') || /^(?:[•●▪*-]|\d+[.)])\s/.test(line) || troubleshooting.test(line)) return false;
      // A new unnumbered heading cannot donate later actions to this symptom.
      if (!qualification.test(line) && !sentenceEnd.test(line) && sentenceEnd.test(chunk[index - 1])
        && !/^(?:if|when|unless|only|after|before)\b/i.test(line)
        && !hasInstruction(line)) return false;
    }
  }
  return true;
}

/** Extract closed, same-page alphabetic troubleshooting procedures, as source
 * groups, never independent repair advice. No model, filename or asset routing.
 * Conservative by design: a page break cannot prove a procedure is complete.
 */
export function readLetteredTroubleshootingProcedures(pages: ManualHtmlPage[]): ManualSymptomRule[] {
  const rules: ManualSymptomRule[] = [];
  for (const page of pages) {
    if (!Number.isSafeInteger(page.page) || page.page < 1 || page.page > 600) continue;
    const lines = page.blocks.flatMap(block => block.kind === 'list'
      ? block.items.flatMap(item => item.lines) : block.lines).map(line => line.trim()).filter(Boolean);
    let scoped = false;
    for (let index = 0; index < lines.length; index++) {
      if (troubleshooting.test(lines[index])) { scoped = true; continue; }
      if (!scoped) continue;
      if (!numberedHeading.test(lines[index]) && !letteredAction.test(lines[index])
        && !qualification.test(lines[index]) && standaloneTitle(lines[index])) { scoped = false; continue; }
      const heading = lines[index].match(numberedHeading);
      if (!heading || !symptomTitle(heading[2])) continue;
      let end = index + 1;
      while (end < lines.length && !numberedHeading.test(lines[end])) end++;
      const next = lines[end]?.match(numberedHeading);
      // A consecutive numbered symptom boundary, not EOF, proves the last
      // instruction and its trailing qualifications were not split by paging.
      if (!next || Number(next[1]) !== Number(heading[1]) + 1 || !symptomTitle(next[2])) continue;
      const body = lines.slice(index + 1, end);
      if (!completeProcedure(body)) continue;
      rules.push({ match: titleMatches(heading[2]), steps: [lines.slice(index, end).join('\n')], source_pages: [page.page] });
      index = end - 1;
    }
  }
  return rules;
}
