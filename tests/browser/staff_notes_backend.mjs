import http from 'node:http';
import * as references from '../../src/lib/work-order-reference.js';
import * as targets from '../../src/lib/staff-note-targets.ts';
import * as notesPolicy from '../../src/lib/staff-notes.ts';
import * as flags from '../../src/lib/staff-note-flags.ts';
import * as media from '../../src/lib/staff-note-media.ts';
import * as roles from '../../src/lib/server/roles.ts';
import * as schedule from '../../src/lib/notifications/schedule.ts';
import {workOrderReader} from '../../src/lib/server/work-order-reader.ts';
import {canReadWorkOrder} from '../../src/lib/work-order-read-policy.ts';
import {staffNoteDirectory} from '../../src/lib/server/staff-note-directory.ts';
import {fetchAllPages} from '../../src/lib/server/paginated-query.ts';
import {staffNotesDatabase,staffProfiles,staffId,staffHotel,foreignHotel} from '../helpers/staff-notes-db.mjs';
import {staffNotesAdmin} from '../helpers/staff-notes-admin.mjs';
import {loadTs} from '../helpers/load-ts.mjs';
const db=await staffNotesDatabase(),admin=staffNotesAdmin(db),sent=[],failures=[];
let nowOverride=null,failNextPost=false;
class Clock extends Date{constructor(...args){super(...(args.length?args:[nowOverride||Date.now()]))}static now(){return nowOverride?Date.parse(nowOverride):Date.now()}}
const eligibility=loadTs('src/lib/notifications/event-eligibility.ts',{'@/lib/server/roles':roles});
const push=loadTs('src/lib/notifications/web-push.ts',{
 'web-push':{default:{setVapidDetails(){},async sendNotification(subscription,payload){sent.push({recipient:subscription.endpoint.split('/').at(-1),payload:JSON.parse(payload)})}}},
 '@/lib/constants':{HOTEL_ID:staffHotel},'@/lib/notifications/schedule':schedule,'@/lib/notifications/event-eligibility':eligibility,
},{Date:Clock,console,process:{env:{WEB_PUSH_VAPID_PUBLIC_KEY:'synthetic',WEB_PUSH_VAPID_PRIVATE_KEY:'synthetic',WEB_PUSH_VAPID_SUBJECT:'mailto:fixture@example.invalid'}}});
let afters=[];
async function requireUser(request){
 const id=request.headers.get('authorization')?.replace(/^Bearer fixture:/,'');if(!id||!/^[0-9a-f-]{36}$/.test(id))return null;
 const profile=(await db.query('select * from profiles where id=$1 and active',[id])).rows[0];
 const hotel=request.headers.get('x-fixture-hotel')||staffHotel;
 const membership=(await db.query('select * from hotel_members where user_id=$1 and hotel_id=$2 and active',[id,hotel])).rows[0];
 if(!profile||!membership)return null;
 return {admin,principal:{identity:{id,email:profile.email},hotelId:hotel,profile,membership:{...membership,role:profile.role},permissions:[]}};
}
const dependencies={
 'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status||200})},after:task=>afters.push(task)},
 '@/lib/server/auth':{requireUser},'@/lib/server/work-order-reader':{workOrderReader},'@/lib/work-order-read-policy':{canReadWorkOrder},
 '@/lib/server/staff-note-directory':{staffNoteDirectory},'@/lib/server/paginated-query':{fetchAllPages},'@/lib/staff-notes':notesPolicy,'@/lib/staff-note-targets':targets,'@/lib/staff-note-flags':flags,
 '@/lib/work-order-reference.js':references,'@/lib/server/roles':roles,'@/lib/notifications/schedule':schedule,'@/lib/staff-note-media':media,'@/lib/notifications/web-push':push,
};
const api=loadTs('src/app/api/staff-notes/route.ts',dependencies,{Date:Clock,console});
const names=loadTs('src/app/api/staff-notes/names/route.ts',dependencies,{Date:Clock,console});
const referenceApi=loadTs('src/app/api/work-orders/references/route.ts',dependencies,{Date:Clock,console});
const serialize=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?Number(v):v);
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:3127'),chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  const request={headers:new Headers(req.headers),nextUrl:url,json:async()=>body};let response;
  if(url.pathname==='/fixture/state')response={body:{notes:(await db.query('select * from cmpri_staff_notes order by created_at,id')).rows,notifications:(await db.query('select * from cmpri_dashboard_notifications')).rows,deliveries:(await db.query('select * from cmpri_web_push_deliveries')).rows,names:(await db.query('select * from cmpri_staff_note_names')).rows,sent,failures,untouched:(await db.query('select * from untouched')).rows,profiles:(await db.query('select * from profiles')).rows}};
  else if(url.pathname==='/fixture/control'){
   if(body.now!==undefined)nowOverride=body.now;if(body.failNextPost!==undefined)failNextPost=body.failNextPost;
   if(body.rename)await db.query('update profiles set full_name=$1 where id=$2',[body.rename.name,body.rename.id]);
   if(body.clearNotes)await db.exec('delete from cmpri_web_push_deliveries;delete from cmpri_dashboard_notifications;delete from cmpri_staff_notes;');
   if(body.seed){for(const note of body.seed)await db.query('insert into cmpri_staff_notes(id,hotel_id,author_user_id,author_name,body,request_id,created_at) values($1,$2,$3,$4,$5,$6,$7)',[note.id||crypto.randomUUID(),staffHotel,staffId(2),'Scott',note.body||'Date-boundary fixture',crypto.randomUUID(),note.created_at])}
   response={body:{ok:true}};
  }else if(url.pathname==='/fixture/ticket'){
   const auth=await requireUser(request),row=(await db.query('select * from work_orders where id=$1',[url.searchParams.get('id')])).rows[0];
   response=auth&&row&&canReadWorkOrder(workOrderReader(auth.principal),row)?{body:{workOrder:{...row,revision:1,created_by:staffId(2),created_at:new Date().toISOString(),notes:''}}}:{status:403,body:{error:'Forbidden'}};
  }else{
   const handler=url.pathname==='/api/staff-notes/names'?names:url.pathname==='/api/work-orders/references'?referenceApi:api;
   if(req.method==='POST'&&url.pathname==='/api/staff-notes'&&failNextPost){failNextPost=false;response={status:503,body:{error:'Fixture save failed; retain draft.'}}}
   else response=await handler[req.method](request);
   const tasks=afters;afters=[];await Promise.allSettled(tasks.map(task=>task()));
  }
  res.writeHead(response.status||200,{'Content-Type':'application/json'});res.end(serialize(response.body));
 }catch(error){failures.push(error.stack);res.writeHead(500,{'Content-Type':'application/json'});res.end(serialize({error:error.message}));}
});
server.keepAliveTimeout=60000;server.headersTimeout=65000;
server.listen(3127,'127.0.0.1',()=>console.log(serialize({ready:true,hotel:staffHotel,users:staffProfiles.map(p=>({id:p.id,role:p.role})),foreignHotel})));
for(const event of ['SIGTERM','SIGINT'])process.on(event,()=>{server.close();void db.close().then(()=>process.exit(0))});
