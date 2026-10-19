export type PoDisplaySource = {order_id:string|null;kind:string;source_note:string};
export function poDisplayMetadata(orderId:string,sources:PoDisplaySource[]) {
  const evidence=sources.filter(s=>s.order_id===orderId&&s.kind==='company-accepted').flatMap(s=>{
    try { const e=JSON.parse(s.source_note);return e&&typeof e==='object'?[e]:[]; } catch {return [];}
  }).sort((a,b)=>Number(b.metadataRevision||0)-Number(a.metadataRevision||0)||String(b.messageAt||'').localeCompare(String(a.messageAt||'')));
  const e=evidence[0];
  // Preserve source meaning: an email subject/date is not an original iBuy PO field.
  const subject=typeof e?.sourceSubject==='string'&&e.sourceSubject.trim()?e.sourceSubject:null;
  const raw=typeof e?.messageAt==='string'?e.messageAt.slice(0,10):'';
  const date=/^\d{4}-\d{2}-\d{2}$/.test(raw)&&Number.isFinite(Date.parse(raw))?raw:null;
  return {subject,date};
}
export function amazonItemUrl(description:string):string|null {
  if(/[\u0000-\u001f\u007f]/.test(description))return null;
  try {
    const u=new URL(description.trim());
    if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
    return /(^|\.)amazon\.com$/i.test(u.hostname)||u.hostname==='a.co'?u.href:null;
  } catch {return null;}
}
export function poMoney(value:number|null) {return value===null?'Unknown':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);}
export function poLineValue(line:{ordered:number;purchase_unit_price_cents?:number|null}) {
  const p=line.purchase_unit_price_cents;
  return p!=null&&Number.isSafeInteger(Number(p))&&Number(p)>=0?Math.round(Number(line.ordered)*Number(p))/100:null;
}
export function paneBounds(size:number,stacked:boolean) {
  const available=Math.max(0,size-10),min=Math.min(stacked?140:120,available*.4);
  return {min,max:Math.max(min,available-Math.min(stacked?160:240,available*.5))};
}
