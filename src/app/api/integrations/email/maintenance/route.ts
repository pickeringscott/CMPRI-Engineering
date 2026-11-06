import {NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {emailPushEnabled,ensureEmailWatch,processEmailPush} from '@/lib/server/email-push';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request:NextRequest){
 const secret=process.env.CRON_SECRET;if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`)return NextResponse.json({error:'Unauthorized'},{status:401});
 if(!emailPushEnabled())return NextResponse.json({status:'disabled'});
 const admin=createSupabaseAdmin();if(!admin)return NextResponse.json({error:'Service configuration missing'},{status:503});
 try{let watch;try{watch=await ensureEmailWatch(admin)}catch{watch={status:"renewal-needs-attention"}}const results=[];const deadline=Date.now()+240000;for(let n=0;n<10&&Date.now()<deadline;n++){const result=await processEmailPush(admin);results.push(result);if(!['processed','more-pending'].includes(result.status))break;}return NextResponse.json({watch,results});}
 catch{return NextResponse.json({error:'Email push maintenance needs operator attention; pending events retained'},{status:503});}
}
