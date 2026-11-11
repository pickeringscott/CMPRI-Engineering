import type { ManualSymptomRule } from '@/lib/manual-knowledge';
import { isFlowchartTitle } from './pdf-flowchart-branches';

type Page = { page: number; text: string; confidence: number };
const imperative = /^(?:check|inspect|verify|clean|disconnect|connect|reconnect|unplug|turn|remove|replace|test|measure|record|confirm|ensure|clear|tighten|loosen|restart|reset|open|close|adjust|set|use|drain|fill|isolate|stop|allow|wait|contact|observe|listen|press|hold|release|restore|repair|flush|lubricate|make sure|do not)\b/i;

/** OCR is approximate: only explicit numbered actions are offered, with their source page. */
export function ocrManualActions(pages: Page[]): ManualSymptomRule[] {
  const output: ManualSymptomRule[] = [];
  for (const page of pages) {
    if (page.confidence < 85 || !Number.isSafeInteger(page.page) || page.page < 1) continue;
    const lines = page.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.some(line => /\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(line))) continue;
    for (let index=0; index<lines.length; index++) {
      const heading = lines[index];
      if (!isFlowchartTitle(heading)) continue;
      const nearby = lines.slice(index+1,index+20);
      const first = nearby.findIndex(line => /^1[.)]\s+/.test(line));
      if (first < 0 || first > 3) continue;
      const preamble = nearby.slice(0,first).join(' ').trim();
      if (preamble && (!/[.!?]$/.test(preamble) || preamble.length > 600)) continue;
      const steps: string[] = []; let current = ''; let expected = 1;
      const finish = () => {
        const text = current.replace(/\s+/g,' ').trim();
        if (!text || !/[.!?]$/.test(text) || !imperative.test(text.replace(/^\d+[.)]\s+/,''))) return false;
        steps.push(['OCR', heading, preamble, text].filter(Boolean).join(' — ')); return true;
      };
      for (const line of nearby.slice(first)) {
        const numbered = line.match(/^(\d+)[.)]\s+/);
        if (numbered) {
          if (Number(numbered[1]) !== expected || (current && !finish())) { current = ''; break; }
          expected++; current = line;
        } else if (current && !/[.!?]$/.test(current)) current += ` ${line}`;
        else break;
      }
      if (current && !finish()) continue;
      if (steps.length < 2) continue;
      const match = [heading];
      const degree = heading.match(/^(low|high|poor|slow)\s+(.+)$/i);
      if (degree) match.push(`${degree[2]} ${degree[1]}`, `${degree[2]} is ${degree[1]}`, `${degree[2]} too ${degree[1]}`, `${degree[2]} is too ${degree[1]}`);
      const state = heading.match(/^(.+?)\s+(stuck|blocked|jammed|broken|leaking)$/i);
      if (state) match.push(`${state[1]} is ${state[2]}`);
      output.push({ match, steps, source_pages: [page.page] });
    }
  }
  return output;
}
