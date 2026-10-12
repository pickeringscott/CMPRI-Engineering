import {classified,HardStop} from './outcomes.mjs';
import {readJsonResponse,redact} from './http-diagnostics.mjs';
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
 return {status:response.status,body:await readJsonResponse(response,path,method)};
}
export async function ok(query){const {data,error}=await query;assert.ifError(error);return data;}
export function report(name,results){
 const safe=redact(JSON.stringify(classified(results),null,2));
 writeFileSync(new URL(name,out),safe);console.log(safe);
 if(results.some(r=>r.passed===false))process.exitCode=1;
}

export async function sharedHealth(){
 try{
  const response=await fetch(keys.API_URL+'/auth/v1/settings',{headers:{apikey:keys.ANON_KEY},signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);assert.equal((await response.json()).external?.email,true);
  const health=await admin.from('profiles').select('id').limit(1);assert.ifError(health.error);
 }catch(error){throw new HardStop('Shared Auth/database health failed: '+error.constructor.name);}
}
