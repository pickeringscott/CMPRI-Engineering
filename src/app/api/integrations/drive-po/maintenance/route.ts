import {NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {secretEqual} from '@/lib/server/drive-po-api';
import {drivePoEnabled,ensureDriveWatch,processDriveEvents} from '@/lib/server/drive-po';
import {ensureRankerWatch,processRankerWatch} from '@/lib/server/room-ranker-watch';
export const runtime='nodejs';
export const maxDuration=300;
/** Renew channel lifecycle and retry queued push events. Never discover files without an event. */
export async function GET(request:NextRequest){
 const secret=process.env.CRON_SECRET;
 if(!secret||!secretEqual(request.headers.get('authorization')||'',`Bearer ${secret}`))return new NextResponse(null,{status:403});

 const admin=createSupabaseAdmin();if(!admin)return new NextResponse(null,{status:503});
 try{
  const watch=drivePoEnabled()?await ensureDriveWatch(admin):{status:'disabled'};
  const work=drivePoEnabled()?await processDriveEvents(admin):{status:'disabled'};
  const ranker={watch:await ensureRankerWatch(admin),work:await processRankerWatch(admin)};
  return NextResponse.json({watch,work,ranker},{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Drive maintenance failed; inspect operator status.'},{status:503});}
}
