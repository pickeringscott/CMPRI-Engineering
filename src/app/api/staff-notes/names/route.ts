import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { profileHasRole } from '@/lib/server/roles';
const headers={'Cache-Control':'private, no-store'};
export async function POST(request:NextRequest){
  const auth=await requireUser(request);
  if(!auth)return NextResponse.json({error:'Sign in is required.'},{status:401,headers});
  if(!profileHasRole(auth.principal.profile,'front_desk'))return NextResponse.json({error:'This name capture is for the shared Front Desk account.'},{status:403,headers});
  const body=await request.json().catch(()=>null),name=typeof body?.name==='string'?body.name.trim().replace(/\s+/g,' '):'';
  if(!name||name.length>80||/^(front\s*desk|staff)$/i.test(name)||/[\x00-\x1f\x7f]/.test(name))return NextResponse.json({error:'Enter your name (80 characters maximum).'},{status:400,headers});
  const result=await auth.admin.rpc('cmpri_capture_staff_note_name',{p_hotel:auth.principal.hotelId,p_actor:auth.principal.identity.id,p_name:name});
  const target=Array.isArray(result.data)?result.data[0]:null;
  if(result.error||!target)return NextResponse.json({error:'Your name could not be saved. Try again.'},{status:503,headers});
  return NextResponse.json({id:target.id,name:target.name},{headers});
}
