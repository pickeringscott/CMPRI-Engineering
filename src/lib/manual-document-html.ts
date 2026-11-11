/** A source-preserving semantic HTML document, shared by the guide and viewer.
 * PDF/OCR strings are always text, never trusted markup. HTML is generated only
 * from these allowlisted nodes; supplied HTML, attributes and URLs are ignored.
 */
export type ManualHtmlBlock =
  | { kind: 'heading'; text: string; lines: string[] }
  | { kind: 'paragraph'; text: string; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: { marker: string; number?: number; text: string; lines: string[] }[] }
  | { kind: 'table'; headers: string[]; rows: string[][]; lines: string[] };
export type ManualHtmlPage = { page: number; text: string; origin: 'pdf' | 'ocr' | 'reviewed'; confidence?: number; blocks: ManualHtmlBlock[] };

const listItem = /^(?:(\d+)[.)]|([•●▪*-]))\s+(.+)$/;
const tableHeader = /\b(?:problem|symptom|trouble|code|cause|action|remedy|solution|description)\b/i;
const cells = (line: string) => line.replace(/^\s*\||\|\s*$/g, '').split('|').map(value => value.trim());
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const prose = (text: string) => escape(text).replace(/\n/g, '<br>');

function heading(line: string, following: string[]): boolean {
  if (!line || line.length > 120 || line.includes('|') || listItem.test(line)) return false;
  if (/^(?:symptom|problem|(?:error|fault|diagnostic)\s+code)\s*[:\s]/i.test(line)) return true;
  if (/^(?:troubleshooting|diagnostics?|safety|warnings?|cautions?|notes?|installation|maintenance|preventive maintenance)\s*:?$/i.test(line)) return true;
  if (/[A-Z]/.test(line) && line === line.toUpperCase() && !/[.!?;]$/.test(line)) return true;
  // Short titles immediately preceding an explicit list are headings for
  // presentation only. The guide still requires its own symptom/code evidence.
  return !/[.!?;:]$/.test(line) && following.slice(0, 3).some(value => /^1[.)]\s+/.test(value));
}

export function structureManualPage(text: string, page: number, origin: 'pdf' | 'ocr' | 'reviewed' = 'pdf', confidence?: number): ManualHtmlPage {
  if (!Number.isSafeInteger(page) || page < 1 || page > 600) throw new Error('Invalid manual source page.');
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim());
  const blocks: ManualHtmlBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line) { index++; continue; }
    if (line.includes('|') && cells(line).filter(value => tableHeader.test(value)).length >= 2) {
      const headers = cells(line), rows: string[][] = [], sourceLines = [line];
      index++;
      while (index < lines.length && lines[index].includes('|') && cells(lines[index]).length === headers.length) {
        const row = cells(lines[index]); sourceLines.push(lines[index++]);
        if (!row.every(value => /^:?-{2,}:?$/.test(value))) rows.push(row);
      }
      blocks.push({ kind: 'table', headers, rows, lines: sourceLines }); continue;
    }
    const match = line.match(listItem);
    if (match) {
      const ordered = Boolean(match[1]);
      const items: Extract<ManualHtmlBlock, { kind: 'list' }>['items'] = [];
      while (index < lines.length) {
        const next = lines[index].match(listItem);
        if (!next || Boolean(next[1]) !== ordered) break;
        const item = { marker: lines[index].slice(0, lines[index].length - next[3].length).trim(), ...(next[1] ? { number: Number(next[1]) } : {}), text: next[3], lines: [lines[index++]] };
        // Join a wrapped sentence only inside its explicit list item, retaining
        // every condition. A separate completed sentence or heading stays out.
        while (index < lines.length && lines[index] && !/[.!?]$/.test(item.text) && !listItem.test(lines[index]) && !lines[index].includes('|') && !heading(lines[index], lines.slice(index + 1, index + 4))) {
          item.text += `\n${lines[index]}`; item.lines.push(lines[index++]);
        }
        items.push(item);
      }
      blocks.push({ kind: 'list', ordered, items }); continue;
    }
    blocks.push({ kind: heading(line, lines.slice(index + 1, index + 4)) ? 'heading' : 'paragraph', text: line, lines: [line] });
    index++;
  }
  return { page, text, origin: origin === 'reviewed' ? 'reviewed' : origin === 'ocr' ? 'ocr' : 'pdf', ...(Number.isFinite(confidence) ? { confidence } : {}), blocks };
}

export function structureManualDocument(text: string): ManualHtmlPage[] {
  return [...text.matchAll(/(?:^|\n\n)PAGE (\d+)\n([\s\S]*?)(?=\n\nPAGE \d+\n|$)/g)].flatMap(match => {
    const page = Number(match[1]);
    return Number.isSafeInteger(page) && page >= 1 && page <= 600 ? [structureManualPage(match[2], page)] : [];
  });
}

/** Reconstruct guide input from the semantic nodes, not arbitrary HTML. */
export function manualHtmlGuideLines(page: ManualHtmlPage): string[] {
  return page.blocks.flatMap(block => block.kind === 'list'
    ? block.items.flatMap(item => item.lines.length > 1 && /[.!?]$/.test(item.text)
      ? [`${item.marker} ${item.text.replace(/\s+/g, ' ').trim()}`] : item.lines)
    : block.lines);
}

export function manualHtmlGuideText(pages: ManualHtmlPage[]): string {
  return pages.map(page => `PAGE ${page.page}\n${manualHtmlGuideLines(page).join('\n')}`).join('\n\n');
}

/** Sanitized by construction: only fixed tags/attributes and escaped text. */
export function renderManualPageHtml(page: ManualHtmlPage): string {
  if (!Number.isSafeInteger(page.page) || page.page < 1 || page.page > 600) throw new Error('Invalid manual source page.');
  const body = page.blocks.map(block => {
    if (block.kind === 'heading') return `<h3>${prose(block.text)}</h3>`;
    if (block.kind === 'paragraph') return `<p>${prose(block.text)}</p>`;
    if (block.kind === 'table') return `<div class="manual-source-table"><table><thead><tr>${block.headers.map(value => `<th scope="col">${prose(value)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(value => `<td>${prose(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const tag = block.ordered ? 'ol' : 'ul';
    return `<${tag}>${block.items.map(item => `<li${block.ordered && Number.isSafeInteger(item.number) ? ` value="${item.number}"` : ''}>${prose(item.text)}</li>`).join('')}</${tag}>`;
  }).join('');
  return `<section data-source-page="${page.page}" data-source-origin="${page.origin === 'reviewed' ? 'reviewed' : page.origin === 'ocr' ? 'ocr' : 'pdf'}"><h2>Page ${page.page}</h2>${page.origin === 'reviewed' ? '<p>Human-reviewed text: compare with the original source page.</p>' : page.origin === 'ocr' ? '<p>OCR text: compare with the original source page.</p>' : ''}${body}</section>`;
}

/** Ignore supplied HTML and regenerate it from the source text and page ID. */
export function sourcePageHtml(text: string, page: number, origin: 'pdf' | 'ocr' | 'reviewed' = 'pdf'): string {
  return renderManualPageHtml(structureManualPage(text, page, origin));
}
