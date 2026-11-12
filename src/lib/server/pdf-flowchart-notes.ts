import type { ManualSymptomRule } from '@/lib/manual-knowledge';

type TextItem = { str: string; transform: number[] };

/** Preserve explicit prerequisites beside a chart; leave yes/no branches in the original chart. */
export function flowchartPrerequisites(items: TextItem[], pageNumber: number): ManualSymptomRule[] {
  const headings = items.filter(item => /^(?:no\s+.+|.+\s+(?:not|does not|will not)\s+.+)\s+operation$/i.test(item.str.trim()));
  const results: ManualSymptomRule[] = [];
  for (const heading of headings) {
    const condition = heading.str.trim();
    const notes = items.filter(item => /^before continuing\b/i.test(item.str.trim()) && heading.transform[5] > item.transform[5] && heading.transform[5] - item.transform[5] < 100);
    for (const note of notes) {
      // Do not promote a branch-specific note to an unconditional step.
      if (items.some(item => /^(?:yes|no)$/i.test(item.str.trim()) && item.transform[5] < heading.transform[5] && item.transform[5] > note.transform[5])) continue;
      const x = note.transform[4], y = note.transform[5];
      const candidates = items.filter(item => item.transform[5] <= y && item.transform[5] > y - 90 && Math.abs(item.transform[4] - x) < 45 && item.str.trim())
        .sort((a,b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
      const lines: string[] = [];
      let previous = y;
      for (const item of candidates) {
        if (previous - item.transform[5] > 12) break;
        lines.push(item.str.trim()); previous = item.transform[5];
        if (/\bpage\s+\d+[.]?$/i.test(item.str.trim())) break;
      }
      const prerequisite = lines.join(' ').replace(/\s+([.,;:!?])/g, '$1').trim();
      if (!/^before continuing\b/i.test(prerequisite) || !/\b(?:check|inspect|verify|test)\b/i.test(prerequisite) || !/\bpage\s+\d+[.]?$/i.test(prerequisite)) continue;
      const match = [condition];
      if (/\bno cooling\b/i.test(condition)) match.push('not cooling');
      if (/\bno heat(?:ing)?\b/i.test(condition)) match.push('not heating');
      results.push({ match, steps: [`${condition} — ${prerequisite}`], source_pages: [pageNumber], reference_only: true });
    }
  }
  return results;
}
