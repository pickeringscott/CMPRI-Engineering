import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
import * as model from '../src/lib/notepad.ts';
import * as documentTools from '../src/lib/server/notepad-document.ts';
import * as media from '../src/lib/staff-note-media.ts';
import { notepadDirectory,resolveNotepadAttachment,signNotepadAttachments } from '../src/lib/server/notepad-store.ts';
import * as preferencesTools from '../src/lib/profile-preferences.ts';

const hotel='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002';
const owner='00000000-0000-4000-8000-000000000003',id='00000000-0000-4000-8000-000000000004';
const change='00000000-0000-4000-8000-000000000005',fileId='00000000-0000-4000-8000-000000000006';
const at='2026-11-23T14:00:00.000Z';
const document=()=>({title:'Project',audience:{all:false,roles:['engineer'],people:[]},content:'<p data-item-id="item">Work</p>',priority:'Normal',fontSize:16,fontFamily:'Arial',titleFontFamily:'Georgia',ink:[],itemThreads:{},attachments:[]});
const json=(body,init={})=>({body,status:init.status||200,headers:init.headers});
const request=(body,url='https://fixture.invalid/api/notepad')=>({headers:new Headers({'x-cmpri-property':hotel}),nextUrl:new URL(url),body:new Response(JSON.stringify(body)).body,json:async()=>body});
function fixture(){
 let signed=true,rpcError=null,preferences={},profile={role:'chief_engineer'};
 const calls=[],state={hotelId:hotel,userId:actor,people:[{id:actor,active:true,taggable:true}],roles:[],notes:[],rows:[],order:[],legacyAliases:{}},uploads=[];
 const admin={from(table){calls.push(['table',table]);const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{preferences},error:null}),in(){return Promise.resolve({data:uploads,error:null})},upsert:async row=>{calls.push(['order',row]);return{error:null}}};return q},rpc:async(name,args)=>{calls.push([name,args]);return {error:rpcError,data:{id:args.p_id,hotel_id:args.p_hotel,author_user_id:state.notes[0]?.authorId||actor,document:args.p_document,revision:2,created_at:at,updated_at:at,deleted_at:args.p_document?null:at}}}};
 const route=loadTs('src/app/api/notepad/route.ts',{'next/server':{NextResponse:{json}},'@/lib/server/auth':{requireUser:async()=>signed?{principal:{hotelId:hotel,identity:{id:actor},profile},admin}:null},'@/lib/notepad':model,'@/lib/profile-preferences':preferencesTools,'@/lib/server/notepad-document':documentTools,'@/lib/server/notepad-store':{loadNotepad:async(_admin,property,user)=>{calls.push(['load',property,user]);return state},projectNotepadRow:row=>row.document?{...row.document,id:row.id,authorId:row.author_user_id,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at}:null,signNotepadAttachments:async()=>{}}},{TextDecoder});
 return{route,calls,state,uploads,setSigned:value=>signed=value,setRpcError:value=>rpcError=value,setProfile:(next,setting)=>{profile=next;preferences=setting},body:()=>({id,expectedRevision:null,changeId:change,document:document()})};
}
test('Notepad APIs bind every load and mutation to the active principal and reject tenant or ownership injection',async()=>{
 const f=fixture();assert.equal((await f.route.GET(request(null))).status,200);assert.deepEqual(f.calls[0],['load',hotel,actor]);
 const saved=await f.route.PUT(request(f.body()));assert.equal(saved.status,200);const rpc=f.calls.find(([key])=>key==='cmpri_save_notepad')[1];assert.equal(rpc.p_hotel,hotel);assert.equal(rpc.p_actor,actor);assert.equal(rpc.p_source,null);
 assert.equal((await f.route.PUT(request({...f.body(),author_user_id:owner}))).status,400);
 const wrong=request(f.body());wrong.headers.set('x-cmpri-property',owner);assert.equal((await f.route.PUT(wrong)).status,401);
 f.setSigned(false);for(const method of ['GET','PUT','PATCH'])assert.equal((await f.route[method](request(f.body()))).status,401);
});
test('Notepad bootstrap derives the signed-in user’s default and applies an explicit time choice',async()=>{
 const f=fixture();
 assert.equal((await f.route.GET(request(null))).body.timeFormat,'24h');
 f.setProfile({role:'chief_engineer'},{time_format:'12h'});
 assert.equal((await f.route.GET(request(null))).body.timeFormat,'12h');
 f.setProfile({role:'technician'},{});
 assert.equal((await f.route.GET(request(null))).body.timeFormat,'12h');
 f.setProfile({role:'technician'},{time_format:'24h'});
 assert.equal((await f.route.GET(request(null))).body.timeFormat,'24h');
});
test('Edit History binds note pagination to the authenticated account and property',async()=>{
 let signed=true;
 const calls=[],rows=Array.from({length:6},(_,index)=>({revision:9-index,actor_id:actor,actor_name:'Test Editor',edited_at:at,kind:'updated',before_fields:{title:'Before'},after_fields:{title:'After'},ignored:'internal'}));
 const admin={rpc:async(name,args)=>{calls.push([name,args]);return {data:rows,error:null}}};
 const route=loadTs('src/app/api/notepad/history/route.ts',{'next/server':{NextResponse:{json}},'@/lib/server/auth':{requireUser:async()=>signed?{principal:{hotelId:hotel,identity:{id:actor}},admin}:null},'@/lib/notepad':model});
 const read=(query)=>request(null,'https://fixture.invalid/api/notepad/history?'+query);
 const page=await route.GET(read('id='+id+'&before=10&actor='+owner));
 assert.equal(page.status,200);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['cmpri_read_notepad_history',{p_hotel:hotel,p_actor:actor,p_note:id,p_before:10}]]);
 assert.equal(page.body.entries.length,5);
 assert.equal(page.body.next,5);
 assert.equal(page.body.entries[0].actorName,'Test Editor');
 assert.equal(page.body.entries[0].ignored,undefined);
 assert.equal((await route.GET(read('id='+id+'&before=-1'))).status,400);
 const otherScope=read('id='+id);otherScope.headers.set('x-cmpri-property',owner);
 assert.equal((await route.GET(otherScope)).status,401);
 signed=false;
 assert.equal((await route.GET(read('id='+id))).status,401);
});
test('shared collaborators edit content but cannot change the audience, delete, or overwrite a newer revision',async()=>{
 const f=fixture(),note={...document(),id,authorId:owner,revision:3,createdAt:at,updatedAt:at};f.state.notes=[note];f.state.rows=[{id,revision:3,author_user_id:owner,change_id:owner}];
 const body={...f.body(),expectedRevision:3,document:{...document(),content:'<p data-item-id="item">Updated</p>'}};
 assert.equal((await f.route.PUT(request(body))).status,200);
 assert.equal((await f.route.PUT(request({...body,document:{...body.document,audience:{all:true,roles:[],people:[]}}}))).status,403);
 assert.equal((await f.route.PUT(request({...body,document:null}))).status,403);
 assert.equal((await f.route.PUT(request({...body,document:{...body.document,audience:{all:false}}}))).status,400);
 const conflict=await f.route.PUT(request({...body,expectedRevision:2}));assert.equal(conflict.status,409);assert.equal(conflict.body.code,'NOTEPAD_CONFLICT');
 f.state.notes=[];assert.equal((await f.route.PUT(request({...body,expectedRevision:null}))).status,403);
});
test('only the authenticated creator can change titles for both current and legacy notes',async()=>{
 const f=fixture();
 for(const legacy of [false,true]){
  const legacyVersion=legacy?'staff:'+'a'.repeat(64):undefined,revision=legacy?0:3;
  const previous={...document(),id,authorId:owner,revision,createdAt:at,updatedAt:at,...(legacy?{legacySource:'staff',legacyVersion}:{})};
  f.state.notes=[previous];
  f.state.rows=legacy?[]:[{id,revision,author_user_id:owner,change_id:owner}];
  const body={...f.body(),expectedRevision:revision,expectedLegacyVersion:legacyVersion,document:{...document(),title:'Unauthorized rename'}};
  const start=f.calls.filter(([key])=>key==='cmpri_save_notepad').length;
  for(const modified of [body.document,{...document(),titleFontFamily:'Arial'}]){
   const denied=await f.route.PUT(request({...body,document:modified}));
   assert.equal(denied.status,403);
   assert.match(denied.body.error,/creator.*title/);
  }
  assert.equal(f.calls.filter(([key])=>key==='cmpri_save_notepad').length,start);
  const edit={...body,document:{...document(),content:'<p>Authorized body edit</p>',fontFamily:'Georgia'}};
  assert.equal((await f.route.PUT(request(edit))).status,200);
  f.state.notes=[{...previous,authorId:actor}];
  f.state.rows=legacy?[]:[{id,revision,author_user_id:actor,change_id:owner}];
  assert.equal((await f.route.PUT(request({...body,document:{...body.document,title:'Creator rename',titleFontFamily:'Arial'}}))).status,200);
 }
});
test('saving validates active recipients and trusted upload ownership before invoking SQL; old staff authors remain authoritative',async()=>{
 const f=fixture();let body=f.body();body.document.audience.people=[owner];assert.equal((await f.route.PUT(request(body))).status,400);
 f.state.people.push({id:owner,active:true,taggable:false});assert.equal((await f.route.PUT(request(body))).status,400);
 const attachment={id:fileId,kind:'file',name:'photo.jpg',type:'image/jpeg',size:10};body={...f.body(),document:{...document(),attachments:[attachment]}};
 f.uploads.push({id:fileId,author_user_id:owner,note_id:null,name:attachment.name,media_type:attachment.type,size_bytes:10,ready:true});assert.equal((await f.route.PUT(request(body))).status,403);
 f.uploads[0].author_user_id=actor;assert.equal((await f.route.PUT(request(body))).status,200);
 const legacyVersion='staff:'+'a'.repeat(64);f.state.notes=[{...document(),id,authorId:owner,revision:0,legacySource:'staff',legacyVersion,createdAt:at,updatedAt:at}];
 assert.equal((await f.route.PUT(request({...f.body(),expectedRevision:0}))).status,409);assert.equal((await f.route.PUT(request({...f.body(),expectedRevision:0,expectedLegacyVersion:'staff:'+'b'.repeat(64)}))).status,409);
 assert.equal((await f.route.PUT(request({...f.body(),expectedRevision:0,expectedLegacyVersion:legacyVersion}))).status,200);const rpc=f.calls.filter(([key])=>key==='cmpri_save_notepad').at(-1)[1];assert.equal(rpc.p_source,'staff');assert.equal(rpc.p_actor,actor);assert.equal(rpc.p_legacy_version,legacyVersion);
});
test('sidebar order is private to the current user and accepts only visible unique note IDs',async()=>{
 const f=fixture();f.state.notes=[{...document(),id,authorId:actor,revision:1}];
 assert.equal((await f.route.PATCH(request({order:[id]}))).status,200);const row=f.calls.find(([key])=>key==='order')[1];assert.equal(row.hotel_id,hotel);assert.equal(row.user_id,actor);
 assert.equal((await f.route.PATCH(request({order:[id,id]}))).status,400);assert.equal((await f.route.PATCH(request({order:[owner]}))).status,403);
});
test('hidden individual recipients cannot be added while existing sharing remains editable',async()=>{
 const f=fixture();f.state.people.push({id:owner,active:true,taggable:true,recipientSelectable:false});
 const audience={all:false,roles:[],people:[owner]},body={...f.body(),document:{...document(),audience}};
 assert.equal((await f.route.PUT(request(body))).status,400);
 assert.ok(!f.calls.some(([key])=>key==='cmpri_save_notepad'));
 f.state.notes=[{...body.document,id,authorId:actor,revision:1,createdAt:at,updatedAt:at}];
 f.state.rows=[{id,revision:1,author_user_id:actor,change_id:owner}];
 assert.equal((await f.route.PUT(request({...body,expectedRevision:1,document:{...body.document,content:'<p>Edited safely</p>'}}))).status,200);
 assert.equal((await f.route.PUT(request({...body,expectedRevision:1,document:{...body.document,audience:{all:false,roles:[],people:[]}}}))).status,200);
 assert.equal((await f.route.PUT(request({...body,expectedRevision:1,document:{...body.document,audience:{all:true,roles:[],people:[]}}}))).status,200);
});
test('mention directory keeps display identities but excludes inactive accounts and all six test emails from tagging',async()=>{
 const emails=[...model.NOTEPAD_TEST_EMAILS],profiles=[...emails.map((email,i)=>({id:'test'+i,full_name:'Test '+i,email,role:'engineer',secondary_roles:[],active:true})),{id:actor,full_name:'Active Engineer',email:'real@example.invalid',role:'Chief Engineer / Technician',secondary_roles:[],active:true},{id:owner,full_name:'Inactive Account',email:'old@example.invalid',role:'manager',secondary_roles:[],active:false}];
 const admin={from(table){const q={select(){return q},eq(){return q},order(){return q},range:async()=>({data:profiles.map(p=>({user_id:p.id,active:true})),error:null}),in:async()=>({data:profiles,error:null})};assert.ok(['hotel_members','profiles'].includes(table));return q}};
 const people=await notepadDirectory(admin,hotel);assert.equal(people.filter(p=>p.taggable).length,1);assert.equal(people.filter(p=>p.recipientSelectable).length,1);const active=people.find(p=>p.id===actor);assert.deepEqual(active.roles,['engineer','technician']);assert.equal(people.find(p=>p.id===owner).active,false);assert.ok(people.every(p=>!('email'in p)));
});
test('individual sharing hides Scott Pickering’s admin identity and keeps Scott P’s Chief Engineer identity',async()=>{
 const profiles=[
  {id:'scott-admin',full_name:'Scott Pickering',role:'system_admin',secondary_roles:['engineer']},
  {id:'scott-admin-alias',full_name:'  scott   PICKERING ',role:'System Administrator',secondary_roles:[]},
  {id:'scott-chief',full_name:'Scott P',email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:['engineer']},
  {id:'other-admin',full_name:'Other Administrator',role:'system_admin',secondary_roles:[]},
  {id:'same-name-engineer',full_name:'Scott Pickering',role:'engineer',secondary_roles:[]},
 ].map(p=>({...p,email:p.email||p.id+'@example.invalid',active:true}));
 const admin={from(table){const q={select(){return q},eq(){return q},order(){return q},range:async()=>({data:profiles.map(p=>({user_id:p.id,active:true})),error:null}),in:async()=>({data:profiles,error:null})};assert.ok(['hotel_members','profiles'].includes(table));return q}};
 const people=await notepadDirectory(admin,hotel),byId=new Map(people.map(p=>[p.id,p]));
 assert.equal(people.length,profiles.length);
 for(const hidden of ['scott-admin','scott-admin-alias']){assert.equal(byId.get(hidden).recipientSelectable,false);assert.equal(byId.get(hidden).taggable,true);assert.equal(byId.get(hidden).active,true);}
 for(const visible of ['scott-chief','other-admin','same-name-engineer'])assert.equal(byId.get(visible).recipientSelectable,true);
 assert.equal(byId.get('scott-chief').displayRole,'Chief Engineer');
 assert.deepEqual(byId.get('scott-chief').roles,['engineer','system_admin']);
 assert.equal(model.notepadCanRead({authorId:actor,audience:{all:true,roles:[],people:[]}},byId.get('scott-admin')),true);
});
test('file upload signing derives the storage path from trusted ownership and verifies stored size/type',async()=>{
 let signed=true,row=null,storedSize=10,noteAccess=true;const calls=[];
 const admin={from(){const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},maybeSingle:async()=>({data:row&&filters.hotel_id===hotel&&filters.author_user_id===actor&&filters.id===fileId?row:null,error:null}),insert:async v=>{row=v;calls.push(['insert',v]);return{error:null}},update:v=>{calls.push(['update',v]);return q}};return q},storage:{from(bucket){assert.equal(bucket,media.STAFF_FILE_BUCKET);return{createSignedUploadUrl:async(path,options)=>{calls.push(['sign',path,options]);return{data:{token:'opaque'},error:null}},info:async path=>{calls.push(['info',path]);return{data:{size:storedSize,contentType:'image/jpeg'},error:null}},createSignedUrl:async path=>{assert.equal(path,`${hotel}/${actor}/notepad/${fileId}`);return{data:{signedUrl:'https://storage.invalid/signed?token=opaque'},error:null}}}}}};
 const route=loadTs('src/app/api/notepad/uploads/route.ts',{'next/server':{NextResponse:{json}},'@/lib/server/auth':{requireUser:async()=>signed?{principal:{hotelId:hotel,identity:{id:actor}},admin}:null},'@/lib/notepad':model,'@/lib/staff-note-media':media,'@/lib/server/notepad-store':{resolveNotepadAttachment:async(_admin,property,user,note,upload)=>{assert.equal(property,hotel);assert.equal(user,actor);assert.equal(note,id);assert.equal(upload,fileId);return noteAccess?{id:fileId}:null}}});
 const body={id:fileId,name:'photo.jpg',type:'image/jpeg',size:10};const prepared=await route.POST(request(body));assert.equal(prepared.status,200);assert.equal(prepared.body.path,`${hotel}/${actor}/notepad/${fileId}`);assert.equal(calls.find(([key])=>key==='sign')[2].upsert,false);
 assert.equal((await route.POST(request({...body,path:'other/person/file'}))).status,400);assert.equal((await route.PUT(request({id:fileId,path:'other/person/file'}))).status,400);
 assert.equal((await route.POST(request({...body,size:20}))).status,409);assert.equal((await route.POST(request(body))).status,200);
 storedSize=9;assert.equal((await route.PUT(request({id:fileId}))).status,409);storedSize=10;const verified=await route.PUT(request({id:fileId}));assert.equal(verified.status,200);assert.equal(verified.body.ready,true);assert.match(verified.body.url,/signed\?token=/);
 row.note_id=id;noteAccess=false;assert.equal((await route.PUT(request({id:fileId}))).status,403);noteAccess=true;assert.equal((await route.PUT(request({id:fileId}))).status,200);
 signed=false;assert.equal((await route.POST(request(body))).status,401);assert.equal((await route.PUT(request({id:fileId}))).status,401);
});
test('shared recipients read collaborators’ files; revocation and legacy UUID collisions never sign a different note’s file',async()=>{
 const attachment={id:fileId,kind:'file',name:'photo.jpg',type:'image/jpeg',size:10};
 const row={hotel_id:hotel,id,author_user_id:owner,document:{...document(),audience:{all:false,roles:['technician'],people:[]},attachments:[attachment]},revision:1,change_id:change,created_at:at,updated_at:at,deleted_at:null};
 const own={id:fileId,hotel_id:hotel,author_user_id:owner,note_id:id,name:'photo.jpg',media_type:'image/jpeg',size_bytes:10,ready:true,storage_path:`${hotel}/${owner}/notepad/${fileId}`};
 const legacy={...own,note_id:owner,storage_path:`${hotel}/${owner}/${fileId}`};
 const data={cmpri_notepad_notes:[row],cmpri_general_notes:[],cmpri_notepad_order:[],cmpri_staff_notes:[{id:owner,hotel_id:hotel,author_user_id:owner,author_name:'Original author',body:'Legacy attachment',parent_id:null,created_at:at,notepad_revision:0,attachments:[attachment],gif_ids:[]}],cmpri_notepad_uploads:[own],cmpri_staff_note_uploads:[legacy],hotel_members:[{hotel_id:hotel,user_id:actor,active:true},{hotel_id:hotel,user_id:owner,active:true}],profiles:[{id:actor,full_name:'Recipient',role:'technician',secondary_roles:[],active:true,email:'recipient@example.invalid'},{id:owner,full_name:'Owner',role:'engineer',secondary_roles:[],active:true,email:'owner@example.invalid'}]};
 const admin={from(table){const filters=[],rows=()=>data[table].filter(r=>filters.every(f=>f(r)));const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},is(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},order(){return q},range:async(from,to)=>({data:rows().slice(from,to+1),error:null}),maybeSingle:async()=>({data:rows()[0]||null,error:null}),then(resolve,reject){return Promise.resolve({data:rows(),error:null}).then(resolve,reject)}};return q},storage:{from:()=>({createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:'https://fixture.invalid/'+path+'?token=opaque'})),error:null})})}};
 assert.equal((await resolveNotepadAttachment(admin,hotel,actor,id,fileId)).path,own.storage_path);
 row.document.audience={all:false,roles:[],people:[]};assert.equal(await resolveNotepadAttachment(admin,hotel,actor,id,fileId),null);
 assert.equal((await resolveNotepadAttachment(admin,hotel,actor,owner,fileId)).path,legacy.storage_path);
 const notes=[{...row.document,id,attachments:[{...attachment}]},{...document(),id:owner,attachments:[{...attachment}]}];
 await signNotepadAttachments(admin,hotel,notes,{[owner]:owner});assert.ok(notes[0].attachments[0].url.includes('/notepad/'));assert.ok(!notes[1].attachments[0].url.includes('/notepad/'));
});
