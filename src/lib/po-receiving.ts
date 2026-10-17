/** Receiving review domain. No I/O; stock changes require an explicit receipt. */
export type CatalogItem = { id:string; item_name:string; vendor_sku:string; quantity_on_hand:number; quantity_reserved:number; preferred_vendor_id:string|null; demoUnitCost?:number };
export type PoLine = { id:string; item:string; sku:string; ordered:number; uom?:string; catalogId:string|null };
export type PoEvidence = { id:string; kind:'submitted'|'company-accepted'|'supplier-confirmed'|'shipping'|'manual'; summary:string; date:string };
export type Shipment = {id:string;carrier:string;tracking:string;trackingUrl?:string;shipDate:string|null;eta:string|null;lines:{lineId:string;quantity:number;uom:string}[]};
export type PurchaseOrder = { id:string; number:string; supplier:string; origin:'ibuy'|'manual'; acceptance:'submitted'|'accepted'|'unresolved'; inbound:string; lines:PoLine[]; evidence:PoEvidence[];shipments?:Shipment[];backorders?:{lineId:string;quantity:number;note:string}[] };
export type Receipt = { id:string; orderId:string; lineId:string; quantity:number; date:string; note:string; includedInOpeningStock:boolean };
export type SupplyUse={id:string;catalogId:string;quantity:number;unitCost:number;jobId:string};
export type ReceivingState = { orders:PurchaseOrder[]; catalog:CatalogItem[]; receipts:Receipt[];uses?:SupplyUse[] };
export function recordSupplyUse(state:ReceivingState,use:SupplyUse):ReceivingState{
 const existing=state.uses?.find(u=>u.id===use.id);if(existing){if(JSON.stringify(existing)!==JSON.stringify(use))throw new Error('Usage reference already exists.');return state;}
 const item=state.catalog.find(i=>i.id===use.catalogId);if(!item||!use.id||!use.jobId||!Number.isSafeInteger(use.quantity)||use.quantity<=0||use.quantity>item.quantity_on_hand-item.quantity_reserved||!Number.isFinite(use.unitCost)||use.unitCost<0)throw new Error('Choose a supply and a valid available quantity.');
 return {...state,uses:[...(state.uses||[]),use],catalog:state.catalog.map(i=>i.id===item.id?{...i,quantity_on_hand:i.quantity_on_hand-use.quantity}:i)};
}
export function lineTotals(state:ReceivingState,orderId:string,line:PoLine){
  const received=state.receipts.filter(r=>r.orderId===orderId&&r.lineId===line.id).reduce((n,r)=>n+r.quantity,0);
  return {ordered:line.ordered,received,outstanding:Math.max(0,line.ordered-received)};
}
export function recordReceipt(state:ReceivingState, receipt:Receipt):ReceivingState {
  const prior=state.receipts.find(r=>r.id===receipt.id);
  if(prior){if(JSON.stringify(prior)!==JSON.stringify(receipt))throw new Error('Receipt key already used for different details.');return state;}
  if(!receipt.id.trim()||!receipt.note.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(receipt.date))throw new Error('Receipt reference, date and confirmation note are required.');
  if(receipt.includedInOpeningStock)throw new Error('Opening-stock reconciliation is a migration operation, not a new receipt.');
  const order=state.orders.find(o=>o.id===receipt.orderId),line=order?.lines.find(l=>l.id===receipt.lineId);
  if(!order||!line)throw new Error('Order line not found.');
  if(order.acceptance!=='accepted')throw new Error('Company acceptance must be resolved before receiving into stock.');
  if(!line.catalogId||!state.catalog.some(i=>i.id===line.catalogId))throw new Error('Link a Parts & Vendors catalog item before receiving.');
  const totals=lineTotals(state,order.id,line);
  if(!Number.isSafeInteger(receipt.quantity)||receipt.quantity<=0||receipt.quantity>totals.outstanding)throw new Error('Enter a whole quantity between 1 and the outstanding quantity.');
  return {...state,receipts:[...state.receipts,{...receipt}],catalog:state.catalog.map(i=>i.id===line.catalogId?{...i,quantity_on_hand:i.quantity_on_hand+receipt.quantity}:i)};
}
export function addManualOrder(state:ReceivingState,input:{id:string;number:string;supplier:string;item:string;quantity:number;catalogId:string|null;date:string}):ReceivingState {
  if(!input.id||!input.supplier.trim()||!input.item.trim()||!Number.isSafeInteger(input.quantity)||input.quantity<=0)throw new Error('Supplier / ordered through, item and a positive whole quantity are required.');
  if(state.orders.some(o=>o.id===input.id||(!!input.number.trim()&&o.number.toLowerCase()===input.number.trim().toLowerCase()&&o.supplier.toLowerCase()===input.supplier.trim().toLowerCase())))throw new Error('That supplier and order reference already exist.');
  if(input.catalogId&&!state.catalog.some(i=>i.id===input.catalogId))throw new Error('Catalog item not found.');
  return {...state,orders:[{id:input.id,number:input.number.trim(),supplier:input.supplier.trim(),origin:'manual',acceptance:'unresolved',inbound:'Not recorded',lines:[{id:input.id+'-line',item:input.item.trim(),sku:'',ordered:input.quantity,catalogId:input.catalogId}],evidence:[{id:input.id+'-manual',kind:'manual',summary:'Manually recorded. Company acceptance remains unresolved.',date:input.date}]},...state.orders]};
}
/** Verified normalized evidence only: email wording extraction is a separate review step. */
export function correlateEvidence(state:ReceivingState, input:{orderId:string;evidence:PoEvidence;inbound?:string}):ReceivingState {
  if(!state.orders.some(o=>o.id===input.orderId))throw new Error('Unmatched evidence requires review; do not create a duplicate order.');
  const owner=state.orders.find(o=>o.evidence.some(e=>e.id===input.evidence.id));
  if(owner){if(owner.id!==input.orderId)throw new Error('Evidence is already linked to another order.');return state;}
  return {...state,orders:state.orders.map(o=>o.id!==input.orderId?o:{...o,acceptance:input.evidence.kind==='company-accepted'?'accepted':o.acceptance,inbound:input.evidence.kind==='shipping'?input.inbound||'Inbound notice':o.inbound,evidence:[...o.evidence,input.evidence]})};
}
