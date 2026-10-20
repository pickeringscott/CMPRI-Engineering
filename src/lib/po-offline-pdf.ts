import type {EvidenceLine, ImportPlan, OrderEvidence} from './po-evidence';
import {planPoEvidence} from './po-evidence';

export type PdfCell={text:string;x:number;y:number};
export type OfflinePo={externalPo:string;supplier:string;acceptedAt:string;subject:string;lines:EvidenceLine[];subtotalCents:number;totalCents:number};
const clean=(s:string)=>s.replace(/\s+/g,' ').trim();
const cents=(s:string)=>/^\$[\d,]+\.\d{2}$/.test(s)?Math.round(Number(s.replace(/[$,]/g,''))*100):NaN;

/** The iBuy Offline table: keep Item # and Description in separate PDF columns.
 * Unknown layouts, incomplete rows and inconsistent totals remain review-only.
 * No URL is fetched and no stock/receipt quantities are inferred.
 */
export function parseOfflinePoPages(pages:PdfCell[][]):OfflinePo|null{
 const flat=pages.flat(),text=flat.map(c=>c.text).join(' ');
 const ids=[...text.matchAll(/Purchase Order #(\d+)/g)].map(m=>m[1]);
 if(!ids.length||new Set(ids).size!==1||!/\bPO Type:\s+Offline\b/.test(text))return null;
 const acceptedAt=text.match(/\bAccepted (\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M)\b/)?.[1];
 const supplierIndex=flat.findIndex(c=>c.text==='Supplier'),subjectIndex=flat.findIndex(c=>c.text==='Subject:');
 const supplier=flat[supplierIndex+1]?.text,subject=flat[subjectIndex+1]?.text;
 if(!acceptedAt||supplierIndex<0||subjectIndex<0||!supplier||!subject)return null;
 const rows:string[][]=[];
 for(const page of pages){
  const start=page.findIndex(c=>c.text==='#');
  if(start<0)return null;
  const headers=page.slice(start,start+8);
  if(headers.map(c=>c.text).join('|')!=='#|Qty|UOM|Item #|Description|GL Code|Price|Total')return null;
  // This source's fixed-width iBuy template. Reject shifted/reflowed layouts.
  const expected=[59.25,80.75,106.5,147.7,272.525,430.7625,500.775,534.875];
  if(headers.some((c,i)=>Math.abs(c.x-expected[i])>2))return null;
  let row:string[]|null=null;
  for(const cell of page.slice(start+8)){
   if(cell.text==='Subtotal'||cell.text.startsWith('Document Transmitted:')||/^Page \d+ of \d+$/.test(cell.text))break;
   if(cell.y>=headers[0].y)continue;
   const col=[72.5,101.5,131.5,188,400,492,527,562].findIndex(edge=>cell.x<edge);
   if(col<0)return null;
   if(col===0){
    if(!/^\d+$/.test(cell.text))return null;
    row=Array(8).fill('');rows.push(row);
   }
   if(!row)return null;
   row[col]=clean(`${row[col]} ${cell.text}`);
  }
 }
 const lines:EvidenceLine[]=[];
 for(const [index,row] of rows.entries()){
  const quantity=Number(row[1]),price=cents(row[6]),extended=cents(row[7]);
  if(Number(row[0])!==index+1||!/^\d+(?:\.\d{1,3})?$/.test(row[1])||quantity<=0||!row[2]||!row[3]||!row[4]||!row[5]||!Number.isSafeInteger(price)||Math.round(quantity*price)!==extended)return null;
  lines.push({sku:row[3],description:row[4],quantity,uom:row[2],unitPriceCents:price});
 }
 const total=(label:string)=>{const matches=flat.filter(c=>c.text===label);if(matches.length!==1)return NaN;const i=flat.indexOf(matches[0]);return cents(flat[i+1]?.text||'');};
 const subtotalCents=total('Subtotal'),discount=total('Discount'),tax=total('Taxes'),shipping=total('Shipping'),totalCents=total('Grand Total');
 if(!lines.length||new Set(lines.map(l=>l.sku)).size!==lines.length||![subtotalCents,discount,tax,shipping,totalCents].every(Number.isSafeInteger)||lines.reduce((sum,l)=>sum+Math.round(l.quantity*l.unitPriceCents!),0)!==subtotalCents||subtotalCents-discount+tax+shipping!==totalCents)return null;
 return {externalPo:ids[0],supplier,acceptedAt,subject,lines,subtotalCents,totalCents};
}

export type OfflineDocument={account:string;messageId:string;messageAt:string;sha256:string;order:OfflinePo};
/** Batch recovery from already-obtained documents. Exact PO joins; never title/date guesses.
 * Retain existing evidence, deduplicate identical documents, and hold conflicting snapshots.
 */
export function reconcileOfflineDocuments(previous:ImportPlan,documents:OfflineDocument[]):ImportPlan{
 let plan=structuredClone(previous);
 for(const d of documents){
  if(!d.account||!d.messageId||!/^[a-f0-9]{64}$/.test(d.sha256))throw Error('Document source identity and SHA256 required.');
  const base={account:d.account,messageId:`${d.messageId}:pdf:${d.sha256}`,messageAt:d.messageAt,externalPo:d.order.externalPo,documentSha256:d.sha256,sourceMessageId:d.messageId};
  plan=planPoEvidence(plan,{...base,messageId:base.messageId+':accepted',kind:'company-accepted',eventTimeLiteral:d.order.acceptedAt,sourceSubject:d.order.subject} as OrderEvidence);
  plan=planPoEvidence(plan,{...base,kind:'supplier-confirmation',supplier:d.order.supplier,lines:d.order.lines,subtotalCents:d.order.subtotalCents,totalCents:d.order.totalCents} as OrderEvidence);
 }
 return plan;
}
