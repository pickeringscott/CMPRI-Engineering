import type { SupabaseClient } from '@supabase/supabase-js';
import { HOTEL_ID } from '@/lib/constants';
import type { PartStatus } from '@/lib/work-order-parts';
/** Call only after work-order access filtering; return summaries for those IDs only. */
export async function attachPartsStatuses<T extends {id:string}>(admin:SupabaseClient,orders:T[]):Promise<Array<T & {parts_status:PartStatus|null}>> {
  const statuses = new Map<string,PartStatus>();
  if (process.env.CMPRI_PO_ENABLED === 'true') {
    const ids = [...new Set(orders.map(order=>order.id))];
    for (let offset=0;offset<ids.length;offset+=500) {
      const {data,error}=await admin.rpc('cmpri_ticket_parts_statuses',{p_hotel:HOTEL_ID,p_jobs:ids.slice(offset,offset+500)});
      if(error) throw Error('Parts status could not be loaded.');
      for(const row of data || []) statuses.set(row.work_order_id,row.status);
    }
  }
  return orders.map(order=>({...order,parts_status:statuses.get(order.id)||null}));
}
