import type {IntakeObservation} from "./po-supplier-intake";
import type {PdfEvidence} from "./po-attachment-intake";
/** Conservative, normalized email import plan. Never follows URLs or modifies stock. */
export type EvidenceLine={sku:string;description:string;quantity:number;uom:string;unitPriceCents?:number};
export type OrderEvidence={intake?:IntakeObservation[];pdfEvidence?:PdfEvidence[];account:string;messageId:string;messageAt:string;sourceLabels?:string[];kind:'cancelled'|'submitted'|'company-accepted'|'supplier-confirmation'|'shipment'|'receiving-notification'|'correspondence';externalPo?:string;internalPo?:string;vendorOrder?:string;deliveryId?:string;invoice?:string;supplier?:string;eventTimeLiteral?:string;cancellationReason?:string;lines?:EvidenceLine[];historyLines?:EvidenceLine[];subtotalCents?:number;taxCents?:number;totalCents?:number;shippedDate?:string;eta?:string;carrier?:string;tracking?:string;trackingUrl?:string;supplierDelivered?:boolean;incomplete?:boolean;hasActionLink?:boolean};
export type ImportOrder={externalPo:string;accepted:boolean;cancelled?:boolean;supplier:string|null;vendorOrders:string[];lines:EvidenceLine[];shipments:Record<string,{lines:EvidenceLine[];shippedDate:string|null;eta:string|null;carrier?:string;tracking?:string;trackingUrl?:string;supplierDelivered:boolean|null}>;evidence:OrderEvidence[]};
export type ImportPlan={orders:ImportOrder[];seen:string[];review:{key:string;reason:string;evidence:OrderEvidence}[]};
export const emptyImportPlan=():ImportPlan=>({orders:[],seen:[],review:[]});
const validLines=(lines:EvidenceLine[])=>lines.length>0&&lines.every(l=>!!l.sku&&!!l.uom&&Number.isFinite(l.quantity)&&l.quantity>0)&&new Set(lines.map(l=>l.sku)).size===lines.length;
export function planPoEvidence(previous:ImportPlan,e:OrderEvidence):ImportPlan{
 const key=JSON.stringify([e.account,e.messageId]);
 if(!e.account||!e.messageId)throw new Error('Account and Gmail message ID are required.');
 if(previous.seen.includes(key))return previous;
 const next:ImportPlan=structuredClone(previous);next.seen.push(key);
 const hold=(reason:string)=>{next.review.push({key,reason,evidence:e});return next;};
 if(e.kind==='correspondence'&&!e.incomplete&&!e.hasActionLink&&!e.intake?.length&&!e.pdfEvidence?.length)return next;
 if(e.kind==='receiving-notification')return hold('Invoice/internal PO notification is not a physical receipt or an external PO join.');
 if(e.incomplete)return hold('Incomplete or cropped source: quantities require review.');
 if(e.hasActionLink&&e.kind!=='company-accepted')return hold('Acceptance/retrieval action link held. No URL was fetched and no acceptance inferred.');
 let order=e.externalPo?next.orders.find(o=>o.externalPo===e.externalPo):undefined;
 if(!order&&e.vendorOrder){const matches=next.orders.filter(o=>o.vendorOrders.includes(e.vendorOrder!)&&!!e.supplier&&o.supplier===e.supplier);if(matches.length===1)order=matches[0];}
 if(!order&&e.externalPo&&(e.kind==='submitted'||e.kind==='company-accepted'||e.kind==='cancelled')){order={externalPo:e.externalPo,accepted:false,supplier:null,vendorOrders:[],lines:[],shipments:{},evidence:[]};next.orders.push(order);}
 if(!order)return hold('No exact external PO or previously verified supplier/order cross-reference.');
 if(e.externalPo&&e.externalPo!==order.externalPo)return hold('Conflicting external PO cross-reference.');
 if(e.supplier&&e.supplier!=='OFFLINE SUPPLIER'&&order.supplier&&order.supplier!==e.supplier)return hold('Supplier differs from the existing exact reference.');
 if(e.lines&&!validLines(e.lines))return hold('Invalid or ambiguous line quantities/UOM.');
 if(e.kind==='supplier-confirmation'&&e.lines&&order.lines.length&&JSON.stringify(order.lines)!==JSON.stringify(e.lines))return hold('Changed line snapshot requires review; do not add quantities.');
 if(e.kind==='shipment'&&(!e.deliveryId||!e.lines))return hold('Shipment lacks a delivery ID or shipment-section line quantities.');
 if(e.supplier&&e.supplier!=='OFFLINE SUPPLIER')order.supplier=e.supplier;
 if(e.vendorOrder&&!order.vendorOrders.includes(e.vendorOrder))order.vendorOrders.push(e.vendorOrder);
 if(e.kind==='company-accepted')order.accepted=true;
 if(e.kind==='cancelled')order.cancelled=true;
 if(e.kind==='supplier-confirmation'&&e.lines)order.lines=structuredClone(e.lines);
 if(e.kind==='shipment'&&e.deliveryId&&e.lines){order.shipments[e.deliveryId]={lines:structuredClone(e.lines),shippedDate:e.shippedDate||null,eta:e.eta||null,carrier:e.carrier,tracking:e.tracking,trackingUrl:e.trackingUrl,supplierDelivered:e.supplierDelivered??null};}
 // historyLines are a repeated snapshot, never additional ordered/shipped units.
 order.evidence.push(structuredClone(e));return next;
}
export function catalogCandidates(plan:ImportPlan){return plan.orders.filter(o=>o.accepted&&!o.cancelled&&o.lines.length>0&&o.supplier).flatMap(o=>o.lines.map(l=>({externalPo:o.externalPo,supplier:o.supplier!,...l,quantity_on_hand:null})));}

/** Rebuild from immutable evidence so arrival order cannot lose early confirmations. */
export function planPoBatch(evidence:OrderEvidence[]){const rank={cancelled:3,submitted:0,"company-accepted":0,"supplier-confirmation":1,shipment:2,"receiving-notification":3,correspondence:3};return [...evidence].sort((a,b)=>rank[a.kind]-rank[b.kind]||a.messageAt.localeCompare(b.messageAt)||a.messageId.localeCompare(b.messageId)).reduce(planPoEvidence,emptyImportPlan());}
