import {NextRequest, NextResponse} from 'next/server';
import {requireUser} from '@/lib/server/auth';
import {roleKey} from '@/lib/server/roles';
import {HOTEL_ID} from '@/lib/constants';
import {poolCurrentClosureReasons} from '@/lib/pool-log';

async function respond(request:NextRequest, write:boolean, verified?:Awaited<ReturnType<typeof requireUser>>) {
 const auth=verified === undefined ? await requireUser(request) : verified;
 if(!auth||roleKey(auth.principal.profile.role)==='unknown')return NextResponse.json({error:'Sign in to CMPRI.'},{status:401});
 const {data:facilities,error}=await auth.admin.from('pool_facilities').select('id').eq('hotel_id',HOTEL_ID).eq('active',true).order('id').limit(1);
 if(error||!facilities?.[0])return NextResponse.json({error:'Pool configuration unavailable.'},{status:503});
 const facility=facilities[0].id;
 let result;
 if(write){
  const b=await request.json().catch(()=>null);
  if(!b||typeof b.id!=='string'||! /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.id)||!Number.isSafeInteger(b.expectedRevision)||typeof b.reason!=='string'||b.reason.length>1000)
   return NextResponse.json({error:'Invalid pool action.'},{status:400});
  const action=b.action==='pool-clear-manual'?'clear-manual':b.action==='pool-status'&&typeof b.closed==='boolean'?(b.closed?'close':'open'):null;
  if(!action)return NextResponse.json({error:'Unsupported pool action.'},{status:400});
  result=await auth.admin.rpc('cmpri_pool_action',{p_hotel:HOTEL_ID,p_facility:facility,p_actor:auth.principal.identity.id,p_id:b.id,p_action:action,p_reason:b.reason,p_revision:b.expectedRevision});
 }else result=await auth.admin.rpc('cmpri_pool_reconcile',{p_hotel:HOTEL_ID,p_facility:facility,p_new_event:false});
 if(result.error)return NextResponse.json({error:result.error.code==='P0001'||result.error.code==='40001'?result.error.message:'Pool status could not be saved or loaded.'},{status:result.error.code==='40001'?409:result.error.code==='P0001'?403:503});
 const s=result.data;
 const failures=s.log?poolCurrentClosureReasons(s.log):[];
 const reason=failures.length?failures.join('\n'):s.reason;
 const notices=await auth.admin.from('cmpri_dashboard_notifications').select('notification_key,message').eq('hotel_id',HOTEL_ID).eq('recipient_user_id',auth.principal.identity.id).like('notification_key','pool-closed:status:%').is('cleared_at',null).order('recorded_at',{ascending:false}).limit(1);
 if(notices.error)return NextResponse.json({error:'Pool notifications unavailable.'},{status:503});
 return NextResponse.json({closed:s.closed,reason,revision:s.revision,hours_closed:s.hours_closed,manual_closed:s.manual_closed,
 notifications:(notices.data||[]).map(n=>({id:n.notification_key,reason:n.message.replace(/^Pool closed: /,'')}))},{headers:{'Cache-Control':'no-store'}});
}
export async function getPoolStatus(request:NextRequest, verified?:Awaited<ReturnType<typeof requireUser>>){return respond(request,false,verified);}
export async function postPoolStatus(request:NextRequest){return respond(request,true);}
