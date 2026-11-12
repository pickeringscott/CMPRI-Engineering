import type { ManualSymptomRule, ManualErrorCode } from '@/lib/manual-knowledge';
import { diagnosticTableCodes } from './pdf-diagnostic-tables';
import { manualPdfOptions } from '../manual-pdf-knowledge';
import { causeActionTableRules } from './pdf-cause-action-tables';
import { borderedTableRules } from './pdf-bordered-tables';
import { diagnosticSectionRules } from './pdf-diagnostic-sections';
import { flowchartPrerequisites } from './pdf-flowchart-notes';
import { flowchartBranches, isFlowchartTitle } from './pdf-flowchart-branches';
import { numberedSectionRules } from './pdf-numbered-sections';

type PdfTextItem = { str: string; transform: number[]; width: number };

/** Extract source-labelled rows only when PDF coordinates establish a problem/solution table. */
export async function extractPdfTroubleshootingTables(bytes: Uint8Array): Promise<ManualSymptomRule[]> {
  return (await extractPdfManualStructure(bytes)).symptom_rules;
}

export async function extractPdfManualStructure(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument(manualPdfOptions(bytes));
  const pdf = await task.promise;
  const rules: ManualSymptomRule[] = [];
  const error_codes: ManualErrorCode[] = [], warnings: string[] = [];
  try {
    if (pdf.numPages > 10000) throw new Error('The original exceeds the structure reader page budget.');
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item && !!item.str.trim());
      const codes = await diagnosticTableCodes(page, items, number, pdfjs.OPS);
      error_codes.push(...codes);
      if (!codes.length && items.some(item=>/^(?:error codes?|fault codes?)$/i.test(item.str.trim()))
        && items.some(item=>/^(?:problem|fault meaning|function|meaning|description)$/i.test(item.str.trim()))
        && items.some(item=>/^(?:action|self.diagnostic\/action|effect on system operation while)$/i.test(item.str.trim()))) warnings.push(`PDF page ${number}: diagnostic table remains a source reference; structured code extraction is incomplete.`);
      rules.push(...await causeActionTableRules(page, items, number, pdfjs.OPS));
      rules.push(...diagnosticSectionRules(items, number, page.view[2] - page.view[0]));
      rules.push(...numberedSectionRules(items, number, page.view[2] - page.view[0]));
      rules.push(...flowchartPrerequisites(items, number));
      if (items.some(item => /\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(item.str)) && items.some(item => isFlowchartTitle(item.str))) rules.push(...await flowchartBranches(page, items, number, pdfjs.OPS));
      const problems = items.filter(item => /^(problem|symptom|trouble|error type)$/i.test(item.str.trim()));
      if (problems.length && items.some(item => /^(solution|corrective action|remedy|check method)$/i.test(item.str.trim()))) {
        const bordered = await borderedTableRules(page, items, number, pdfjs.OPS);
        if (bordered.length) { rules.push(...bordered); page.cleanup(); continue; }
      }
      for (const problem of problems) {
        const headerY = problem.transform[5];
        const solution = items.find(item => Math.abs(item.transform[5] - headerY) < 3 && item.transform[4] > problem.transform[4] && /^(solution|corrective action|remedy|check method)$/i.test(item.str.trim()));
        if (!solution) continue;
        const cause = items.find(item => Math.abs(item.transform[5] - headerY) < 3 && item.transform[4] > problem.transform[4] && item.transform[4] < solution.transform[4] && /^(cause|possible cause|reason)$/i.test(item.str.trim()));
        const x1 = cause ? (problem.transform[4] + cause.transform[4]) / 2 : (problem.transform[4] + solution.transform[4]) / 2;
        const x2 = cause ? (cause.transform[4] + solution.transform[4]) / 2 : x1;
        const lines = new Map<number, { symptom: string[]; cause: string[]; action: string[] }>();
        for (const item of items) {
          const y = Math.round(item.transform[5]);
          if (y >= headerY - 3 || y < 80) continue;
          const row = lines.get(y) || { symptom: [], cause: [], action: [] };
          if (item.transform[4] < x1) row.symptom.push(item.str.trim());
          else if (item.transform[4] >= x2) row.action.push(item.str.trim());
          else if (cause) row.cause.push(item.str.trim());
          lines.set(y, row);
        }
        let symptom = '', causeText = '', action = '';
        const flush = () => {
          const condition = symptom.replace(/\s+/g, ' ').trim();
          const instruction = action.replace(/\s+/g, ' ').trim();
          if (condition && instruction && /[.!?]$/.test(condition) && /[.!?]$/.test(instruction) && !/^same as above\.?$/i.test(instruction)) {
            const broad: string[] = [];
            const qualified = /\b(?:when|while|during|after|before|only|unless|if|with|without)\b/i.test(condition);
            if (!qualified && /\b(leaks?|leaking|drips?|dripping)\b/i.test(condition)) broad.push('leaking');
            if (/\b(noisy|noise|rattles?|vibrat(?:es?|ion))\b/i.test(condition)) broad.push('noise');
            if (/\b(no cooling|not cooling|does not cool|will not cool)\b/i.test(condition)) broad.push('not cooling');
            if (/\b(no heat|not heating|does not heat|will not heat)\b/i.test(condition)) broad.push('not heating');
            if (/\b(no hot water|little hot water)\b/i.test(condition)) broad.push('no hot water');
            if (/\b(not draining|does not drain|will not drain)\b/i.test(condition)) broad.push('not draining');
            rules.push({ match: [condition, ...(!qualified ? broad : [])], steps: [[condition, causeText.trim() ? `Possible cause: ${causeText.trim()}` : '', instruction].filter(Boolean).join(' — ')], source_pages: [number] });
          }
          symptom = ''; causeText = ''; action = '';
        };
        for (const [, line] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
          const problemText = line.symptom.join(' ');
          if (problemText && symptom && /[.!?]$/.test(symptom)) flush();
          if (problemText) symptom += ` ${problemText}`;
          if (line.cause.length) causeText += ` ${line.cause.join(' ')}`;
          if (line.action.length) action += ` ${line.action.join(' ')}`;
        }
        flush();
      }
      page.cleanup();
    }
  } finally { await task.destroy(); }
  return { symptom_rules: rules, error_codes, warnings };
}

