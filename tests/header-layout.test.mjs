import './helpers/resolve-ts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { normalizeHeaderLayout } from '../src/lib/header-layout.ts';
import { loadTs } from './helpers/load-ts.mjs';

test('layouts are bounded, deduplicated and never interpret control keys as authorization',()=>{
 const value=normalizeHeaderLayout({groups:['Operations','Operations'],buttons:{Operations:['/profile','/profile',42]},widths:{Operations:99999,Account:-20,Admin:NaN},collapsed:['Operations']});
 assert.deepEqual(value,{groups:['Operations'],buttons:{Operations:['/profile']},widths:{Operations:4000,Account:40},collapsed:['Operations']});
 assert.deepEqual(normalizeHeaderLayout(null).groups,[]);
});
test('Front Desk layouts save only to the authenticated user and property; spoofed identity is rejected',async()=>{
 let current={principal:{identity:{id:'front-desk'},hotelId:'property',profile:{role:'front_desk'}}};const calls=[];
 const route=loadTs('src/app/api/profile/header-layout/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},
  '@/lib/server/auth':{requireUser:async()=>current&&({...current,admin:{from(table){assert.equal(table,'cmpri_header_layouts');const q={select(){return q},eq(k,v){calls.push([k,v]);return q},maybeSingle:async()=>({data:{layout:{groups:['Account','Daily tools']}},error:null}),upsert:async row=>{calls.push(row);return {error:null}}};return q}}})},
  '@/lib/server/roles':loadTs('src/lib/server/roles.ts'),'@/lib/header-layout':{normalizeHeaderLayout},
 });
 assert.equal((await route.PUT({text:async()=>JSON.stringify({layout:{groups:['Account']},user_id:'someone-else'})})).status,400);
 assert.equal((await route.PUT({text:async()=>JSON.stringify({layout:{groups:['Account']}})})).status,200);
 assert.equal(calls.at(-1).user_id,'front-desk');assert.equal(calls.at(-1).hotel_id,'property');
 const read=await route.GET({});assert.equal(read.body.layout.groups[0],'Account');assert(calls.some(row=>row[0]==='user_id'&&row[1]==='front-desk'));
 current=null;assert.equal((await route.GET({})).status,401);
});
test('database owner policies isolate accounts and reject reassignment and inactive membership',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema cmpri_private;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table profiles(id uuid primary key);create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
 create function cmpri_private.active_signal_member(h uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.hotel_members where hotel_id=h and user_id=auth.uid() and active)$$;
 grant usage on schema cmpri_private,auth to authenticated;
 insert into profiles values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
 insert into hotel_members values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',true),('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',true);`);
 const name=readdirSync('supabase/migrations').find(n=>n.endsWith('_header_layouts.sql'));await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
 insert into cmpri_header_layouts(hotel_id,user_id,layout) values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','{"groups":["Account"]}');`);
 assert.equal((await db.query('select * from cmpri_header_layouts')).rows.length,1);
 await assert.rejects(db.exec(`update cmpri_header_layouts set user_id='00000000-0000-4000-8000-000000000002'`),/row-level security/);
 await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false)`);
 assert.equal((await db.query('select * from cmpri_header_layouts')).rows.length,0);
 await db.exec(`reset role;update hotel_members set active=false;set role authenticated;select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false)`);
 assert.equal((await db.query('select * from cmpri_header_layouts')).rows.length,0);
 }finally{await db.close()}
});
