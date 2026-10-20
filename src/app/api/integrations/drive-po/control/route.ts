import {after,NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {drivePoStatus,ensureDriveWatch,processDriveEvents} from '@/lib/server/drive-po';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return NextResponse.json({error:'Integration operator required'},{status:403});
 try{return NextResponse.json(await drivePoStatus(auth.admin,request.nextUrl.searchParams.get('checkAccess')==='1'),{headers:{'Cache-Control':'no-store'}});}
 catch{return NextResponse.json({error:'Drive intake status unavailable'},{status:503});}
}
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return NextResponse.json({error:'Integration operator required'},{status:403});
 // Exact explicit action; no folder/account/actor supplied by the client.
 if(Number(request.headers.get('content-length')||0)>128)return NextResponse.json({error:'Request too large'},{status:413});
 const reader=request.body?.getReader();let text='';
 if(reader){const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});if(text.length>128)return NextResponse.json({error:'Request too large'},{status:413});}text+=decoder.decode();}finally{await reader.cancel();}}
 let body;try{body=JSON.parse(text);}catch{return NextResponse.json({error:'Invalid request'},{status:400});}
 if(body?.action!=='activate'||Object.keys(body).length!==1)return NextResponse.json({error:'Explicit activate action required'},{status:400});
 try{const result=await ensureDriveWatch(auth.admin,true);after(async()=>{try{await processDriveEvents(auth.admin);}catch{/* Pending event and stored error remain visible. */}});
  return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Watch activation not confirmed. Inspect status and access before retrying.'},{status:503});}
}
