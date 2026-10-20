import {NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {secretEqual} from '@/lib/server/drive-po-api';
import {drivePoEnabled,ensureDriveWatch,processDriveEvents} from '@/lib/server/drive-po';
export const runtime='nodejs';
export const maxDuration=300;
/** Renew channel lifecycle and retry queued push events. Never discover files without an event. */
export async function GET(request:NextRequest){
 const secret=process.env.CRON_SECRET;
 if(!secret||!secretEqual(request.headers.get('authorization')||'',`Bearer ${secret}`))return new NextResponse(null,{status:403});
 if(!drivePoEnabled())return NextResponse.json({status:'disabled'});
 const admin=createSupabaseAdmin();if(!admin)return new NextResponse(null,{status:503});
 try{
  const watch=await ensureDriveWatch(admin);
  const work=await processDriveEvents(admin);
  return NextResponse.json({watch,work},{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Drive maintenance failed; inspect operator status.'},{status:503});}
}
