import type { ManualSymptomRule } from '@/lib/manual-knowledge';

type Item = { str: string; transform: number[] };
type Box = { left: number; right: number; bottom: number; top: number; text: string };
type Point = [number, number];
type Matrix = [number, number, number, number, number, number];
type Page = { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> };
type Operators = { save: number; restore: number; transform: number; constructPath: number };

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}

/** Identify a short symptom heading in a source-labelled diagnostic chart. */
export function isFlowchartTitle(value: string): boolean {
  const text = value.trim();
  return text.length >= 5 && text.length <= 90 && !/[.!?;:]$/.test(text)
    && /^(?:(?:no|low|high|insufficient|excessive|intermittent|poor|slow|abnormal)\s+\S.+|.+\s+(?:not|does not|will not|cannot|won't|can't)\s+\S.+|.+\s+(?:leaks|leaking|fails|stuck|noisy|blocked|jammed|broken))$/i.test(text);
}

/** Recover only directly connected, explicitly labelled horizontal chart branches. */
export async function flowchartBranches(page: Page, items: Item[], pageNumber: number, ops: Operators): Promise<ManualSymptomRule[]> {
  const chartHeader = items.find(item => /\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(item.str));
  if (!chartHeader) return [];
  const nearbySizes = items.filter(item => item.transform[5] < chartHeader.transform[5] && chartHeader.transform[5] - item.transform[5] < 300)
    .map(item => Math.hypot(item.transform[0], item.transform[1])).filter(size => size > 0).sort((a,b) => a-b);
  const bodySize = nearbySizes[Math.floor(nearbySizes.length / 2)] || 0;
  const titles = items.filter(item => {
    const text = item.str.trim();
    const titleSize = Math.hypot(item.transform[0], item.transform[1]);
    return isFlowchartTitle(text) && item.transform[5] < chartHeader.transform[5] && chartHeader.transform[5] - item.transform[5] < 180
      && (text === text.toUpperCase() || (bodySize > 0 && titleSize >= bodySize * 1.25));
  });
  if (titles.length !== 1) return [];
  const title = titles[0].str.trim();
  // Short subtitle lines immediately under the chart heading identify the
  // source's equipment/model scope and must travel with its branches.
  const caption = items.filter(item => item.str.trim() && item.transform[5] < chartHeader.transform[5] - 2 && item.transform[5] > titles[0].transform[5] + 2 && chartHeader.transform[5] - item.transform[5] < 35)
    .sort((a,b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]).map(item => item.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
  const list = await page.getOperatorList();
  let matrix: Matrix = [1,0,0,1,0,0]; const stack: Matrix[] = [];
  const boxes: Box[] = [], segments: [Point, Point][] = [];
  const point = (x: number, y: number): Point => [matrix[0]*x+matrix[2]*y+matrix[4], matrix[1]*x+matrix[3]*y+matrix[5]];
  for (let index = 0; index < list.fnArray.length; index++) {
    const op = list.fnArray[index], args = list.argsArray[index];
    if (op === ops.save) { stack.push(matrix); continue; }
    if (op === ops.restore) { matrix = stack.pop() || [1,0,0,1,0,0]; continue; }
    if (op === ops.transform) { if (Array.isArray(args) && args.length === 6 && args.every(value => typeof value === 'number')) matrix = multiply(matrix, args as Matrix); continue; }
    if (op !== ops.constructPath || !Array.isArray(args) || !Array.isArray(args[1])) continue;
    for (const raw of args[1] as ArrayLike<number>[]) {
      const values = Array.from(raw); let cursor = 0, current: Point | null = null, start: Point | null = null, points: Point[] = [];
      while (cursor < values.length) {
        const code = values[cursor++];
        if (code === 0 || code === 1) {
          if (cursor + 1 >= values.length) break;
          const next = point(values[cursor++], values[cursor++]);
          if (code === 0) { current = next; start = next; points = [next]; }
          else { if (current) segments.push([current, next]); current = next; points.push(next); }
        } else if (code === 4) {
          if (points.length === 4) {
            const xs = points.map(value => value[0]), ys = points.map(value => value[1]);
            const box: Box = { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys), text: '' };
            if (box.right-box.left > 30 && box.right-box.left < 300 && box.top-box.bottom > 10 && box.top-box.bottom < 100 && new Set(xs.map(Math.round)).size === 2 && new Set(ys.map(Math.round)).size === 2 && !boxes.some(existing => Math.abs(existing.left-box.left)<2 && Math.abs(existing.right-box.right)<2 && Math.abs(existing.top-box.top)<2 && Math.abs(existing.bottom-box.bottom)<2)) boxes.push(box);
          }
          if (current && start) segments.push([current, start]); current = null; start = null; points = [];
        } else if (code === 2) cursor += 6;
        else if (code === 3) cursor += 4;
        else break;
      }
    }
  }
  for (const box of boxes) box.text = items.filter(item => item.str.trim() && item.transform[4] >= box.left-1 && item.transform[4] <= box.right+1 && item.transform[5] >= box.bottom-1 && item.transform[5] <= box.top+1)
    .sort((a,b) => b.transform[5]-a.transform[5] || a.transform[4]-b.transform[4]).map(item => item.str.trim()).join(' ').replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
  const populated = boxes.filter(box => box.text && box.text.length < 500);
  const steps = new Map<string, { label: string; top: number; left: number }>();
  const record = (from: Box, to: Box, answer: string) => {
    const label = [caption, title, from.text, `${answer}: ${to.text}`].filter(Boolean).join(' — ');
    if (!steps.has(label)) steps.set(label, { label, top: from.top, left: from.left });
  };
  for (const from of populated) for (const to of populated) {
    if (from === to || /\?$/.test(to.text) || to.left <= from.right || to.left-from.right > 50) continue;
    const bottom = Math.max(from.bottom, to.bottom), top = Math.min(from.top, to.top);
    if (top-bottom < 5) continue;
    const labels = items.filter(item => /^(yes|no)$/i.test(item.str.trim()) && item.transform[4] >= from.right-4 && item.transform[4] <= to.left+4 && item.transform[5] >= bottom-12 && item.transform[5] <= top+8);
    if (labels.length !== 1) continue;
    const connected = segments.some(([a,b]) => Math.abs(a[1]-b[1]) < 1 && a[1] >= bottom-2 && a[1] <= top+2 && ((Math.abs(a[0]-from.right)<3 && Math.abs(b[0]-to.left)<3) || (Math.abs(b[0]-from.right)<3 && Math.abs(a[0]-to.left)<3)));
    if (connected) record(from, to, labels[0].str.trim());
  }
  for (const from of populated) for (const to of populated) {
    if (from === to || to.top >= from.bottom || from.bottom-to.top > 50 || titles[0].transform[5] <= from.top) continue;
    const left = Math.max(from.left, to.left), right = Math.min(from.right, to.right);
    if (right-left < 5) continue;
    for (const [a,b] of segments) {
      const x = a[0];
      if (Math.abs(a[0]-b[0]) >= 1 || x < left-2 || x > right+2 || Math.max(a[1],b[1]) < from.bottom-3 || Math.min(a[1],b[1]) > to.top+3) continue;
      const labels = items.filter(item => /^(yes|no)$/i.test(item.str.trim()) && Math.abs(item.transform[4]-x) < 18 && item.transform[5] >= to.top-1 && item.transform[5] < from.bottom-1);
      if (labels.length !== 1) continue;
      const intervening = populated.some(box => box !== from && box !== to && box.bottom >= to.top-2 && box.top <= from.bottom+2 && box.left < x && box.right > x);
      if (!intervening) record(from, to, labels[0].str.trim());
    }
  }
  if (!steps.size) return [];
  const match = [title];
  if (/\bno cooling\b/i.test(title)) match.push('not cooling');
  if (/\bno heat(?:ing)?\b/i.test(title)) match.push('not heating');
  const degree = title.match(/^(low|high|poor|slow)\s+(.+)$/i);
  if (degree) match.push(`${degree[2]} ${degree[1]}`, `${degree[2]} is ${degree[1]}`, `${degree[2]} too ${degree[1]}`, `${degree[2]} is too ${degree[1]}`);
  return [{ match, steps: [...steps.values()].sort((a,b) => b.top-a.top || a.left-b.left).map(step => step.label), source_pages: [pageNumber] }];
}
