import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {emailPushStatus,ensureEmailWatch} from '@/lib/server/email-push';
export const runtime='nodejs';
export const maxDuration=60;
export async function GET(request:NextRequest){
 if(!await requireCapability(request,'operate_integrations'))return NextResponse.json({error:'Integration operator access required'},{status:403});
 const admin=createSupabaseAdmin();if(!admin)return NextResponse.json({error:'Service configuration missing'},{status:503});
 try{return NextResponse.json(await emailPushStatus(admin),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'Push status unavailable'},{status:503});}
}
export async function POST(request:NextRequest){
 if(!await requireCapability(request,'operate_integrations'))return NextResponse.json({error:'Integration operator access required'},{status:403});
 const admin=createSupabaseAdmin();if(!admin)return NextResponse.json({error:'Service configuration missing'},{status:503});
 try{return NextResponse.json(await ensureEmailWatch(admin,true),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'Email push enrollment needs configuration or provider verification; inspect operator status'},{status:503});}
}
