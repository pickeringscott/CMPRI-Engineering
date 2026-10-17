export type IntakeLine={sku:string|null;description:string;quantity:number|null;uom:string|null;unitPriceCents:number|null;extendedPriceCents:number|null};
export type IntakeObservation={kind:string;supplier:string|null;reference:string|null;status:string;lines:IntakeLine[];facts:Record<string,unknown>};
type Source={from:string;subject:string;text:string;html?:string};
const cents=(s:string)=>Math.round(Number(s.replace(/[$,\s]/g,''))*100);
export function intakeText(html:string){return html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<\/(?:td|th)>/gi,' | ').replace(/<\/(?:tr|p|div)>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&zwnj;|\u200c/g,'');}
/** Keep source claims, never acceptance URLs, payment details, or inferred receipt quantities. */
export function purchasingClaims(text:string){return text.split(/\r?\n\s*\r?\n/).map(s=>s.replace(/^\s*>+\s?/gm,'').trim()).filter(s=>/\b(receiv|deliver|missing|broken|damag|RMA|return|reorder|cancel|outstanding|only one|only thing|not.*fit)/i.test(s)&&!/(confidential|return policy|guaranteed|unsubscribe)/i.test(s)).slice(0,20).map(s=>s.replace(/https?:\/\/\S+/gi,'[link withheld]').replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi,'[email omitted]').slice(0,2000));}
export function parseSupplierIntake(source:Source):IntakeObservation[]{
 const sender=(source.from.match(/<([^>]+)>/)?.[1]||source.from).trim().toLowerCase();
 const text=intakeText(source.html||source.text), plain=(source.text||text).replace(/^\s*>+\s?/gm,'');
 const cells=text.split('|').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean), flat=cells.join(' | '), out:IntakeObservation[]=[];
 const emit=(kind:string,supplier:string|null,reference:string|null,lines:IntakeLine[],facts:Record<string,unknown>={},status='historical-unresolved')=>out.push({kind,supplier,reference,status,lines,facts});
 const line=(sku:string|null,description:string,quantity:number|null,uom:string|null=null,unitPriceCents:number|null=null,extendedPriceCents:number|null=null):IntakeLine=>({sku,description,quantity,uom,unitPriceCents,extendedPriceCents});
 const grainger=source.subject.match(/^Shipping Confirmation #(\d+) PO #(\d+)$/i);
 if(sender==='grainger@service.grainger.com'&&grainger&&flat.includes(`Order #${grainger[1]}`)&&flat.includes(`PO #${grainger[2]}`)){
  const lines:IntakeLine[]=[];for(let i=0;i<cells.length;i++){const sku=cells[i].match(/^Item #\s*([A-Z0-9]+)$/i);if(!sku)continue;const q=cells[i+1]?.match(/^QTY Shipped (\d+(?:\.\d+)?)$/i);if(q&&i>0)lines.push(line(sku[1],cells[i-1],Number(q[1])));}
  const carrier=cells.find(c=>/^(FedEx|UPS|USPS|DHL)$/i.test(c))||null, tracking=carrier?cells[cells.indexOf(carrier)+1]:null;
  emit('shipment','Grainger',grainger[1],lines,{externalPo:grainger[2],carrier,tracking:/^[A-Z0-9]{8,35}$/i.test(tracking||'')?tracking:null,quantityMeaning:'shipped',orderedQuantity:null,physicalReceiptQuantity:null},lines.length?'shipment-only':'needs-review');
 }
 if(sender==='order@orders.menards.com'&&/Ready for Pick Up/i.test(source.subject)){
  const ref=source.subject.match(/\b(CHAM\d+)\b/)?.[1];if(ref&&text.includes(ref))emit('pickup-available','Menards',ref,[],{physicalReceiptQuantity:null},'pickup-not-confirmed');
 }
 if(sender==='info@minutekey.com'&&/Minute Key Receipt/i.test(source.subject)){
  const ref=flat.match(/Transaction:\s*([A-Z0-9]+)/)?.[1],lines:IntakeLine[]=[];
  for(let i=0;i<cells.length-2;i++){const q=cells[i].match(/^(\d+)x$/);if(q&&/^\$\d+\.\d{2}$/.test(cells[i+2])){const extended=cents(cells[i+2]);lines.push(line(null,cells[i+1],Number(q[1]),null,extended/Number(q[1]),extended));}}
  const subtotal=cells.indexOf('Subtotal'),total=cells.indexOf('Total');const sum=lines.reduce((n,l)=>n+(l.extendedPriceCents||0),0);
  if(ref)emit('purchase-receipt','Minute Key',ref,lines,{subtotalCents:subtotal>=0?cents(cells[subtotal+1]):null,totalCents:total>=0?cents(cells[total+1]):null,physicalReceiptQuantity:null},lines.length&&subtotal>=0&&sum===cents(cells[subtotal+1])?'purchase-only':'needs-review');
 }
 if(sender==='do-not-reply@receipt.lowes.com'&&/Purchase Receipt/i.test(source.subject)){
  const ref=flat.match(/Transaction #\s*:\s*(\d+)/)?.[1],order=flat.match(/Order #\s*:\s*(\d+)/)?.[1],lines:IntakeLine[]=[];
  for(let i=2;i<cells.length;i++){const sku=cells[i].match(/^Item #:\s*(\d+)$/),q=cells[i+1]?.match(/^(\d+(?:\.\d+)?) @ ([\d,]+\.\d{2})$/);if(sku&&q&&/^\$\s*[\d,]+\.\d{2}$/.test(cells[i-1]))lines.push(line(sku[1],cells[i-2],Number(q[1]),null,cents(q[2]),cents(cells[i-1])));}
  const sub=cells.indexOf('Subtotal'),sum=lines.reduce((n,l)=>n+(l.extendedPriceCents||0),0);
  if(ref)emit('purchase-receipt',"Lowe's",ref,lines,{supplierOrder:order||null,subtotalCents:sub>=0?cents(cells[sub+1]):null,physicalReceiptQuantity:null},lines.length&&sub>=0&&sum===cents(cells[sub+1])&&lines.every(l=>Math.round(l.quantity!*l.unitPriceCents!)===l.extendedPriceCents)?'purchase-only':'needs-review');
 }
 const trustedForward=sender.endsWith('@hawkeyehotels.com')||sender==='support@desi.com';
 if(trustedForward&&/DESI Telephone Labels Inc Invoice #\d+/i.test(source.subject)){
  const ref=source.subject.match(/Invoice #(\d+)/i)?.[1];const normalized=plain.replace(/[*>]/g,'').replace(/\s+/g,' '),lines:IntakeLine[]=[];
  for(const m of normalized.matchAll(/\b(\d{6})\s+(\d+)\s+(.+?)\s+\$([\d,.]+)\s+\$([\d,.]+)\s+\$([\d,.]+)\s+\$([\d,.]+)/g))lines.push(line(m[1],m[3],Number(m[2]),null,cents(m[6]),cents(m[7])));
  if(ref)emit('invoice','DESI Telephone Labels Inc',ref,lines,{forwarded:sender!=='support@desi.com',physicalReceiptQuantity:null},lines.length&&lines.every(l=>Math.round(l.quantity!*l.unitPriceCents!)===l.extendedPriceCents)?'invoice-only':'needs-review');
 }
 if(sender.endsWith('@hawkeyehotels.com')||sender.endsWith('@amazon.com')){
  // ASIN links identify products; description pack sizes never become order quantities.
  for(const m of plain.matchAll(/\[image:\s*([\s\S]*?)\]\s*(\d+)?\s*<?https:\/\/(?:www\.)?amazon\.com\/(?:gp\/product|dp)\/([A-Z0-9]{10})[^\s>]*/g))emit('catalog-observation','Amazon',m[3],[line(m[3],m[1].replace(/\s+/g,' ').trim(),m[2]?Number(m[2]):null)],{productUrl:`https://www.amazon.com/dp/${m[3]}`,externalPo:null,quotedSource:true},'stock-unknown');
  const claims=purchasingClaims(plain);
  if(claims.length&&/\b(PO|order|cooktop|invoice|receipt|shipment|return)\b/i.test(source.subject)){
   const ref=plain.match(/\bPO\s*#\s*(\d{6,})\b/i)?.[1]||null;
   emit('receipt-correspondence',null,ref,[],{claims,quotedClaimsMayConflict:true,physicalReceiptQuantity:null,returnCompleted:null},/broken|damaged|RMA|only one|only thing|haven.t received|did not receive|missing/i.test(claims.join(' '))?'needs-reconciliation':'needs-review');
  }
 }
 if(/TO ACCEPT THIS ORDER|accept and retrieve/i.test(text))emit('blocked-action-link',null,null,[],{retrieved:false,requiresExplicitAuthorization:true},'not-retrieved');
 return out;
}
