import type {ImportPlan} from './po-evidence';
export function scopeOutstandingPoPlan(plan:ImportPlan,selected:unknown){
 if(!Array.isArray(selected)||!selected.length||selected.length>100||selected.some(s=>typeof s!=='string'||!s.trim())||new Set(selected).size!==selected.length)throw Error('Select the exact outstanding PO references for catch-up.');
 const wanted=new Set<string>(selected);
 if([...wanted].some(id=>!plan.orders.some(o=>o.externalPo===id)))throw Error('An outstanding PO is missing from the current source plan.');
 const orders=plan.orders.filter(o=>wanted.has(o.externalPo));
 return {...plan,orders,review:plan.review.filter(r=>!!r.evidence.externalPo&&wanted.has(r.evidence.externalPo)),seen:plan.seen};
}
/** Dry run only: supplier delivery never changes these receipt totals or opening stock. */
export function poCatchupReport(plan:ImportPlan,selected:unknown,existing:{externalPo:string;receivedUnits:number;sourceMessageIds:string[]}[]){
 const scoped=scopeOutstandingPoPlan(plan,selected);
 return scoped.orders.map(o=>{const prior=existing.find(p=>p.externalPo===o.externalPo);return {externalPo:o.externalPo,supplier:o.supplier,companyAccepted:o.accepted,lineCount:o.lines.length,shipments:Object.keys(o.shipments),newSourceMessageIds:o.evidence.map(e=>e.messageId).filter(id=>!prior?.sourceMessageIds.includes(id)),physicalReceivedUnits:prior?.receivedUnits??0,inventoryDelta:0,requiresReview:!o.supplier||!o.lines.length||scoped.review.some(r=>r.evidence.externalPo===o.externalPo)};});
}
