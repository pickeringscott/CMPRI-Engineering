import type { ManualSymptomRule } from '@/lib/manual-knowledge';

type TextItem = { str: string; transform: number[] };
type Box = { left: number; right: number; bottom: number; top: number };
type PdfPage = { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> };

/** Read rectangular cell fills only in untransformed page coordinates. */
export async function borderedTableRules(page: PdfPage, items: TextItem[], pageNumber: number, ops: { constructPath: number; transform: number; save: number; restore: number }): Promise<ManualSymptomRule[]> {
  const list = await page.getOperatorList();
  const boxes: Box[] = [];
  let transformed = false;
  const stack: boolean[] = [];
  for (let index = 0; index < list.fnArray.length; index++) {
    const op = list.fnArray[index];
    if (op === ops.save) { stack.push(transformed); continue; }
    if (op === ops.restore) { transformed = stack.pop() ?? false; continue; }
    if (op === ops.transform) { transformed = true; continue; }
    if (op !== ops.constructPath || transformed) continue;
    const args = list.argsArray[index];
    if (!Array.isArray(args) || !Array.isArray(args[1])) continue;
    for (const path of args[1] as ArrayLike<number>[]) {
      const values = Array.from(path);
      for (let i = 0; i + 12 < values.length; i++) {
        if (values[i] !== 0 || values[i + 3] !== 1 || values[i + 6] !== 1 || values[i + 9] !== 1 || values[i + 12] !== 4) continue;
        const xs = [values[i + 1], values[i + 4], values[i + 7], values[i + 10]];
        const ys = [values[i + 2], values[i + 5], values[i + 8], values[i + 11]];
        const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
        if (right - left > 20 && top - bottom > 8 && new Set(xs.map(Math.round)).size === 2 && new Set(ys.map(Math.round)).size === 2) boxes.push({ left, right, bottom, top });
        i += 12;
      }
    }
  }
  boxes.sort((a, b) => (a.right - a.left) * (a.top - a.bottom) - (b.right - b.left) * (b.top - b.bottom));
  const within = (item: TextItem, box: Box) => item.transform[4] >= box.left && item.transform[4] < box.right && item.transform[5] > box.bottom && item.transform[5] < box.top;
  const text = (box: Box) => items.filter(item => within(item, box)).sort((a,b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]).map(item => item.str.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const headers = items.filter(item => /^(?:problem|symptom|error type)$/i.test(item.str.trim()));
  const output: ManualSymptomRule[] = [];
  for (const header of headers) {
    const symptomHead = boxes.find(box => within(header, box));
    if (!symptomHead) continue;
    const actionHeader = items.find(item => /^(?:check method|solution|corrective action|remedy)$/i.test(item.str.trim()) && Math.abs(item.transform[5] - header.transform[5]) < 3 && item.transform[4] > header.transform[4]);
    const actionHead = actionHeader && boxes.find(box => within(actionHeader, box) && Math.abs(box.top - symptomHead.top) < 2 && Math.abs(box.bottom - symptomHead.bottom) < 2);
    if (!actionHead) continue;
    const causeHeader = items.find(item => /^(?:cause|possible cause|reason)$/i.test(item.str.trim()) && Math.abs(item.transform[5] - header.transform[5]) < 3 && item.transform[4] > header.transform[4] && item.transform[4] < actionHeader!.transform[4]);
    const causeHead = causeHeader && boxes.find(box => within(causeHeader, box) && Math.abs(box.top - symptomHead.top) < 2 && Math.abs(box.bottom - symptomHead.bottom) < 2);
    for (const cell of boxes.filter(box => Math.abs(box.left - symptomHead.left) < 1 && Math.abs(box.right - symptomHead.right) < 1 && box.top <= symptomHead.bottom + 1)) {
      const sameRow = (box: Box, head: Box) => Math.abs(box.left - head.left) < 1 && Math.abs(box.right - head.right) < 1 && Math.abs(box.top - cell.top) < 1 && Math.abs(box.bottom - cell.bottom) < 1;
      const actionCells = boxes.filter(box => sameRow(box, actionHead));
      const causeCells = causeHead ? boxes.filter(box => sameRow(box, causeHead)) : [];
      // Merged or subdivided cells cannot be assigned safely without their layout.
      if (actionCells.length !== 1 || (causeHead && causeCells.length !== 1)) continue;
      const condition = text(cell), cause = causeCells.length ? text(causeCells[0]) : '', action = text(actionCells[0]);
      if (!condition || !action || condition.length > 200 || action.length > 2000) continue;
      const aliases: string[] = [];
      if (/\bno hot water\b/i.test(condition)) aliases.push('no hot water');
      if (/\bno cooling\b/i.test(condition)) aliases.push('no cooling');
      if (/\bno heat(?:ing)?\b/i.test(condition)) aliases.push('no heat');
      if (/\bleak(?:s|ing|age)?\b/i.test(condition)) aliases.push('leaking');
      const numbered = action.split(/(?=\b\d+\.\s)/).map(part => part.trim()).filter(Boolean);
      const sequential = numbered.length > 1 && numbered.every((part, index) => new RegExp(`^${index + 1}\\.\\s`).test(part));
      const steps = (sequential ? numbered : [action]).map(part => [condition, cause, part].filter(Boolean).join(' — '));
      output.push({ match: [condition, ...aliases], steps, source_pages: [pageNumber] });
    }
  }
  return output;
}
