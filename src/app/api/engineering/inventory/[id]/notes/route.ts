import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {HOTEL_ID} from '@/lib/constants';
import {isUuid} from '@/lib/uuid';
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
 const auth=await requireCapability(request,'manage_assets');
 if(!auth)return NextResponse.json({error:'Inventory access required.'},{status:403});
 const {id}=await params,q=request.nextUrl.searchParams.get('q')||'',cursor=request.nextUrl.searchParams.get('before');
 const [before,beforeId]=cursor?cursor.split('|'):[];
 if(!isUuid(id)||q.length>200||(cursor&&(!before||!Number.isFinite(Date.parse(before))||!isUuid(beforeId))))return NextResponse.json({error:'Invalid stock-note request.'},{status:400});
 const {data,error}=await auth.admin.rpc('cmpri_inventory_history',{p_hotel:HOTEL_ID,p_item:id,p_query:q,p_before:before||null,p_before_id:beforeId||null});
 if(error)return NextResponse.json({error:'Stock notes could not be loaded.'},{status:503});
 if(!data?.item)return NextResponse.json({error:'Inventory item unavailable.'},{status:404});
 return NextResponse.json(data,{headers:{'Cache-Control':'private, no-store'}});
}
