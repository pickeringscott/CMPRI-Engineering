import {inspectPoPdf} from './po-pdf';
import {parseSupplierIntake,type IntakeObservation} from './po-supplier-intake';
export type PdfPart={partId?:string;filename?:string;mimeType?:string;body?:{size?:number;data?:string;attachmentId?:string};parts?:PdfPart[]};
export type PdfEvidence={part:string;filename:string;status:'parsed'|'needs-review'|'ocr-required'|'blocked-limit'|'failed';sha256?:string;pageCount?:number;observations:IntakeObservation[]};
/** Only Gmail-discovered MIME IDs reach load; document URLs are never accepted. */
export async function inspectGmailPdfs(payload:PdfPart,load:(id:string)=>Promise<Uint8Array>,source:{from:string;subject:string}):Promise<PdfEvidence[]>{
 const parts:PdfPart[]=[];function visit(p:PdfPart){if(p.mimeType==='application/pdf'||p.filename?.toLowerCase().endsWith('.pdf'))parts.push(p);for(const child of p.parts||[])visit(child);}visit(payload);
 const reports:PdfEvidence[]=[];let bytesRead=0;
 for(const [index,part]of parts.entries()){
  const base={part:part.partId||String(index),filename:part.filename||'document.pdf',observations:[] as IntakeObservation[]};
  if(index>=5||(part.body?.size||0)>10*1024*1024||bytesRead>=20*1024*1024){reports.push({...base,status:'blocked-limit'});continue;}
  try{
   const bytes=part.body?.data?new Uint8Array(Buffer.from(part.body.data,'base64url')):part.body?.attachmentId?await load(part.body.attachmentId):null;
   if(!bytes)throw Error('Missing PDF bytes');bytesRead+=bytes.length;if(bytesRead>20*1024*1024||bytes.length>10*1024*1024){reports.push({...base,status:'blocked-limit'});continue;}
   const pdf=await inspectPoPdf(bytes),text=pdf.pages.map(p=>p.text).join('\n');
   const observations=pdf.offlineOrder?[{kind:'ibuy-offline-order',supplier:pdf.offlineOrder.supplier,reference:pdf.offlineOrder.externalPo,status:'document-review-required',lines:pdf.offlineOrder.lines.map(l=>({...l,unitPriceCents:l.unitPriceCents??null,extendedPriceCents:Math.round(l.quantity*l.unitPriceCents!)})),facts:{acceptedAt:pdf.offlineOrder.acceptedAt,subject:pdf.offlineOrder.subject,subtotalCents:pdf.offlineOrder.subtotalCents,totalCents:pdf.offlineOrder.totalCents,physicalReceiptQuantity:null}}]:parsePdfPurchasingText(text,source);
   reports.push({...base,status:!text.trim()?'ocr-required':observations.length?'parsed':'needs-review',sha256:pdf.sha256,pageCount:pdf.pages.length,observations});
  }catch{reports.push({...base,status:'failed'});}
 }
 return reports;
}
export function parsePdfPurchasingText(text:string,source:{from:string;subject:string}):IntakeObservation[]{
 const normalized=text.replace(/\s+/g,' ');
 if(/F\.?\s*E\.?\s*MORAN/i.test(normalized)&&/Current Payment Due/i.test(normalized)){
  const invoice=normalized.match(/\b\d{3}-\d{9}\b/)?.[0]||null,amount=normalized.match(/Current Payment Due\s*\$\s*([\d,]+\.\d{2})/i)?.[1];
  return [{kind:'service-invoice',supplier:'F.E. Moran',reference:invoice,status:invoice&&amount?'invoice-only':'needs-review',lines:[],facts:{totalCents:amount?Math.round(Number(amount.replaceAll(',',''))*100):null,physicalReceiptQuantity:null,serviceNotParts:true}}];
 }
 // Reuse a verified supplier layout when the PDF contains the same explicit table.
 return parseSupplierIntake({...source,text}).filter(o=>o.kind!=='blocked-action-link');
}
