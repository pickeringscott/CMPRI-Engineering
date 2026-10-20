import {after,NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {drivePoEnabled,receiveDriveNotification,processDriveEvents} from '@/lib/server/drive-po';
export const runtime='nodejs';
export const maxDuration=300;
export async function POST(request:NextRequest){
 if(!drivePoEnabled())return new NextResponse(null,{status:503});
 const admin=createSupabaseAdmin();if(!admin)return new NextResponse(null,{status:503});
 // Google sends headers only. Bound any unexpected body before reading it.
 if(Number(request.headers.get('content-length')||0)>0)return new NextResponse(null,{status:400});
 try{
  const status=await receiveDriveNotification(admin,request.headers);
  if(status===202)after(async()=>{try{await processDriveEvents(admin);}catch{/* Durable pending event is retried by maintenance; error recorded in state. */}});
  return new NextResponse(null,{status});
 }catch{return new NextResponse(null,{status:503});}
}
