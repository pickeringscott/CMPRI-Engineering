import {NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {HOTEL_ID} from '@/lib/constants';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 const secret=process.env.CRON_SECRET;
 if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`)return NextResponse.json({error:'Unauthorized'},{status:401});
 const admin=createSupabaseAdmin();if(!admin)return NextResponse.json({error:'Database unavailable'},{status:503});
 const {data,error}=await admin.from('pool_facilities').select('id').eq('hotel_id',HOTEL_ID).eq('active',true);
 if(error)return NextResponse.json({error:'Pool configuration unavailable'},{status:503});
 for(const f of data||[]){const r=await admin.rpc('cmpri_pool_reconcile',{p_hotel:HOTEL_ID,p_facility:f.id,p_new_event:false});if(r.error)return NextResponse.json({error:'Pool reconciliation failed'},{status:503});}
 return NextResponse.json({ok:true});
}
