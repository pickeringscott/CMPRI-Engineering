export function wholePoCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 999999999) {
    throw new Error('Enter a whole item count of at least 1.');
  }
  return value;
}

export function receiptBlock(input: {ordered:number;received:number;origin?:string;accepted:boolean;mapped:boolean;active:boolean;cancelled?:boolean}) {
  if (input.cancelled) return 'Cancelled order cannot receive.';
  if (!Number.isInteger(Number(input.ordered)) || !Number.isInteger(input.received)) return 'Existing fractional order or receipt quantity requires review; values have not been rounded.';
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
