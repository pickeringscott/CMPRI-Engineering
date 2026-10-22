import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {HOTEL_ID} from '@/lib/constants';
import {fetchAllPages} from '@/lib/server/paginated-query';
const validId=(s:unknown):s is string=>typeof s==='string'&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(s);
export async function GET(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');if(!auth)return NextResponse.json({error:'Parts-management permission required.'},{status:403});
 if(process.env.CMPRI_PO_ENABLED!=='true')return NextResponse.json({error:'Supply receiving and usage are not enabled.'},{status:409});
 const job=request.nextUrl.searchParams.get('job');if(!validId(job))return NextResponse.json({error:'Invalid work order.'},{status:400});
 const found=await auth.admin.from('work_orders').select('id').eq('hotel_id',HOTEL_ID).eq('id',job).maybeSingle();if(found.error||!found.data)return NextResponse.json({error:'Work order unavailable.'},{status:404});
 const [items,uses]=await Promise.all([fetchAllPages((from,to)=>auth.admin.from('cmpri_inventory_items').select('id,item_name,quantity_on_hand,quantity_reserved,unit_of_measure').eq('hotel_id',HOTEL_ID).eq('active',true).order('id').range(from,to)),fetchAllPages((from,to)=>auth.admin.from('cmpri_supply_uses').select('*').eq('hotel_id',HOTEL_ID).eq('work_order_id',job).order('id').range(from,to))]);
 if(items.error||uses.error)return NextResponse.json({error:'Supplies data unavailable.'},{status:503});
 return NextResponse.json({items:items.data,uses:uses.data,costingReady:false},{headers:{'Cache-Control':'no-store'}});
}
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');if(!auth)return NextResponse.json({error:'Parts-management permission required.'},{status:403});
 if(process.env.CMPRI_PO_ENABLED!=='true')return NextResponse.json({error:'Supply receiving and usage are not enabled.'},{status:409});
 try{const b=await request.json();if(!validId(b.id)||!validId(b.job)||!validId(b.item)||typeof b.quantity!=='number'||!Number.isFinite(b.quantity)||b.quantity<=0||typeof b.note!=='string'||!b.note.trim()||b.note.length>1000||b.confirmed!==true)return NextResponse.json({error:'Confirm supply, quantity and usage note.'},{status:400});
 const r=await auth.admin.rpc(b.unit?'cmpri_use_supply_unit':'cmpri_use_supply',{p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_id:b.id,p_job:b.job,p_item:b.item,p_quantity:b.quantity,p_note:b.note.trim(),...(b.unit?{p_unit:b.unit}:{})});
 if(r.error)return NextResponse.json({error:r.error.message},{status:400});return NextResponse.json({id:r.data});
 }catch{return NextResponse.json({error:'Invalid supply-use request.'},{status:400});}
}
