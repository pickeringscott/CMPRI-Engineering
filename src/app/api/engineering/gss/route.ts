import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {allows} from '@/lib/server/access';
import {HOTEL_ID} from '@/lib/constants';
import {publishGss} from '@/lib/server/gss-publication';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request:NextRequest){
 const auth=await requireCapability(request,'view_engineering_operations');if(!auth)return NextResponse.json({error:'Report access required'},{status:403});
 const result=await auth.admin.from('cmpri_gss_publications').select('report').eq('hotel_id',HOTEL_ID).order('report_date',{ascending:false}).limit(4);
 if(result.error)return NextResponse.json({error:'Saved GSS publications unavailable'},{status:503});
 return NextResponse.json({reports:(result.data||[]).map(row=>row.report),canRefresh:allows(auth.principal,'operate_integrations')},{headers:{'Cache-Control':'private, no-store'}});
}
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return NextResponse.json({error:'Integration operator required'},{status:403});
 try{return NextResponse.json(await publishGss(auth.admin,true));}catch{return NextResponse.json({error:'Report could not be verified; previous publication retained. Retry after the current publication lease expires.'},{status:503});}
}
