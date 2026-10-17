import {parseSupplierIntake} from "./po-supplier-intake";
import type {PdfEvidence} from "./po-attachment-intake";
import type {OrderEvidence,EvidenceLine} from './po-evidence';
export type PoSource={pdfEvidence?:PdfEvidence[];account:string;id:string;subject:string;from:string;text:string;html?:string;labelIds?:string[];messageAt:string};
/** Text-only transform: does not execute HTML, load images, resolve redirects or fetch links. */
export function poTableText(html:string){return html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<\/(?:td|th)>/gi,' | ').replace(/<\/(?:tr|p|div)>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&zwnj;|\u200c/g,'');}
const norm=(s:string)=>s.replace(/\s+/g,' ').trim();
const money=(s:string)=>/^\$\d[\d,]*\.\d{2}$/.test(s)?Math.round(Number(s.replace(/[$,]/g,''))*100):NaN;
const amount=(s:string)=>/^\d+(?:\.\d{1,3})?$/.test(s)?Number(s):NaN;
export function parsePoSource(source:PoSource):OrderEvidence{
 const text=source.html?poTableText(source.html):source.text;
 const intake=parseSupplierIntake(source);
 const e:OrderEvidence={...(intake.length?{intake}:{}),...(source.pdfEvidence?.length?{pdfEvidence:source.pdfEvidence}:{}),account:source.account,messageId:source.id,messageAt:source.messageAt,sourceLabels:source.labelIds,kind:'correspondence'};
 const sender=source.from.match(/<([^>]+)>/)?.[1]||source.from.trim();
 const cancelled=source.subject.match(/^Cancelled Order #(\d+) PO #(\d+)$/i);
 if(sender.toLowerCase()==='grainger@service.grainger.com'&&cancelled){
  if(!text.includes('Order #'+cancelled[1]+' has been cancelled.'))return {...e,incomplete:true};
  return {...e,kind:'cancelled',externalPo:cancelled[2],vendorOrder:cancelled[1],supplier:'Grainger',cancellationReason:/payment issue/i.test(text)?'Payment issue':undefined};
 }
 if(sender.toLowerCase()==='ibuyefficientalerts@avendra.com'&&/^PO ACCEPTED:/i.test(source.subject)){
  const subject=source.subject.match(/Your PO #(\d+)\b/i),action=text.match(/^Action:\s*(.+?) has accepted PO #\s*(\d+) which occurred on (.+)$/mi);
  if(!subject||!action||subject[1]!==action[2])return {...e,kind:'company-accepted',incomplete:true};
  return {...e,kind:'company-accepted',externalPo:subject[1],sourceSubject:source.subject,eventTimeLiteral:action[3].trim()};
 }
 if(/TO ACCEPT THIS ORDER|accept and retrieve/i.test(text))return {...e,hasActionLink:true,incomplete:true};
 if(sender.toLowerCase()!=='donotreply@tx.hdsupply-email.com')return intake.length||source.pdfEvidence?.length||/\b(PO|purchase|order|invoice|receipt|shipment)\b/i.test(source.subject)?{...e,incomplete:true}:e;
 const confirmation=source.subject.match(/^Order Confirmation #(\d+)$/i),shipping=source.subject.match(/^Shipping Confirmation #(\d+)$/i);
 if(!confirmation&&!shipping)return {...e,incomplete:true};
 e.kind=shipping?'shipment':'supplier-confirmation';e.supplier='HD Supply';e.vendorOrder=(confirmation||shipping)![1];
 const tokens=text.split('|').map(norm).filter(Boolean);
 const poIndex=tokens.findIndex(t=>t==='PO Number');
 e.externalPo=tokens.slice(poIndex+1,poIndex+10).find(t=>/^\d{6,}$/.test(t));
 if(poIndex<0||!e.externalPo)return {...e,incomplete:true};
 const part=tokens.findIndex(t=>t.endsWith('Part #'));
 const width=shipping?6:9;
 const expected=shipping?['Description','Order Qty','Shipped Qty','Price','Total']:['Description','Order Qty','Confirmed Qty','Est. Delivery','Shipping Location','UOM','Unit Price','Extended Price'];
 if(part<0||expected.some((v,i)=>tokens[part+1+i]!==v))return {...e,incomplete:true};
 const lines:EvidenceLine[]=[];let i=part+width;let extendedTotal=0;
 while(i<tokens.length&&/^\d+$/.test(tokens[i])){
  const row=tokens.slice(i,i+width);let quantity:number,uom:string;
  if(shipping){const q=row[3]?.match(/^(\d+(?:\.\d{1,3})?) ([A-Z]+)$/);quantity=q?Number(q[1]):NaN;uom=q?.[2]||'';}
  else{quantity=amount(row[2]);uom=row[6];if(!Number.isFinite(amount(row[3])))return {...e,incomplete:true};}
  const unit=money(row[width-2]),extended=money(row[width-1]);
  if(!quantity||!uom||!Number.isFinite(unit)||!Number.isFinite(extended)||Math.abs(Math.round(quantity*unit)-extended)>1)return {...e,incomplete:true};
  lines.push({sku:row[0],description:row[1],quantity,uom,unitPriceCents:unit});extendedTotal+=extended;i+=width;
 }
 if(!lines.length||new Set(lines.map(l=>l.sku)).size!==lines.length)return {...e,incomplete:true};
 if(!shipping){const subtotal=tokens.findIndex(t=>t==='Subtotal');e.subtotalCents=money(tokens[subtotal+1]||'');if(e.subtotalCents!==extendedTotal)return {...e,incomplete:true};const tax=tokens.findIndex(t=>t==='Sales Tax'),total=tokens.findIndex(t=>t==='Total');e.taxCents=money(tokens[tax+1]||'');e.totalCents=money(tokens[total+1]||'');}
 else{e.deliveryId=tokens.slice(poIndex+1,poIndex+10).filter(t=>/^\d{6,}$/.test(t))[1];if(!e.deliveryId)return {...e,incomplete:true};e.carrier=/\bHDS Transport\b/.test(text)?'HDS Transport':undefined;/* Blank Date Shipped is never replaced with message date. */}
 e.lines=lines;return e;
}
