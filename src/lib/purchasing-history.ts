import type {ImportPlan} from './po-evidence';
/** Historical evidence is deliberately separate from counted stock and active receipts. */
export type HistoryRecord = {
  key: string; kind: string; title: string; supplier: string | null; reference: string | null;
  status: string; sourceIds: string[]; orderedQuantity: number | null; uom: string | null;
  currentOnHand: null; payload: Record<string, unknown>;
};
export type HistoryPlan = { version: 1; sources: Record<string, unknown>[]; records: HistoryRecord[] };
/** The mailbox-history action must never turn years of messages into active receiving orders. */
export function historyFromMailboxReview(plan:ImportPlan):HistoryPlan {
 const evidence=[...plan.orders.flatMap(o=>o.evidence),...plan.review.map(r=>r.evidence)];
 const sources=new Map<string,Record<string,unknown>>(),records=new Map<string,HistoryRecord>();
 for(const e of evidence){
  sources.set(e.messageId,{gmail_message_id:e.messageId});
  // PDF extraction may succeed on a retry. Keep message evidence immutable and
  // store each attachment result separately so a transient failure cannot block it.
  const key=JSON.stringify(['mailbox-evidence-v2',e.messageId]);
  const messageEvidence={...e};delete messageEvidence.pdfEvidence;
  records.set(key,{key,kind:'mailbox-evidence',title:`${e.kind}: ${e.externalPo||e.vendorOrder||e.messageId}`,supplier:e.supplier||null,reference:e.externalPo||e.vendorOrder||null,status:e.kind==='cancelled'?'cancelled':'needs-review',sourceIds:[e.messageId],orderedQuantity:null,uom:null,currentOnHand:null,payload:messageEvidence});
  const addObservation=(observation:NonNullable<typeof e.intake>[number],location:string,index:number)=>{
   const observationKey=JSON.stringify(['automatic-observation-v1',e.messageId,location,index]);
   records.set(observationKey,{key:observationKey,kind:'supplier-observation',title:observation.lines[0]?.description||observation.kind,supplier:observation.supplier,reference:observation.reference,status:observation.status,sourceIds:[e.messageId],orderedQuantity:null,uom:null,currentOnHand:null,payload:{...observation,sourceLocation:location}});
  };
  e.intake?.forEach((observation,index)=>addObservation(observation,'message',index));
  e.pdfEvidence?.forEach(pdf=>{
   const pdfVersion=JSON.stringify([pdf.part,pdf.sha256||null,pdf.status]);
   const pdfKey=JSON.stringify(['automatic-pdf-v1',e.messageId,pdfVersion]);
   records.set(pdfKey,{key:pdfKey,kind:'pdf-document',title:pdf.filename,supplier:null,reference:pdf.sha256||null,status:pdf.status,sourceIds:[e.messageId],orderedQuantity:null,uom:null,currentOnHand:null,payload:{...pdf}});
   pdf.observations.forEach((observation,index)=>addObservation(observation,'pdf:'+pdfVersion,index));
  });
 }
 return {version:1,sources:[...sources.values()],records:[...records.values()]};
}
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Expected an evidence object'); return v as Obj; };
const list = (v: unknown): Obj[] => { if (!Array.isArray(v)) throw Error('Expected an evidence list'); return v.map(object); };
const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim()) throw Error('Missing evidence identity'); return v; };
const strings = (v: unknown): string[] => { if (!Array.isArray(v)) throw Error('Expected source references'); return v.map(text); };
const identity = (...v: string[]) => JSON.stringify(v);
export function canonicalHistory(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalHistory).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalHistory(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function planPurchasingHistory(input: unknown): HistoryPlan {
  const b=object(input), supplier=object(b.supplier_order_history), receipts=object(b.other_supplier_receipts);
  const sourceMap=new Map<string,Obj>();
  for(const s of list(b.source_index)) { const id=text(s.gmail_message_id); if(!/^[a-f0-9]{16}$/.test(id)) throw Error('Invalid Gmail message ID'); const old=sourceMap.get(id); if(old&&canonicalHistory(old)!==canonicalHistory(s))throw Error(`Conflicting source ${id}`); sourceMap.set(id,s); }
  const records=new Map<string,HistoryRecord>();
  function add(kind:string, parts:string[], title:string, vendor:string|null, reference:string|null, sourceIds:string[], payload:Obj, status='historical-unresolved', quantity:number|null=null, uom:string|null=null) {
    const ids=[...new Set(sourceIds)].sort(); if(ids.some(id=>!sourceMap.has(id))) throw Error(`Missing source provenance for ${kind} ${reference||title}`);
    if(quantity!==null&&(!Number.isFinite(quantity)||quantity<0))throw Error('Invalid historical quantity');
    const r:HistoryRecord={key:identity(kind,...parts),kind,title,supplier:vendor,reference,status,sourceIds:ids,orderedQuantity:quantity,uom,currentOnHand:null,payload};
    const old=records.get(r.key); if(old&&canonicalHistory(old)!==canonicalHistory(r))throw Error(`Conflicting historical identity ${r.key}`); records.set(r.key,r);
  }
  const events=list(supplier.events), orders=list(supplier.orders);
  const catalog=new Map<string,{supplier:string;sku:string;description:string;ids:Set<string>;observations:Obj[]}>();
  for(const o of orders){
    const vendor=text(o.supplier), ref=text(o.supplier_order_id), ids=strings(o.source_gmail_ids);
    const related=events.filter(e=>e.supplier===vendor&&e.supplier_order_id===ref);
    const cancelled=related.some(e=>e.event_type==='cancellation');
    const disputed=related.some(e=>e.event_type==='damaged_arrival_and_return_request')||list(o.items).some(i=>i.shipment_sum_unreconciled===true);
    add('supplier-order',[vendor,ref],`${vendor} ${ref}`,vendor,ref,ids,o,cancelled?'cancelled':disputed?'needs-reconciliation':'historical-unresolved');
    for(const i of list(o.items)){
      const sku=text(i.supplier_item_number), observations=list(i.observations), quantities=list(i.ordered_quantity_observations);
      const distinct=[...new Set(quantities.map(q=>canonicalHistory({quantity:q.quantity,unit:q.unit})))];
      const q=distinct.length===1?object(JSON.parse(distinct[0])):null;
      const amount=q&&typeof q.quantity==='number'?q.quantity:null, unit=q&&typeof q.unit==='string'?q.unit:null;
      const itemIds=[...new Set(observations.map(x=>text(x.source_gmail_id)))];
      add('order-line',[vendor,ref,sku],text(i.description),vendor,ref,itemIds,i,cancelled?'cancelled':i.shipment_sum_unreconciled?'needs-reconciliation':'historical-unresolved',amount,unit);
      const key=identity(vendor,sku), c=catalog.get(key)||{supplier:vendor,sku,description:text(i.description),ids:new Set<string>(),observations:[]};
      itemIds.forEach(id=>c.ids.add(id));c.observations.push({supplierOrder:ref,...i});catalog.set(key,c);
    }
  }
  for(const c of catalog.values()) add('catalog',[c.supplier,c.sku],c.description,c.supplier,c.sku,[...c.ids],{sku:c.sku,observations:c.observations},'stock-unknown');
  for(const e of events){const vendor=text(e.supplier), ref=text(e.supplier_order_id), id=text(e.source_gmail_id);add('supplier-event',[vendor,ref,id,text(e.event_type)],text(e.source_subject),vendor,ref,[id],e,text(e.event_type));}
  for(const a of list(b.ibuy_acceptances)){const id=text(a.message_id),ref=text(a.po_number);add('acceptance',[id],typeof a.description==='string'&&a.description.trim()?a.description:`PO ${ref}`,text(a.supplier_label),ref,[id],a,'acceptance-only');}
  for(const c of list(b.cassie_order_evidence)){const id=text(c.message_id);add('correspondence',[id],String(sourceMap.get(id)?.subject||'Purchasing correspondence'),null,null,[id],c,'needs-review');}
  for(const c of list(b.amazon_historical_catalog)){const sku=text(c.sku);add('catalog',['Amazon',sku],text(c.description),'Amazon',sku,list(c.evidence).map(e=>text(e.message_id)),c,'stock-unknown');}
  for(const r of list(receipts.records)){const vendor=text(r.supplier),ref=text(r.transaction_id||r.supplier_order_id);add('purchase-document',[vendor,ref],`${vendor} ${ref}`,vendor,ref,strings(r.source_gmail_ids),r,'historical-purchase-only');}
  // Preserve contradictions and partial receipt narratives, linked to every explicit source ID.
  const notes=text(b.reconciliation_notes);
  for(const [index,note] of notes.split(/\r?\n/).filter(s=>s.trim()).entries()){
    const ids=[...new Set(note.match(/\b[a-f0-9]{16}\b/g)||[])];
    add('reconciliation-note',[String(index)],note,null,null,ids,{text:note},'needs-review');
  }
  add('coverage',['bundle'],'Historical source coverage',null,null,[],{readme:text(b.readme),findings:text(b.supplier_findings),supplierScope:supplier.scope??null,supplierDeduplication:supplier.deduplication??null,supplierLimitations:supplier.limitations??[],receiptDeduplication:receipts.deduplication_note??null,qualityChecks:supplier.quality_checks??null,unparsed:supplier.unparsed_or_empty_message_ids??[]},'coverage');
  return {version:1,sources:[...sourceMap.values()].sort((a,b)=>text(a.gmail_message_id).localeCompare(text(b.gmail_message_id))),records:[...records.values()].sort((a,b)=>a.key.localeCompare(b.key))};
}
