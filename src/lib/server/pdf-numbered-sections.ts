import type { ManualSymptomRule } from '@/lib/manual-knowledge';
import { isFlowchartTitle } from './pdf-flowchart-branches';

type TextItem = { str: string; transform: number[]; fontName?: string };
type Line = { y: number; x: number; text: string; font: string; size: number; oneFont: boolean };
const imperative = /^(?:check|inspect|verify|clean|disconnect|connect|reconnect|unplug|turn|remove|replace|test|measure|record|confirm|ensure|clear|tighten|loosen|restart|reset|open|close|adjust|set|use|drain|fill|isolate|stop|allow|wait|contact|observe|listen|press|hold|release|restore|repair|flush|lubricate|make sure|do not)\b/i;

/** Extract complete, numbered source actions only under an explicit symptom heading. */
export function numberedSectionRules(items: TextItem[], pageNumber: number, pageWidth: number): ManualSymptomRule[] {
  if (items.some(item => /\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(item.str))) return [];
  const linesForColumn = (rightColumn: boolean): Line[] => {
    const grouped = new Map<number, TextItem[]>();
    for (const item of items) {
      if (!item.str.trim() || (item.transform[4] >= pageWidth / 2) !== rightColumn) continue;
      const y = Math.round(item.transform[5]); const row = grouped.get(y) || []; row.push(item); grouped.set(y, row);
    }
    return [...grouped.entries()].sort((a,b) => b[0]-a[0]).map(([y,row]) => {
      row.sort((a,b) => a.transform[4]-b.transform[4]);
      return { y, x: row[0].transform[4], text: row.map(part=>part.str.trim()).join(' ').replace(/\s+([.,;:!?])/g,'$1').replace(/\s+/g,' ').trim(), font: row[0].fontName || '', size: Math.hypot(row[0].transform[0],row[0].transform[1]), oneFont: row.every(part=>part.fontName===row[0].fontName) };
    });
  };
  const output: ManualSymptomRule[] = [];
  for (const lines of [linesForColumn(false), linesForColumn(true)]) for (let index = 0; index < lines.length; index++) {
    const heading = lines[index];
    if (!heading.oneFont || !heading.font || !isFlowchartTitle(heading.text)) continue;
    const candidates = lines.slice(index+1, index+25);
    const first = candidates.findIndex(line => /^1[.)]\s+/.test(line.text));
    if (first < 0 || first > 5) continue;
    const firstStep = candidates[first];
    if (heading.font === firstStep.font && heading.size <= firstStep.size * 1.1) continue;
    const beforeFirst = candidates.slice(0, first);
    if (beforeFirst.some((line, position) => (line.oneFont && line.font === heading.font) || (position ? beforeFirst[position-1].y : heading.y) - line.y > 30)
      || (first ? beforeFirst[first-1].y : heading.y) - firstStep.y > 40) continue;
    const preamble = beforeFirst.map(line=>line.text).join(' ').trim();
    if (preamble && (!/[.!?]$/.test(preamble) || preamble.length > 600)) continue;
    const steps: string[] = []; let current = ''; let ordinal = 1; let previousY = heading.y;
    const finish = () => {
      const clean = current.replace(/\s+/g,' ').trim();
      if (!clean || !/[.!?]$/.test(clean) || !imperative.test(clean.replace(/^\d+[.)]\s+/,''))) return false;
      steps.push([heading.text,preamble,clean].filter(Boolean).join(' — ')); return true;
    };
    for (const line of candidates.slice(first)) {
      if (previousY !== heading.y && previousY-line.y > 24) break;
      if (line.oneFont && line.font === heading.font && line.x <= heading.x + 15) break;
      const numbered = line.text.match(/^(\d+)[.)]\s+/);
      if (numbered) {
        const number = Number(numbered[1]);
        if (number !== ordinal || (current && !finish())) { current = ''; break; }
        ordinal++; current = line.text;
      } else {
        if (!current) break;
        current += ` ${line.text}`;
      }
      previousY = line.y;
    }
    if (current && !finish()) continue;
    if (steps.length < 2) continue;
    const match = [heading.text];
    const degree = heading.text.match(/^(low|high|poor|slow)\s+(.+)$/i);
    if (degree) match.push(`${degree[2]} ${degree[1]}`, `${degree[2]} is ${degree[1]}`);
    const state = heading.text.match(/^(.+?)\s+(stuck|blocked|jammed|broken|leaking)$/i);
    if (state) match.push(`${state[1]} is ${state[2]}`);
    output.push({ match, steps, source_pages: [pageNumber] });
  }
  return output;
}
