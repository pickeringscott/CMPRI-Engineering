import {createClient} from '@supabase/supabase-js';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
export const out=new URL('../../.sandbox/',import.meta.url);
export const keys=JSON.parse(readFileSync(new URL('local-keys.json',out)));
assert.match(keys.API_URL,/^http:\/\/(127\.0\.0\.1|localhost):54321$/);
export const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
export const users=JSON.parse(readFileSync(new URL('synthetic-users.json',out)));
assert.deepEqual(users.map(u=>u.role),['manager','assistant_manager','front_desk_manager','technician','chief_engineer','housekeeping','front_desk']);
export const admin=createClient(keys.API_URL,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const sessions=new Map();
export async function clientFor(user){
 if(!sessions.has(user.id)){
  const client=createClient(keys.API_URL,keys.ANON_KEY,{auth:{persistSession:false}});
  const {data,error}=await client.auth.signInWithPassword({email:user.email,password:user.password});
  assert.ifError(error);sessions.set(user.id,{client,token:data.session.access_token});
 }
 return sessions.get(user.id);
}
export async function api(user,path,method='GET',body){
 const {token}=await clientFor(user);
 const response=await fetch('http://127.0.0.1:3112'+path,{method,headers:{Authorization:'Bearer '+token,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
 return {status:response.status,body:await response.json()};
}
export async function ok(query){const {data,error}=await query;assert.ifError(error);return data;}
export function report(name,results){
 const safe=JSON.stringify(results,null,2).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[redacted JWT]');
 writeFileSync(new URL(name,out),safe);console.log(safe);
 if(results.some(r=>r.passed===false))process.exitCode=1;
}
