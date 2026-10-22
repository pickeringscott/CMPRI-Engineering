export function wholePoCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 999999999) {
    throw new Error('Enter a whole item count of at least 1.');
  }
  return value;
}

export function receiptBlock(input: {ordered:number;received:number;weightUnit?:boolean;origin?:string;accepted:boolean;mapped:boolean;active:boolean;cancelled?:boolean}) {
  if (input.cancelled) return 'Cancelled order cannot receive.';
  if (!input.weightUnit && (!Number.isInteger(Number(input.ordered)) || !Number.isInteger(input.received))) return 'Existing fractional order or receipt quantity requires review; values have not been rounded.';
  if (input.received >= Number(input.ordered)) return 'Fully received.';
  const missing=[];
  if (input.origin !== 'manual' && !input.accepted) missing.push('company approval');
  if (!input.mapped) missing.push('inventory item and stock conversion');
  else if (!input.active) missing.push('an active inventory item');
  return missing.length ? `Before receiving, confirm ${missing.join(' and ')}.` : '';
}

export function stockAdded(count: number, factor: number): number | null {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(factor) || factor <= 0) return null;
  const result=count*factor;
  return Math.abs(result*1000-Math.round(result*1000)) < 1e-6 ? Math.round(result*1000)/1000 : null;
}

export function recordedPoValue(lines: {id:string;ordered:number;purchase_unit_price_cents?:number|null}[], receipts:{line_id:string;quantity:number}[]) {
  let orderedCents=0,receivedCents=0,pricedLines=0;
  for (const line of lines) {
    const price=line.purchase_unit_price_cents;
    if (price==null || !Number.isSafeInteger(Number(price)) || Number(price)<0) continue;
    pricedLines++;
    orderedCents+=Number(line.ordered)*Number(price);
    receivedCents+=receipts.filter(r=>r.line_id===line.id).reduce((n,r)=>n+Number(r.quantity),0)*Number(price);
  }
  return {ordered:pricedLines?Math.round(orderedCents)/100:null,received:pricedLines?Math.round(receivedCents)/100:null,unpricedLines:lines.length-pricedLines};
}

export function poOrderBadge(order: {origin:string;acceptance:string;cancelled?:boolean}) {
  const status=order.cancelled?'Cancelled':order.acceptance==='accepted'?'Accepted':order.acceptance==='submitted'?'Submitted':order.origin==='manual'?'Recorded':'Awaiting Acceptance';
  return order.origin==='manual'?status+' · Manually Entered':status;
}

export function poHotelDate(now:Date,timeZone:string) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');
}
export function receivedPoSpending(lines:{id:string;purchase_unit_price_cents?:number|null}[],receipts:{id:string;line_id:string;quantity:number;received_date:string|null}[],now:Date,timeZone:string) {
  const today=poHotelDate(now,timeZone),year=today.slice(0,4),month=Number(today.slice(5,7));
  const starts={MTD:`${today.slice(0,7)}-01`,QTD:`${year}-${String(Math.floor((month-1)/3)*3+1).padStart(2,'0')}-01`,YTD:`${year}-01-01`};
  const prices=new Map(lines.map(l=>[l.id,l.purchase_unit_price_cents]));
  return Object.fromEntries(Object.entries(starts).map(([period,start])=>{
    let milliCents=BigInt(0),known=0,missing=0;const seen=new Set<string>();
    for(const receipt of receipts){
      if(seen.has(receipt.id))continue;seen.add(receipt.id);
      const date=receipt.received_date;
      if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date){missing++;continue;}
      if(date<start||date>today)continue;
      // The PO purchase-unit price is the recorded source snapshot, not today's inventory cost.
      // Receipt quantity uses that same purchase unit; stock conversion must not multiply its value.
      const price=prices.get(receipt.line_id),quantity=Number(receipt.quantity),thousandths=Math.round(quantity*1000);
      if(price==null||!Number.isSafeInteger(Number(price))||Number(price)<0||!Number.isSafeInteger(thousandths)||quantity<=0||Math.abs(quantity*1000-thousandths)>1e-6){missing++;continue;}
      milliCents+=BigInt(thousandths)*BigInt(price);known++;
    }
    const cents=(milliCents+BigInt(500))/BigInt(1000),overflow=cents>BigInt(Number.MAX_SAFE_INTEGER);
    return [period,{value:overflow||(!known&&missing)?null:Number(cents)/100,missing:missing+(overflow?known:0)}];
  })) as Record<'MTD'|'QTD'|'YTD',{value:number|null;missing:number}>;
}
