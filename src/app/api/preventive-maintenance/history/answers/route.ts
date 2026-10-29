import sourceRooms from '@/lib/pm/historical-page-rooms.json';
import {NextRequest,NextResponse} from 'next/server';
import {requireUser} from '@/lib/server/auth';
import {profileHasRole} from '@/lib/server/roles';
import {HOTEL_ID} from '@/lib/constants';
import {findPmTemplate} from '@/lib/pm/catalog';
export async function POST(request:NextRequest){
 const auth=await requireUser(request);
 if(!auth)return NextResponse.json({error:'Sign in required.'},{status:401});
 if(!profileHasRole(auth.principal.profile,'engineer')&&!profileHasRole(auth.principal.profile,'system_admin'))return NextResponse.json({error:'PM reviewer required.'},{status:403});
 let rows;
 try{
  const raw=await request.text();if(raw.length>3000000)throw Error();
  const body=JSON.parse(raw);rows=body.rows;if(!Array.isArray(rows)||rows.length>245)throw Error();
  const ids=new Set(findPmTemplate('pdf:room-pm-checklist')?.checklist.map(i=>i.id));
  const keys=new Set();
  for(const row of rows){
   const key=row.room+':'+row.periodStart;if(keys.has(key))throw Error();keys.add(key);
   if(!/^\d{3}$/.test(row.room)||!/^2026-(01|04|07|10)-01$/.test(row.periodStart)||!/^2026-\d{2}-\d{2}$/.test(row.completedOn)||!row.answers||Array.isArray(row.answers)||typeof row.answers!=='object')throw Error();
   for(const [id,value] of Object.entries(row.answers)){
    const a=value as Record<string,unknown>;
    if(!ids.has(id)||!a||(sourceRooms as Record<string,string>)[String(a.sourcePage)]!==row.room||!['complete','follow-up','na'].includes(String(a.value))||!Number.isInteger(a.sourcePage)||Number(a.sourcePage)<43||Number(a.sourcePage)>150||typeof a.evidence!=='string'||!a.evidence.trim()||a.evidence.length>2000||Object.keys(a).some(k=>!['value','sourcePage','evidence'].includes(k)))throw Error();
   }
  }
 }catch{return NextResponse.json({error:'Provide the exact reviewed room/quarter/date/item/source-page batch.'},{status:400});}
 const result=await auth.admin.rpc('cmpri_import_room_pm_answers',{p_hotel:HOTEL_ID,p_rows:rows,p_actor:auth.principal.identity.id});
 if(result.error)return NextResponse.json({error:'Historical conflict or unavailable batch. Re-read before retrying.'},{status:409});
 return NextResponse.json({changed:result.data},{headers:{'Cache-Control':'no-store'}});
}
