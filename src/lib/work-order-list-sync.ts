type Row={id:string;revision?:unknown;[key:string]:unknown};
const fields=['id','revision','updated_at','display_id','room','location_id','asset_id','asset_name','category','issue','priority','parts_status','technician_name','status','due_by','created_at','import_source','import_external_id','room_status','checkout_date','checkout_time','cn_room','guest_name','incoming_name','loyalty_tier','guest_group_badge','incoming_group_badge','incoming_loyalty_tier','incoming_reserved'];
/** Use confirmed API rows only, never unsaved form state or room-number matches. */
export function workOrderListSnapshot(value:unknown):Row|null{
 if(!value||typeof value!=='object')return null;const row=value as Row;
 if(typeof row.id!=='string'||!row.id||!Number.isSafeInteger(row.revision))return null;
 return Object.fromEntries(fields.filter(k=>k in row).map(k=>[k,row[k]])) as Row;
}
export function mergeConfirmedWorkOrder<T extends Row>(rows:T[],value:unknown):T[]{
 const next=workOrderListSnapshot(value);if(!next)return rows;
 return rows.map(row=>row.id!==next.id||Number(row.revision??-1)>Number(next.revision)?row:{...row,...next});
}
export function reconcileWorkOrderList<T extends Row>(previous:T[],incoming:T[]):T[]{
 const existing=new Map(previous.map(row=>[row.id,row]));return incoming.map(row=>{const old=existing.get(row.id);return old&&Number(old.revision??-1)>Number(row.revision??-1)?old:row;});
}
