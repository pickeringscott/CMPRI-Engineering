import type { ManualErrorCode, ManualSymptomRule } from './manual-knowledge';

// This parser extracts explicit source structures. It does not supply repair
// knowledge, infer symptoms from equipment identity, or interpret table layout.
const imperative = /^(?:check|inspect|verify|clean|disconnect|connect|reconnect|unplug|turn|remove|replace|test|measure|record|confirm|ensure|clear|tighten|loosen|restart|reset|open|close|adjust|set|use|drain|fill|isolate|stop|allow|wait|contact|observe|listen|press|hold|release|restore|repair|flush|lubricate|make sure|do not)\b/i;
const actionPrefix = /^(?:action|remedy|corrective action|solution)\s*:\s*(.+)$/i;
const listPrefix = /^(?:\d+[.)]|[•●▪*-])\s+(.+)$/;
const codeHeading = /^(?:error|fault|diagnostic)\s+code\s+([a-z]{0,4}[- ]?\d{1,4}[a-z0-9-]{0,6})(?:\s*[:—-]\s*(.+))?$/i;
type Context = { symptom: string; actions: string[] } | { code: string; problem: string; actions: string[] };
type Table = { columns: number; symptom: number; action: number; code: number };

function action(value: string): string | null {
  const text = value.trim();
  // A PDF line can end in the middle of a safety condition. Without an
  // explicit sentence ending, leave it in the original excerpt for review.
  return imperative.test(text) && /[.!?]$/.test(text) ? text : null;
}

function cells(line: string): string[] | null {
  if (!line.includes('|')) return null;
  return line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim());
}

/**
 * Extract only explicitly associated, verbatim manual actions. The caller must
 * authorize and verify the attached PDF before treating this as trusted data.
 * Unstructured or ambiguous excerpts remain references, rather than checkboxes.
 */
export function uploadedManualActions(text: string): { symptom_rules: ManualSymptomRule[]; error_codes: ManualErrorCode[] } {
  const symptom_rules: ManualSymptomRule[] = [];
  const error_codes: ManualErrorCode[] = [];
  const pages = [...text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)];
  for (const page of pages) {
    const number = Number(page[1]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    let context: Context | null = null;
    let table: Table | null = null;
    let pendingAction = false;
    const flush = () => {
      if (context?.actions.length) {
        const actions = [...new Set(context.actions)];
        if ('symptom' in context) symptom_rules.push({ match: [context.symptom], steps: actions, source_pages: [number] });
        else error_codes.push({ code: context.code, problem: context.problem, action: actions.join('\n'), source_pages: [number] });
      }
      context = null;
      pendingAction = false;
    };
    for (const raw of page[2].split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const row = cells(line);
      if (row) {
        flush();
        const headings = row.map(cell => cell.toLowerCase());
        const actionColumn = headings.findIndex(cell => /^(?:corrective action|action|remedy|solution)$/.test(cell));
        const symptomColumn = headings.findIndex(cell => /^(?:problem|symptom|trouble|fault|description)$/.test(cell));
        const codeColumn = headings.findIndex(cell => /^(?:code|error code|fault code|diagnostic code)$/.test(cell));
        if (actionColumn >= 0 && (symptomColumn >= 0 || codeColumn >= 0)) {
          table = { columns: row.length, symptom: symptomColumn, action: actionColumn, code: codeColumn };
          continue;
        }
        if (row.every(cell => /^:?-{2,}:?$/.test(cell))) continue;
        if (!table || row.length !== table.columns) { table = null; continue; }
        const step = action(row[table.action]);
        if (!step) continue;
        if (table.code >= 0) {
          const code = row[table.code];
          if (!/^(?!(?:room|page|table|figure)\b)[a-z]{0,4}[- ]?\d{1,4}[a-z0-9-]{0,6}$/i.test(code)) continue;
          error_codes.push({ code, problem: table.symptom >= 0 ? row[table.symptom] : '', action: step, source_pages: [number] });
        } else {
          const symptom = row[table.symptom];
          if (symptom) symptom_rules.push({ match: [symptom], steps: [step], source_pages: [number] });
        }
        continue;
      }
      table = null;
      const symptom = line.match(/^(?:symptom|problem)\s*:\s*(.+)$/i);
      const code = line.match(codeHeading);
      if (symptom || code) {
        flush();
        context = symptom ? { symptom: symptom[1].trim(), actions: [] } : { code: code![1], problem: code![2]?.trim() || '', actions: [] };
        continue;
      }
      if (!context) continue;
      const labelled = line.match(actionPrefix) || line.match(listPrefix);
      if (labelled) {
        const step = action(labelled[1]);
        pendingAction = Boolean(step);
        if (step) context.actions.push(step);
        // A non-action list item cannot inherit a preceding instruction.
        continue;
      }
      if (/^(?:possible cause|cause|reason|description)\s*:/i.test(line)) { pendingAction = false; continue; }
      if (/^(?:preventive maintenance|maintenance|specifications|installation|safety|notes|references)\s*:?$/i.test(line)) { flush(); continue; }
      // An unrecognized section/prose line ends the association. We do not
      // guess whether it continues the preceding action and qualifies it.
      if (pendingAction) context.actions.pop();
      flush();
    }
    flush();
  }
  return { symptom_rules, error_codes };
}
