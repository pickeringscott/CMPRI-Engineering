import type { ManualSymptomRule } from '@/lib/manual-knowledge';

type Item = { str: string; transform: number[]; width?: number; fontName?: string };
type Box = { left: number; right: number; bottom: number; top: number };
type Page = { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> };
type Ops = { constructPath: number; transform: number; save: number; restore: number };
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
const complete = (s: string) => !!s && /[.!?]$/.test(s);
const text = (items: Item[]) => clean([...items].sort((a,b) => Math.round(b.transform[5]) - Math.round(a.transform[5]) || a.transform[4] - b.transform[4]).map(x => x.str).join(' '));

/** Two-column cause/remedy tables require a symptom section and a closed geometric grid.
 * No inferred row boundaries, page continuation, diagnostic aliases, or flowchart traversal.
 * PDF.js 6 encodes filled rectangular rules as move/line/close paths.
 */
export async function causeActionTableRules(page: Page, items: Item[], pageNumber: number, ops: Ops): Promise<ManualSymptomRule[]> {
  const heads = items.filter(i => /^POSSIBLE CAUSE$/i.test(i.str.trim()));
  if (!heads.length) return [];
  const operators = await page.getOperatorList();
  const boxes: Box[] = []; const stack: boolean[] = []; let transformed = false;
  for (let n = 0; n < operators.fnArray.length; n++) {
    const op = operators.fnArray[n];
    if (op === ops.save) { stack.push(transformed); continue; }
    if (op === ops.restore) { transformed = stack.pop() ?? false; continue; }
    if (op === ops.transform) { transformed = true; continue; }
    const args = operators.argsArray[n];
    if (op !== ops.constructPath || transformed || !Array.isArray(args) || !Array.isArray(args[1])) continue;
    for (const path of args[1] as ArrayLike<number>[]) {
      const v = Array.from(path);
      // Accept only one closed axis-aligned rectangle, not a bounding box of arbitrary art.
      if (v.length !== 13 || v[0] !== 0 || v[3] !== 1 || v[6] !== 1 || v[9] !== 1 || v[12] !== 4) continue;
      const xs = [v[1],v[4],v[7],v[10]], ys = [v[2],v[5],v[8],v[11]];
      if (new Set(xs).size !== 2 || new Set(ys).size !== 2 || xs.some((x,i) => x !== xs[(i+1)%4] && ys[i] !== ys[(i+1)%4])) continue;
      boxes.push({left:Math.min(...xs),right:Math.max(...xs),bottom:Math.min(...ys),top:Math.max(...ys)});
    }
  }
  const inside = (i: Item,b: Box) => i.transform[4] >= b.left-0.5 && i.transform[4] < b.right && i.transform[5] > b.bottom && i.transform[5] < b.top;
  const lines = new Map<number, Item[]>();
  for (const i of items.filter(i=>i.str.trim())) { const y=Math.round(i.transform[5]); lines.set(y,[...(lines.get(y)||[]),i]); }
  const ordered = [...lines].sort((a,b)=>b[0]-a[0]).map(([y,parts])=>({y,parts,value:text(parts)}));
  const numberedHeading = /^\d+[.)]\s+[A-Z][A-Z0-9 /(),’'\-]+$/;
  const symptom = /\b(?:NO|NOT|CANNOT|ERRORS?|FAULT(?:ING)?|MALFUNCTION|EXCESSIVE|LOW|HIGH|LEAK(?:ING)?|FAIL(?:URE|S)?|STOPPED|ABORTED)\b/i;
  const output: ManualSymptomRule[] = [];
  for (const head of heads) {
    const action = items.filter(i=>/^TO CORRECT$/i.test(i.str.trim()) && Math.abs(i.transform[5]-head.transform[5])<2 && i.transform[4]>head.transform[4]);
    if (action.length !== 1) continue;
    const lefts = boxes.filter(b=>b.right-b.left>50 && b.top-b.bottom>8 && b.top-b.bottom<40 && inside(head,b));
    const rights = boxes.filter(b=>b.right-b.left>50 && b.top-b.bottom>8 && b.top-b.bottom<40 && inside(action[0],b));
    if (lefts.length!==1 || rights.length!==1) continue;
    const l=lefts[0], r=rights[0];
    if (Math.abs(l.right-r.left)>1 || Math.abs(l.top-r.top)>1 || Math.abs(l.bottom-r.bottom)>1) continue;
    // Select the nearest heading, never a distant heading above another section/table.
    const above = ordered.filter(line=>line.y>l.top && numberedHeading.test(line.value));
    const heading=above.at(-1);
    if (!heading || !symptom.test(heading.value) || heading.y-l.top>180) continue;
    const pre = ordered.filter(line=>line.y<heading.y && line.y>l.top);
    if (pre.some(line=>/continued|POSSIBLE CAUSE|TO CORRECT/i.test(line.value))) continue;
    const preamble=text(pre.flatMap(x=>x.parts));
    if (preamble && !complete(preamble)) continue;
    const vertical = boxes.filter(b=>b.right-b.left<1.5 && b.top>=l.top-1 && b.bottom<l.bottom-8);
    const edges = [l.left,l.right,r.right].map(x=>vertical.filter(b=>Math.abs((b.left+b.right)/2-x)<1));
    if (edges.some(e=>e.length!==1)) continue;
    const bottom=Math.max(edges[0][0].bottom,edges[2][0].bottom);
    if (Math.abs(edges[0][0].bottom-edges[2][0].bottom)>1 || bottom<50) continue;
    const horizontal = boxes.filter(b=>b.top-b.bottom<1.5 && Math.abs(b.left-l.left)<1 && Math.abs(b.right-r.right)<1 && b.bottom>=bottom-1 && b.top<=l.bottom+1);
    const ys=[...new Set(horizontal.map(b=>Math.round((b.top+b.bottom)/2)))].sort((a,b)=>b-a);
    if (ys.length<2 || Math.abs(ys[0]-l.bottom)>1 || Math.abs(ys.at(-1)!-bottom)>1) continue;
    const steps:string[]=[]; let valid=true;
    for(let n=0;n<ys.length-1;n++) {
      const row=items.filter(i=>inside(i,{left:l.left,right:r.right,top:ys[n],bottom:ys[n+1]}));
      const merged=edges[1][0].bottom>=ys[n]-1;
      if(merged) {
        const note=text(row);
        if(n!==ys.length-2 || !complete(note) || !/^(?:NOTE:|WARNING:|CAUTION:|DANGER:|IMPORTANT:|If\b)/i.test(note)) {valid=false;break;}
        steps.push(note); continue;
      }
      if(edges[1][0].bottom>ys[n+1]+1 || row.some(i=>i.width===undefined || i.transform[4]+i.width>(i.transform[4]<l.right?l.right:r.right)+0.5)) {valid=false;break;}
      const cause=text(row.filter(i=>i.transform[4]<l.right)), correction=text(row.filter(i=>i.transform[4]>=l.right));
      if(!complete(cause)||!complete(correction)||/\b(?:continued|same as above)\b/i.test(cause+' '+correction)) {valid=false;break;}
      steps.push(`Possible cause: ${cause} To correct: ${correction}`);
    }
    if(!valid || !steps.length) continue;
    // Keep all trailing prose, including unlabelled safety qualifications and font changes.
    // Only explicit next sections or typographically distinct diagram captions end context.
    const after:string[]=[];
    const bodySize = Math.hypot(head.transform[0],head.transform[1]);
    for(const line of ordered.filter(line=>line.y<bottom && line.y>50)) {
      if(numberedHeading.test(line.value) || /^(?:POSSIBLE CAUSE|TO CORRECT|\(Continued\))/i.test(line.value)) { if(/continued/i.test(line.value)) valid=false; break; }
      const caption = !/[.!?:]$/.test(line.value) && /\b(?:diagram|schematic|terminal connection)\b/i.test(line.value)
        && !/\b(?:do not|never|must|warning|caution|danger|before|after|only|unless)\b/i.test(line.value)
        && Math.hypot(line.parts[0].transform[0],line.parts[0].transform[1]) > bodySize * 1.1;
      if(caption) break;
      after.push(line.value);
    }
    const post=clean(after.join(' '));
    if(!valid || (post&&!complete(post))) continue;
    const context=[heading.value,preamble,post].filter(Boolean).join(' — ');
    const match=heading.value.replace(/^\d+[.)]\s+/,'').replace(/\s+(?:ANALYSIS|TROUBLESHOOTING)$/i,'');
    output.push({match:[match],steps:steps.map(step=>`${context} — ${step}`),source_pages:[pageNumber]});
  }
  return output;
}
