import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {loadTs} from './helpers/load-ts.mjs';
import * as mediaPolicy from '../src/lib/staff-note-media.ts';
import {giphyGif} from '../src/lib/giphy.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('file metadata is bounded, has no client paths/owners, and GIF URLs cannot point at an arbitrary origin',()=>{
 const good={id:id(1),name:'Original camera image.png',type:'image/png',size:100};
 assert.ok(mediaPolicy.staffFileInput(good));
 for(const bad of [{...good,path:'someone-else/file'},{...good,size:104857601},{...good,size:0},{...good,name:'bad\nname'},{...good,type:'text/html\r\nX:1'}])assert.equal(mediaPolicy.staffFileInput(bad),null);
 const image={url:'https://media.giphy.com/file.gif',width:'160',height:'100'},gif={id:'gif123',title:'A gif',images:{fixed_width:image,original:image}};
 assert.equal(giphyGif(gif).id,'gif123');
 for(const url of ['https://giphy.com.attacker.invalid/file','javascript:alert(1)','https://user:pass@media.giphy.com/file'])assert.equal(giphyGif({...gif,images:{fixed_width:{...image,url},original:image}}),null);
 assert.deepEqual(mediaPolicy.staffHashtags('#Handoff #handoff #Pool_Closed #123'),['#handoff','#pool_closed']);
});
test('upload preparation/finalization derives ownership and rejects foreign, mismatched and already-posted files',async()=>{
 let auth=null,stored,info={size:100,contentType:'image/png'},signed=0;
 const admin={from(table){assert.equal(table,'cmpri_staff_note_uploads');const filters=[],q={select(){return q},eq(k,v){filters.push([k,v]);return q},is(){return q},insert(row){if(stored)return Promise.resolve({error:{code:'23505'}});stored=row;return Promise.resolve({error:null})},update(value){q.change=value;return q},async maybeSingle(){const row=stored&&filters.every(([k,v])=>stored[k]===v)?stored:null;if(row&&q.change)Object.assign(row,q.change);return {data:row,error:null}}};return q},storage:{from(bucket){assert.equal(bucket,'staff-note-files');return {createSignedUploadUrl:async(path,options)=>{signed++;assert.equal(path,`${id(1)}/${id(2)}/${id(3)}`);assert.equal(options.upsert,false);return {data:{token:'synthetic'},error:null}},info:async()=>({data:info,error:null})}}}};
 const route=loadTs('src/app/api/staff-notes/uploads/route.ts',{'next/server':{NextResponse:{json:(body,o={})=>({body,status:o.status||200})}},'@/lib/server/auth':{requireUser:async()=>auth},'@/lib/staff-note-media':mediaPolicy});
 const req=value=>({json:async()=>value}),file={id:id(3),name:'Photo.png',type:'image/png',size:100};
 assert.equal((await route.POST(req(file))).status,401);
 auth={admin,principal:{hotelId:id(1),identity:{id:id(2)}}};
 assert.equal((await route.POST(req({...file,user_id:id(9)}))).status,400);
 assert.equal((await route.POST(req(file))).status,200);assert.equal(stored.author_user_id,id(2));assert.equal(stored.ready,false);
 info.size=99;assert.equal((await route.PUT(req({id:id(3)}))).status,409);assert.equal(stored.ready,false);
 info.size=100;auth.principal.identity.id=id(4);assert.equal((await route.PUT(req({id:id(3)}))).status,404);
 auth.principal.identity.id=id(2);assert.equal((await route.PUT(req({id:id(3)}))).status,200);assert.equal(stored.ready,true);
 assert.equal((await route.POST(req(file))).status,200,'Lost response can retry the same immutable upload');assert.equal(signed,2);
 stored.note_id=id(5);assert.equal((await route.POST(req(file))).status,409);assert.equal((await route.PUT(req({id:id(3)}))).status,409);
});
test('actual existing database media function atomically saves files/GIF IDs, rejects ownership/status errors and protects retries',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table hotels(id uuid primary key);create table profiles(id uuid primary key,active boolean,role text,secondary_roles text[]);create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
 create function public.is_hotel_member(h uuid) returns boolean language sql security definer as $$select exists(select 1 from hotel_members where hotel_id=h and user_id=auth.uid() and active)$$;
 create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,target_path text,message text,recorded_at timestamptz,push_requested boolean,unique(hotel_id,recipient_user_id,notification_key));
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 insert into hotels values('${id(1)}'),('${id(9)}');insert into profiles values('${id(2)}',true,'front_desk','{}'),('${id(3)}',true,'manager','{}');insert into hotel_members values('${id(2)}','${id(1)}',true),('${id(3)}','${id(1)}',true);`);
 await db.exec(readFileSync('supabase/migrations/20261015055427_cmpri_staff_notes.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261105004859_staff_notes_media_and_room_guest_import.sql','utf8'));
 await db.exec(`insert into cmpri_staff_note_uploads(id,hotel_id,author_user_id,name,media_type,size_bytes,storage_path,ready) values('${id(4)}','${id(1)}','${id(2)}','Original.png','image/png',100,'own',false),('${id(5)}','${id(9)}','${id(2)}','Foreign.png','image/png',100,'foreign',true),('${id(6)}','${id(1)}','${id(3)}','Other user.png','image/png',100,'other',true);`);
 const call=async(request,uploads=[id(4)],body='@Manager #Handoff',gifs=['gif123'])=>(await db.query('select cmpri_post_staff_note_with_files($1,$2,$3,$4,null,$5,$6::jsonb,$7::uuid[],$8::text[],$9::jsonb) id',[id(1),id(2),'Alex Morgan',body,request,JSON.stringify([{user_id:id(3),push:true}]),uploads,['#handoff'],JSON.stringify(gifs)])).rows[0].id;
 for(const uploads of [[id(4)],[id(5)],[id(6)]])await assert.rejects(call(id(10),uploads),/Unverified attachments/);
 assert.equal((await db.query('select count(*)::int n from cmpri_staff_notes')).rows[0].n,0);
 await db.exec(`update cmpri_staff_note_uploads set ready=true where id='${id(4)}'`);
 const saved=await call(id(10));assert.equal(await call(id(10)),saved);
 assert.equal((await db.query('select count(*)::int n from cmpri_dashboard_notifications')).rows[0].n,1);
 assert.equal((await db.query('select attachments->0->>\'name\' name from cmpri_staff_notes')).rows[0].name,'Original.png');
 await assert.rejects(call(id(10),[id(4)],'changed'),/Request already used/);await assert.rejects(call(id(11)),/Unverified attachments/);
 await assert.rejects(call(id(12),[],'','https://attacker.invalid'),/Invalid GIFs/);
 assert.ok(await call(id(13),[],'',['gifOnly']),'Media-only posts use the existing constraint');
 await db.exec('set role authenticated');await assert.rejects(db.exec('select * from cmpri_staff_note_uploads'),/permission denied/);await assert.rejects(call(id(14),[]),/permission denied/);
 }finally{await db.close()}
});
