import {createClient} from '@supabase/supabase-js';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const out=new URL('../../.sandbox/',import.meta.url);
const keys=JSON.parse(readFileSync(new URL('local-keys.json',out)));
const users=JSON.parse(readFileSync(new URL('synthetic-users.json',out)));
assert.match(keys.API_URL,/^http:\/\/(127\.0\.0\.1|localhost):54321$/);
const result={phase:'Auth and session preflight',passed:false};
const client=createClient(keys.API_URL,keys.ANON_KEY,{auth:{persistSession:false}});
try{
  const settings=await fetch(keys.API_URL+'/auth/v1/settings',{headers:{apikey:keys.ANON_KEY},signal:AbortSignal.timeout(10000)});
  assert.equal(settings.status,200,'Local Auth settings endpoint failed');
  const config=await settings.json();
  assert.equal(config.external?.email,true,'Local email/password provider is disabled');
  const {data,error}=await client.auth.signInWithPassword({email:users[0].email,password:users[0].password});
  assert.ifError(error);
  const response=await fetch('http://127.0.0.1:3112/api/session',{headers:{Authorization:'Bearer '+data.session.access_token},signal:AbortSignal.timeout(30000)});
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify({status:response.status,error:body.error}));
  assert.ok(['/engineering','/technician','/work-orders'].includes(body.landing));
  result.passed=true;result.emailProvider=true;result.sessionStatus=response.status;
}catch(error){
  result.error=String(error).replaceAll(users[0].password,'[redacted]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[redacted JWT]');
}finally{
  await client.auth.signOut();
  writeFileSync(new URL('auth-preflight-results.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
if(!result.passed)process.exitCode=1;
