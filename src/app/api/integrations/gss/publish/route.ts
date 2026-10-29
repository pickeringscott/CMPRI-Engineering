import {NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {secretEqual} from '@/lib/server/drive-po-api';
import {publishGss} from '@/lib/server/gss-publication';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request:NextRequest){
 const secret=process.env.CRON_SECRET;if(!secret||!secretEqual(request.headers.get('authorization')||'',`Bearer ${secret}`))return new NextResponse(null,{status:403});
 const admin=createSupabaseAdmin();if(!admin)return new NextResponse(null,{status:503});
 try{return NextResponse.json(await publishGss(admin));}catch{return NextResponse.json({error:'GSS publication unverified; previous report retained'},{status:503});}
}
