import {after,NextRequest,NextResponse} from 'next/server';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {receiveRankerWatch,processRankerWatch} from '@/lib/server/room-ranker-watch';
export const runtime='nodejs';
export async function POST(request:NextRequest){
 if(Number(request.headers.get('content-length')||0)>0)return new NextResponse(null,{status:400});
 const admin=createSupabaseAdmin();if(!admin)return new NextResponse(null,{status:503});
 try{const status=await receiveRankerWatch(admin,request.headers);if(status===202)after(async()=>{try{await processRankerWatch(admin);}catch{/* Durable receipt remains pending. */}});return new NextResponse(null,{status});}
 catch{return new NextResponse(null,{status:503});}
}
