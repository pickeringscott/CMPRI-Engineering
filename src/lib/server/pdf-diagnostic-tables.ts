import type { ManualErrorCode } from '../manual-knowledge';
import { horizontalBounds, pdfSegments, verticalBounds } from './pdf-table-geometry';

type Item = { str: string; transform: number[]; width: number };
type Page = Parameters<typeof pdfSegments>[0];
type Ops = Parameters<typeof pdfSegments>[1];
const codeValue=/^(?:[A-Z]{0,4}[- ]?\d{1,4}[A-Z0-9-]{0,6})$/i;
const clean=(s:string)=>s.replace(/\s+/g,' ').replace(/\s+([.,;:!?])/g,'$1').trim();
const read=(items:Item[])=>clean([...items].sort((a,b)=>Math.round(b.transform[5])-Math.round(a.transform[5]) || a.transform[4]-b.transform[4]).map(i=>i.str).join(' '));

/** Extract code/meaning/response/action cells only when the source grid establishes their bounds. */
export async function diagnosticTableCodes(page: Page, items: Item[], pageNumber: number, ops: Ops): Promise<ManualErrorCode[]> {
  const headings=items.filter(i=>/^(?:error\s+code|fault\s+code|code)$/i.test(i.str.trim()));
  if(!headings.length)return [];
  const segments=await pdfSegments(page,ops), output:ManualErrorCode[]=[];
  for(const head of headings){
    const y=head.transform[5], center=head.transform[4]+head.width/2;
    if (/^code$/i.test(head.str.trim()) && items.some(i=>/^sub$/i.test(i.str.trim()) && Math.abs(i.transform[4]-head.transform[4])<5 && i.transform[5]>y && i.transform[5]-y<20)) continue;
    const left=verticalBounds(segments,center,y);
    if(!left)continue;
    const meaningHead=items.find(i=>i.transform[4]>left.right && Math.abs(i.transform[5]-y)<20 && /^(?:problem|fault meaning|function|meaning|description)$/i.test(i.str.trim()));
    const actionHead=items.find(i=>i.transform[4]>left.right && Math.abs(i.transform[5]-y)<20 && /^(?:action|self.diagnostic\s*\/\s*action|corrective action|remedy|solution|effect on system operation while)$/i.test(i.str.trim()));
    if(!meaningHead||!actionHead)continue;
    const meaning=verticalBounds(segments,meaningHead.transform[4]+meaningHead.width/2,meaningHead.transform[5]);
    const action=verticalBounds(segments,actionHead.transform[4]+actionHead.width/2,actionHead.transform[5]);
    const header=horizontalBounds(segments,center,y);
    if(!meaning||!action||!header||meaning.right>action.left+1)continue;
    const codes=items.filter(i=>i.transform[4]>=left.left && i.transform[4]+i.width<=left.right+1 && i.transform[5]<header.bottom && codeValue.test(i.str.trim()));
    for(const code of codes){
      const cell=horizontalBounds(segments,center,code.transform[5]);
      if(!cell||cell.top>header.bottom+1||cell.bottom<20)continue;
      if(codes.filter(i=>i.transform[5]>cell.bottom&&i.transform[5]<cell.top).length!==1)continue;
      const inside=items.filter(i=>i.transform[5]>cell.bottom&&i.transform[5]<cell.top);
      const problem=read(inside.filter(i=>i.transform[4]>=meaning.left-0.5&&i.transform[4]+i.width<=meaning.right+1));
      const instruction=read(inside.filter(i=>i.transform[4]>=action.left-0.5&&i.transform[4]+i.width<=action.right+1));
      if(!problem||!instruction)continue;
      const completeAction=!instruction.startsWith('*') || instruction.split(/(?=\*)/).filter(Boolean).every(part=>/[.!?]$/.test(part.trim()));
      // Preserve subcodes with their own bounded meaning/action cells, never merge their remedies.
      const subHead=items.find(i=>/^sub$/i.test(i.str.trim())&&i.transform[4]>left.right&&i.transform[4]<meaning.left&&Math.abs(i.transform[5]-y)<20);
      const sub=subHead&&verticalBounds(segments,subHead.transform[4]+subHead.width/2,subHead.transform[5]);
      const variants=sub?inside.filter(i=>i.transform[4]>=sub.left&&i.transform[4]<sub.right&&/^\d+$/.test(i.str.trim())):[];
      if(variants.length>1){
        for(const variant of variants){
          const bounds=horizontalBounds(segments,(meaning.left+meaning.right)/2,variant.transform[5]);
          if(!bounds||bounds.top>cell.top+1||bounds.bottom<cell.bottom-1)continue;
          const row=inside.filter(i=>i.transform[5]>bounds.bottom&&i.transform[5]<bounds.top);
          const p=read(row.filter(i=>i.transform[4]>=meaning.left-0.5&&i.transform[4]+i.width<=meaning.right+1));
          const a=read(row.filter(i=>i.transform[4]>=action.left-0.5&&i.transform[4]+i.width<=action.right+1));
          if(p&&a)output.push({code:code.str.trim(),subcode:variant.str.trim(),problem:p,action:a.startsWith('*')&&!a.split(/(?=\*)/).filter(Boolean).every(part=>/[.!?]$/.test(part.trim()))?'':a,source_pages:[pageNumber]});
        }
      }else{
        const response=/^effect\b/i.test(actionHead.str) || /^(?:(?:the )?unit\b|the compressor\b|if (?:the )?(?:unit|indoor coil)\b|occurs if\b)/i.test(instruction);
        output.push({code:code.str.trim(),...(variants[0]?{subcode:variants[0].str.trim()}:{}),problem,action:response||!completeAction?'':instruction,...(response?{unit_response:instruction}:{}),source_pages:[pageNumber]});
      }
    }
  }
  return [...new Map(output.map(entry=>[JSON.stringify(entry),entry])).values()];
}
