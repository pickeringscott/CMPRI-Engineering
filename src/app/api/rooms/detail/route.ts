import {NextRequest,NextResponse} from 'next/server';
import {requireUser} from '@/lib/server/auth';
import {allows} from '@/lib/server/access';
import {HOTEL_ID} from '@/lib/constants';
import {loadLocationActivity} from '@/lib/server/location-activity';
import {fetchAllPages} from '@/lib/server/paginated-query';
import {PM_TEMPLATES} from '@/lib/pm/catalog';
import type {Location} from '@/lib/location-records';
const fail=(error:string,status:number)=>NextResponse.json({error},{status});
export async function GET(request:NextRequest){
 const auth=await requireUser(request);if(!auth)return fail('Sign in is required.',401);
 if(!allows(auth.principal,'view_pm'))return fail('Preventive Maintenance access is required.',403);
 const q=request.nextUrl.searchParams,kind=q.get('kind');
 try{
  if(kind==='history'){
   if(q.get('hotel')!==HOTEL_ID||!/^\d{2,4}$/.test(q.get('room')||'')||!/^\d{4}-\d{2}-\d{2}$/.test(q.get('period')||''))return fail('Invalid history identity.',400);
   const {data,error}=await auth.admin.from('cmpri_room_pm_history').select('hotel_id,room,period_start,completed_on,source_name,source_reference,item_answers,confirmed_by_name,confirmed_at').eq('hotel_id',HOTEL_ID).eq('room',q.get('room')!).eq('period_start',q.get('period')!).maybeSingle();
   if(error)return fail('PM history could not be loaded.',503);if(!data?.completed_on)return fail('Completed PM record not found.',404);
   return NextResponse.json({title:`Completed PM — Room ${data.room} — ${data.period_start}`,fields:data},{headers:{'Cache-Control':'no-store'}});
  }
  if(!['form','log','unresolved'].includes(kind||''))return fail('Unknown detail type.',400);
  const locations=await fetchAllPages<Location>((from,to)=>auth.admin.from('locations').select('id,area,name,room_number,location_type,active').eq('hotel_id',HOTEL_ID).eq('active',true).order('id').range(from,to));
  if(locations.error)return fail('Locations could not be loaded.',503);
  const activity=await loadLocationActivity(auth.admin,auth.principal,locations.data||[]);
  if(kind==='form'){
   const f=activity.equipment?.forms.find(f=>f.location_id===q.get('location')&&f.template_id===q.get('template')),t=PM_TEMPLATES.find(t=>t.id===q.get('template'));
   if(!f||!t)return fail('No supported form/location association found.',404);
   return NextResponse.json({title:t.title,fields:{location:locations.data?.find(l=>l.id===f.location_id)?.name,...f},items:f.item_ids.length?t.checklist.filter(i=>f.item_ids.includes(i.id)):t.checklist,form_fields:t.fields,repeatable_fields:t.repeatableFields},{headers:{'Cache-Control':'no-store'}});
  }
  if(kind==='log'){
   const p=activity.pm_logs.find(p=>p.id===q.get('id'));if(!p)return fail('PM record not found.',404);
   const t=PM_TEMPLATES.find(t=>t.id===p.template_id);
   return NextResponse.json({title:`${t?.title||p.template_id} — ${p.period_start}`,fields:{id:p.id,template_id:p.template_id,period_start:p.period_start,scope:p.scope_key,status:p.status,completed_on:p.payload.completed_on,notes:p.payload.notes,source:p.payload.historical_source_import},items:Object.entries(p.payload.responses||{}).map(([id,value])=>({id,label:t?.checklist.find(i=>i.id===id)?.label||id,value})),rows:p.payload.form_data?.logEntries||[]},{headers:{'Cache-Control':'no-store'}});
  }
  return NextResponse.json({title:'Unresolved PM source relationships',fields:activity.equipment?{counts:activity.equipment.counts,locations:activity.equipment.unmapped_locations,logs:activity.pm_logs.filter(p=>activity.equipment!.unmatched_log_ids.includes(p.id)).map(p=>({id:p.id,template_id:p.template_id,period:p.period_start})),rows:activity.equipment.unresolved_rows}:{}},{headers:{'Cache-Control':'no-store'}});
 }catch{return fail('PM details could not be loaded.',503);}
}
