import type { ManualSymptomRule } from '@/lib/manual-knowledge';

type PdfTextItem = { str: string; transform: number[] };

/** Extract source-labelled rows only when PDF coordinates establish a problem/solution table. */
export async function extractPdfTroubleshootingTables(bytes: Uint8Array): Promise<ManualSymptomRule[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const rules: ManualSymptomRule[] = [];
  try {
    if (pdf.numPages > 600) throw new Error('Manual exceeds 600 pages.');
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item && !!item.str.trim());
      const problems = items.filter(item => /^(problem|symptom|trouble|error type)$/i.test(item.str.trim()));
      for (const problem of problems) {
        const headerY = problem.transform[5];
        const solution = items.find(item => Math.abs(item.transform[5] - headerY) < 3 && item.transform[4] > problem.transform[4] && /^(solution|corrective action|remedy|check method)$/i.test(item.str.trim()));
        if (!solution) continue;
        const cause = items.find(item => Math.abs(item.transform[5] - headerY) < 3 && item.transform[4] > problem.transform[4] && item.transform[4] < solution.transform[4] && /^(cause|possible cause|reason)$/i.test(item.str.trim()));
        const x1 = cause ? (problem.transform[4] + cause.transform[4]) / 2 : (problem.transform[4] + solution.transform[4]) / 2;
        const x2 = cause ? (cause.transform[4] + solution.transform[4]) / 2 : x1;
        const lines = new Map<number, { symptom: string[]; action: string[] }>();
        for (const item of items) {
          const y = Math.round(item.transform[5]);
          if (y >= headerY - 3 || y < 80) continue;
          const row = lines.get(y) || { symptom: [], action: [] };
          if (item.transform[4] < x1) row.symptom.push(item.str.trim());
          else if (item.transform[4] >= x2) row.action.push(item.str.trim());
          lines.set(y, row);
        }
        let symptom = '', action = '';
        const flush = () => {
          const condition = symptom.replace(/\s+/g, ' ').trim();
          const instruction = action.replace(/\s+/g, ' ').trim();
          if (condition && instruction && /[.!?]$/.test(condition) && /[.!?]$/.test(instruction) && !/^same as above\.?$/i.test(instruction)) {
            const broad: string[] = [];
            if (/\b(leaks?|leaking|drips?|dripping)\b/i.test(condition)) broad.push('leaking');
            if (/\b(noisy|noise|rattles?|vibrat(?:es?|ion))\b/i.test(condition)) broad.push('noise');
            if (/\b(no cooling|not cooling|does not cool|will not cool)\b/i.test(condition)) broad.push('not cooling');
            if (/\b(no heat|not heating|does not heat|will not heat)\b/i.test(condition)) broad.push('not heating');
            if (/\b(no hot water|little hot water)\b/i.test(condition)) broad.push('no hot water');
            if (/\b(not draining|does not drain|will not drain)\b/i.test(condition)) broad.push('not draining');
            rules.push({ match: [condition, ...broad], steps: [`${condition} ${instruction}`], source_pages: [number] });
          }
          symptom = ''; action = '';
        };
        for (const [, line] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
          const problemText = line.symptom.join(' ');
          if (problemText && symptom && /[.!?]$/.test(symptom)) flush();
          if (problemText) symptom += ` ${problemText}`;
          if (line.action.length) action += ` ${line.action.join(' ')}`;
        }
        flush();
      }
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return rules;
}
