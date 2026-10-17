import type {SupabaseClient} from '@supabase/supabase-js';
import type {ImportPlan} from '../po-evidence';
/** Explicitly invoked by a reviewed-import workflow; never called by the read-only scan. */
export async function persistReviewedPoPlan(admin:SupabaseClient,hotelId:string,actorId:string,plan:ImportPlan){
 const result:{externalPo:string;id?:string;error?:string}[]=[];
 for(const order of plan.orders){if((!order.supplier||!order.lines.length)&&!order.evidence.some(e=>e.kind==='company-accepted'&&e.externalPo===order.externalPo&&!e.incomplete)){result.push({externalPo:order.externalPo,error:'Supplier or full line extraction unresolved'});continue;}
 const saved=await admin.rpc('cmpri_import_po_order',{p_hotel:hotelId,p_actor:actorId,p_order:order});result.push(saved.error?{externalPo:order.externalPo,error:saved.error.message}:{externalPo:order.externalPo,id:String(saved.data)});}
 return {orders:result,held:plan.review.length};
}
