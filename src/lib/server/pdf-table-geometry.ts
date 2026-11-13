type Matrix = [number, number, number, number, number, number];
export type PdfSegment = { x1: number; y1: number; x2: number; y2: number };
type Ops = { save: number; restore: number; transform: number; constructPath: number };
type Page = { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> };

/** Keep PDF coordinates, including transforms, so table cells never depend on text order. */
export async function pdfSegments(page: Page, ops: Ops): Promise<PdfSegment[]> {
  const list = await page.getOperatorList();
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [], output: PdfSegment[] = [];
  const point = (x: number, y: number) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
  const add = (a: number[], b: number[]) => output.push({ x1:a[0], y1:a[1], x2:b[0], y2:b[1] });
  for (let i=0;i<list.fnArray.length;i++) {
    const op=list.fnArray[i], args=list.argsArray[i];
    if (op===ops.save) { stack.push([...m]); continue; }
    if (op===ops.restore) { m=stack.pop() || [1,0,0,1,0,0]; continue; }
    if (op===ops.transform && Array.isArray(args) && args.length===6) {
      const [a,b,c,d,e,f]=args as number[];
      m=[m[0]*a+m[2]*b,m[1]*a+m[3]*b,m[0]*c+m[2]*d,m[1]*c+m[3]*d,m[0]*e+m[2]*f+m[4],m[1]*e+m[3]*f+m[5]]; continue;
    }
    if (op!==ops.constructPath || !Array.isArray(args) || !Array.isArray(args[1])) continue;
    for (const raw of args[1] as ArrayLike<number>[]) {
      const v=Array.from(raw); let cursor=0, current:number[]|null=null, start:number[]|null=null;
      while (cursor<v.length) {
        const code=v[cursor++];
        if (code===0 || code===1) {
          const next=point(v[cursor++],v[cursor++]);
          if (code===0) start=next; else if (current) add(current,next);
          current=next;
        } else if (code===4) { if(current&&start)add(current,start);current=start; }
        else if (code===2) { cursor+=6; current=null; }
        else if (code===3) { cursor+=4; current=null; }
        else break;
      }
    }
  }
  return output.filter(s=>Object.values(s).every(Number.isFinite));
}

export function horizontalBounds(segments: PdfSegment[], x: number, y: number) {
  const levels=[...new Set(segments.filter(s=>Math.abs(s.y2-s.y1)<0.8 && Math.min(s.x1,s.x2)<x && Math.max(s.x1,s.x2)>x)
    .map(s=>Math.round((s.y1+s.y2)*5)/10))].sort((a,b)=>a-b);
  const bottom=levels.filter(value=>value<y).at(-1), top=levels.find(value=>value>y);
  return bottom!==undefined && top!==undefined ? {bottom,top} : null;
}

export function verticalBounds(segments: PdfSegment[], x: number, y: number) {
  const levels=[...new Set(segments.filter(s=>Math.abs(s.x2-s.x1)<0.8 && Math.min(s.y1,s.y2)<y && Math.max(s.y1,s.y2)>y)
    .map(s=>Math.round((s.x1+s.x2)*5)/10))].sort((a,b)=>a-b);
  const left=levels.filter(value=>value<x).at(-1), right=levels.find(value=>value>x);
  return left!==undefined && right!==undefined ? {left,right} : null;
}
