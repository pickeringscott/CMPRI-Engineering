import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {ensureRankerWatch,rankerWatchStatus,processRankerWatch} from '@/lib/server/room-ranker-watch';
import {createSupabaseAdmin} from '@/lib/server/supabase-admin';
import {secretEqual} from '@/lib/server/drive-po-api';
export const runtime='nodejs';
export async function GET(request:NextRequest){
 const secret=process.env.CRON_SECRET;
 const cron=!!secret&&secretEqual(request.headers.get('authorization')||'',`Bearer ${secret}`);
 const auth=cron?null:await requireCapability(request,'operate_integrations');
 const admin=cron?createSupabaseAdmin():auth?.admin;if(!admin)return NextResponse.json({error:'Integration operator required'},{status:403});
 try{return NextResponse.json(cron?{watch:await ensureRankerWatch(admin),work:await processRankerWatch(admin)}:{channels:await rankerWatchStatus(admin)},{headers:{'Cache-Control':'no-store'}});}
 catch{return NextResponse.json({error:'Ranker watch unavailable; no registration outcome assumed'},{status:503});}
}
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return NextResponse.json({error:'Integration operator required'},{status:403});
 // Fixed endpoint, target file and existing credential. No client-supplied provider URLs or scopes.
 let body='';const reader=request.body?.getReader();if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;body+=new TextDecoder().decode(value);if(body.length>128)return NextResponse.json({error:'Invalid activation'},{status:400});}}finally{await reader.cancel();}}
 let value;try{value=JSON.parse(body);}catch{return NextResponse.json({error:'Invalid activation'},{status:400});}
 if(value?.action!=='activate'||Object.keys(value).length!==1)return NextResponse.json({error:'Explicit activation required'},{status:400});
 try{return NextResponse.json(await ensureRankerWatch(auth.admin,true));}catch{return NextResponse.json({error:'Registration unconfirmed; inspect status before retrying'},{status:503});}
}
