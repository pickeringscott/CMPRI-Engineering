import type { ManualSymptomRule } from '@/lib/manual-knowledge';

type TextItem = { str: string; transform: number[]; fontName?: string };
type Line = { y: number; x: number; text: string; font: string; oneFont: boolean };

/** Extract complete, explicitly headed diagnostic paragraphs from a single PDF column. */
export function diagnosticSectionRules(items: TextItem[], pageNumber: number, pageWidth: number): ManualSymptomRule[] {
  const grouped = new Map<number, TextItem[]>();
  for (const item of items) {
    if (!item.str.trim() || item.transform[4] >= pageWidth / 2 + 5) continue;
    const y = Math.round(item.transform[5]);
    const line = grouped.get(y) || []; line.push(item); grouped.set(y, line);
  }
  const lines: Line[] = [...grouped.entries()].sort((a,b) => b[0] - a[0]).map(([y, parts]) => {
    parts.sort((a,b) => a.transform[4] - b.transform[4]);
    return { y, x: parts[0].transform[4], text: parts.map(part => part.str.trim()).join(' ').replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim(), font: parts[0].fontName || '', oneFont: parts.every(part => part.fontName === parts[0].fontName) };
  });
  const rules: ManualSymptomRule[] = [];
  for (let index = 0; index < lines.length; index++) {
    const title = lines[index];
    if (!title.oneFont || !title.font || !/\bdiagnos(?:ing|is|tics?)\s*$/i.test(title.text)) continue;
    const condition: string[] = [];
    let next = index + 1;
    while (next < lines.length && lines[next].y > 50 && !(lines[next].oneFont && lines[next].font === title.font)) {
      if (next > index + 1 && lines[next - 1].y - lines[next].y > 18) break;
      condition.push(lines[next].text); next++;
    }
    const context = condition.join(' ').replace(/\s+/g, ' ').trim();
    if (!context || !/[.!?]$/.test(context) || context.length > 600) continue;
    const steps: string[] = [];
    for (let cursor = next; cursor < lines.length;) {
      const heading = lines[cursor];
      if (!heading.oneFont || heading.font !== title.font || !/^(?:check|verify|inspect|test)\b/i.test(heading.text) || Math.abs(heading.x - title.x) > 20) break;
      const paragraph: string[] = [];
      let end = cursor + 1;
      while (end < lines.length && lines[end].y > 50) {
        const line = lines[end];
        if (/^\d+[.)]$/.test(line.text)) break;
        if (line.oneFont && line.font === title.font && /^(?:check|verify|inspect|test|remov|replac|install|service)\b/i.test(line.text)) break;
        if (end > cursor + 1 && lines[end - 1].y - line.y > 18) break;
        paragraph.push(line.text); end++;
      }
      const instruction = paragraph.join(' ').replace(/\s+([.,;:!?])/g, '$1').trim();
      if (/^(?:check|verify|inspect|test|enter|measure|press|record|observe|remove|disconnect|turn|use)\b/i.test(instruction) && /[.!?]$/.test(instruction) && instruction.length < 1200) steps.push(`${context} — ${heading.text}: ${instruction}`);
      cursor = end;
    }
    if (!steps.length) continue;
    const match = [context];
    if (/\bcooling\b/i.test(context) && /\b(?:will not|does not|not come on|no cooling|fail)\b/i.test(context)) match.push('not cooling');
    if (/\bheating\b/i.test(context) && /\b(?:will not|does not|not come on|no heat|fail)\b/i.test(context)) match.push('not heating');
    rules.push({ match, steps, source_pages: [pageNumber] });
  }
  return rules;
}
