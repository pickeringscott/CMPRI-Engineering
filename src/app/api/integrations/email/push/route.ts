import {after,NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {configuredEmailProvider} from '@/lib/integrations/email-provider';
import {emailPushEnabled,receiveEmailPush,processEmailPush} from '@/lib/server/email-push';
import {readPushBody} from '@/lib/server/email-push-auth';
export const runtime='nodejs';
export const maxDuration=300;
export async function POST(request:NextRequest){
 if(!emailPushEnabled())return new NextResponse(null,{status:503});
 // Graph validates a new callback before creating the subscription. Plain text only, bounded, no side effects.
 const validation=request.nextUrl.searchParams.get('validationToken');
 if(validation!==null){if(configuredEmailProvider()!=='microsoft365'||!validation||validation.length>4096)return new NextResponse(null,{status:400});return new NextResponse(validation,{headers:{'Content-Type':'text/plain','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
 const admin=createSupabaseAdmin();if(!admin)return new NextResponse(null,{status:503});
 let body;try{body=await readPushBody(request);}catch{return new NextResponse(null,{status:400});}
 try{
  const status=await receiveEmailPush(admin,request.headers,body);
  if(status===202)after(async()=>{const deadline=Date.now()+240000;try{for(let n=0;n<10&&Date.now()<deadline;n++){const r=await processEmailPush(admin);if(!['more-pending','processed'].includes(r.status))break;}}catch{/* Durable pending rows remain available to maintenance. */}});
  return new NextResponse(null,{status});
 }catch{return new NextResponse(null,{status:503});}
}
