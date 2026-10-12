import {createClient} from '@supabase/supabase-js';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {readJsonResponse,redact} from './http-diagnostics.mjs';
const out=new URL('../../.sandbox/',import.meta.url);
const keys=JSON.parse(readFileSync(new URL('local-keys.json',out)));
const users=JSON.parse(readFileSync(new URL('synthetic-users.json',out)));
assert.match(keys.API_URL,/^http:\/\/(127\.0\.0\.1|localhost):54321$/);
const result={phase:'Auth, session and draft API preflight',passed:false,checks:[]};
const client=createClient(keys.API_URL,keys.ANON_KEY,{auth:{persistSession:false}});
try{
 const settings=await fetch(keys.API_URL+'/auth/v1/settings',{headers:{apikey:keys.ANON_KEY},signal:AbortSignal.timeout(10000)});
 assert.equal(settings.status,200,'Local Auth settings endpoint failed');
 const config=await readJsonResponse(settings,'/auth/v1/settings');
 assert.equal(config.external?.email,true,'Local email/password provider is disabled');
 const admin=createClient(keys.API_URL,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const health=await admin.from('profiles').select('id').limit(1);assert.ifError(health.error);
 result.sharedHealthPassed=true;
 const {data,error}=await client.auth.signInWithPassword({email:users[0].email,password:users[0].password});assert.ifError(error);
 result.emailProvider=true;result.passwordSignIn=true;
 const headers={Authorization:'Bearer '+data.session.access_token,'Content-Type':'application/json'};
 async function request(path,method='GET',body){
  const r=await fetch('http://127.0.0.1:3112'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  result.checks.push({route:path,method,status:r.status,contentType:r.headers.get('content-type')});
  return {status:r.status,body:await readJsonResponse(r,path,method)};
 }
 const session=await request('/api/session');assert.equal(session.status,200);
 assert.ok(['/engineering','/technician','/work-orders'].includes(session.body.landing));
 const own=await request('/api/work-orders/drafts?scope=own');assert.equal(own.status,200);
 const draft=await request('/api/work-orders/drafts','POST',{location_id:users[0].fixtures[0].location_id,issue:'Own draft '+users[0].role,notes:'Borrador privado — sin traducir.'});
 assert.equal(draft.status,200,'Draft POST must return 200');assert.equal(draft.body.draft.created_by,users[0].id);
 // Reuse the one synthetic GM draft in the later matrix; do not create a duplicate.
 writeFileSync(new URL('preflight-draft.json',out),JSON.stringify(draft.body.draft));
 result.passed=true;result.status='PASS';
}catch(error){result.error=redact(String(error));result.status='FAIL';result.errorType=error.constructor.name;}
finally{
 await client.auth.signOut();
 writeFileSync(new URL('auth-preflight-results.json',out),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}
if(!result.passed)process.exitCode=result.sharedHealthPassed?1:2;
