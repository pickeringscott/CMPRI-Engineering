import {wholePoCount,poHotelDate,receivedPoSpending} from '@/lib/po-workflow';
import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {HOTEL_ID,HOTEL_TIME_ZONE} from '@/lib/constants';
import {fetchAllPages} from '@/lib/server/paginated-query';
const enabled=()=>process.env.CMPRI_PO_ENABLED==='true';
const tables=['cmpri_po_orders','cmpri_po_lines','cmpri_po_receipts','cmpri_po_shipments','cmpri_po_sources','cmpri_inventory_items'] as const;
export async function GET(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');
 if(!auth)return NextResponse.json({error:'Parts-management permission required.'},{status:403});
 if(!enabled())return NextResponse.json({error:'PO receiving is not enabled for release.'},{status:409});
 const results=await Promise.all(tables.map(table=>fetchAllPages((from,to)=>auth.admin.from(table).select('*').eq('hotel_id',HOTEL_ID).order('id').range(from,to))));
 if(results.some(r=>r.error))return NextResponse.json({error:'PO data is unavailable. Confirm the receiving migration is installed.'},{status:503});
 const data=Object.fromEntries(tables.map((name,i)=>[name,results[i].data||[]]));
 return NextResponse.json({...data,spending:receivedPoSpending(data.cmpri_po_lines,data.cmpri_po_receipts,new Date(),HOTEL_TIME_ZONE)},{headers:{'Cache-Control':'no-store'}});
}
const text=(v:unknown,max=1000)=>{if(typeof v!=='string'||v.length>max)throw Error('Invalid text');return v.trim();};
const uuid=(v:unknown)=>{const s=text(v,36);if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(s))throw Error('Invalid identifier');return s;};
const quantity=(v:unknown)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>999999999||Math.abs(v*1000-Math.round(v*1000))>1e-6)throw Error('Invalid quantity');return v;};
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');
 if(!auth)return NextResponse.json({error:'Parts-management permission required.'},{status:403});
 if(!enabled())return NextResponse.json({error:'PO receiving is not enabled for release.'},{status:409});
 let receiptRpcStarted=false;
 try{
  const body=await request.json();const common={p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_id:uuid(body.id)};
  let result;
  if(body.action==='manual')result=await auth.admin.rpc('cmpri_create_manual_po',{...common,p_supplier:text(body.supplier,200),p_reference:text(body.reference||'',200),p_description:text(body.description,1000),p_quantity:wholePoCount(body.quantity),p_uom:text(body.uom,30)});
  else if(body.action==='add-item'){
   result=await auth.admin.rpc('cmpri_po_add_item',{...common,p_order:uuid(body.orderId),p_item:body.itemId?uuid(body.itemId):null,p_description:text(body.description,1000),p_quantity:quantity(body.quantity),p_unit:text(body.uom,10),p_package:body.packageSize==null?null:quantity(body.packageSize),p_content:body.contentUnit?text(body.contentUnit,10):null,p_sku:text(body.sku||'',200),p_price:body.price==null?null:body.price});
  }else if(body.action==='receive-total'){
   if(body.physicallyReceived!==true)throw Error('Confirm physical receipt');
   const total=body.total,expected=body.expectedReceived;
   if(typeof total!=='number'||typeof expected!=='number'||!Number.isFinite(total)||!Number.isFinite(expected)||expected<0||total<expected||total>999999999||Math.abs(total*1000-Math.round(total*1000))>1e-6||Math.abs(expected*1000-Math.round(expected*1000))>1e-6)throw Error('Invalid cumulative physical count');
   const line=await auth.admin.from('cmpri_po_lines').select('uom').eq('hotel_id',HOTEL_ID).eq('id',uuid(body.lineId)).single();
   if(line.error||!line.data)throw Error('Order line not found');
   if(!['LB','OZ','G','KG'].includes(line.data.uom)&&(!Number.isSafeInteger(total)||!Number.isSafeInteger(expected)))throw Error('Packages require whole received counts');
   receiptRpcStarted=true;
   result=await auth.admin.rpc('cmpri_receive_po_total',{...common,p_line:uuid(body.lineId),p_total:total,p_expected:expected,p_date:poHotelDate(new Date(),HOTEL_TIME_ZONE)});
   if(result.error?.code==='40001')return NextResponse.json({error:result.error.message},{status:409});
  }else if(body.action==='receive'){
   if(body.physicallyReceived!==true)throw Error('Confirm physical receipt');
   wholePoCount(body.quantity);
   const lineCheck=await auth.admin.from('cmpri_po_lines').select('ordered').eq('hotel_id',HOTEL_ID).eq('id',uuid(body.lineId)).single();
   if(lineCheck.error||!lineCheck.data)throw Error('Order line not found');
   if(!Number.isInteger(Number(lineCheck.data.ordered)))throw Error('Existing fractional order quantity requires review; it has not been rounded.');
   const priorReceipts=await auth.admin.from('cmpri_po_receipts').select('quantity').eq('hotel_id',HOTEL_ID).eq('line_id',uuid(body.lineId));
   if(priorReceipts.error)throw Error('Could not verify previous receipts');
   if((priorReceipts.data||[]).some(r=>!Number.isInteger(Number(r.quantity))))throw Error('Existing fractional receipt quantity requires review; it has not been rounded.');
   let date:string;
   if(body.receiveNow===true){
    // Retain the original server date for an uncertain retry, including across midnight.
    const prior=await auth.admin.from('cmpri_po_receipts').select('received_date').eq('hotel_id',HOTEL_ID).eq('id',common.p_id);
    if(prior.error)throw Error('Could not verify receipt retry');
    date=prior.data?.[0]?.received_date||poHotelDate(new Date(),HOTEL_TIME_ZONE);
   }else date=text(body.date,10);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date)throw Error('Invalid receipt date');
   const params={...common,p_line:uuid(body.lineId),p_quantity:wholePoCount(body.quantity),p_date:date,p_note:body.receiveNow===true?'Physically counted and put away via PO Confirm.':text(body.note)};
   receiptRpcStarted=true;
   result=await auth.admin.rpc('cmpri_receive_po',params);
  }else if(body.action==='link'){
   result=await auth.admin.rpc('cmpri_link_po_line',{p_hotel:HOTEL_ID,p_line:common.p_id,p_item:uuid(body.itemId),p_factor:quantity(body.factor)});
  }else if(body.action==='accept'){
   const orderCheck=await auth.admin.from('cmpri_po_orders').select('origin').eq('hotel_id',HOTEL_ID).eq('id',common.p_id).single();
   if(orderCheck.error||!orderCheck.data)throw Error('Order not found');
   if(orderCheck.data.origin==='manual')throw Error('Manually entered orders do not require additional CMPRI approval');
   const note=text(body.note);if(!note)throw Error('Company approval evidence is required');
   result=await auth.admin.from('cmpri_po_orders').update({acceptance:'accepted',acceptance_note:note,accepted_by:common.p_actor,accepted_at:new Date().toISOString()}).eq('hotel_id',HOTEL_ID).eq('id',common.p_id).select('id').single();
  }else return NextResponse.json({error:'Unsupported PO action.'},{status:400});
  if(result.error)return NextResponse.json({error:result.error.message},{status:receiptRpcStarted&&!/^(P0001|22|23)/.test(result.error.code||'')?503:400});
  return NextResponse.json({id:result.data});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Invalid request'},{status:receiptRpcStarted?503:400});}
}
