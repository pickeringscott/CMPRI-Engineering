import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {submitMailboxComparison} from '../src/lib/mailbox-comparison-client.ts';
const refs={clientSecretSha256:'a'.repeat(64),refreshTokenSha256:'b'.repeat(64)};
const valid={sourceClientSecretMatchesReference:true,outgoingClientSecretMatchesReference:true,sourceRefreshTokenMatchesReference:false,outgoingRefreshTokenMatchesReference:false};
test('digest-only client uses existing session, no-store POST, and returns booleans only',async()=>{
 let calls=0;
 const result=await submitMailboxComparison(JSON.stringify(refs),async()=>'synthetic-session',async(url,init)=>{
  calls++;assert.equal(url,'/api/engineering/operations');assert.equal(init.method,'POST');assert.equal(init.cache,'no-store');
  assert.equal(init.headers.authorization,'Bearer synthetic-session');assert.deepEqual(JSON.parse(init.body),refs);
  return Response.json({...valid,unexpected:'private-server-value'});
 });
 assert.equal(calls,1);assert.deepEqual(result,[true,true,false,false]);
});
test('raw credentials, malformed/extra fields and invalid digests never reach auth or network',async()=>{
 for(const raw of ['private-secret','null','[]',JSON.stringify({...refs,extra:'private-secret'}),JSON.stringify({...refs,clientSecretSha256:'private-secret'}),JSON.stringify({...refs,clientSecretSha256:refs.clientSecretSha256+'\n'}),'x'.repeat(513)]){
  await assert.rejects(submitMailboxComparison(raw,async()=>{throw new Error('must not read auth');},async()=>{throw new Error('must not fetch');}),{message:'Paste only the reference JSON from the private hashing utility.'});
 }
});
test('auth, transport and server errors never echo response text or reference digests',async()=>{
 for(const send of [async()=>{throw new Error('private-secret '+refs.clientSecretSha256);},async()=>Response.json({error:'private-secret'},{status:403}),async()=>Response.json({...valid,sourceClientSecretMatchesReference:'private-secret'}),async()=>new Response('private-secret')]){
  await assert.rejects(submitMailboxComparison(JSON.stringify(refs),async()=>'synthetic-session',send),{message:'Comparison unavailable. Check your sign-in and integration access, then retry.'});
 }
 let calls=0;await assert.rejects(submitMailboxComparison(JSON.stringify(refs),async()=>'',async()=>{calls++;}));assert.equal(calls,0);
});
test('panel is operator gated, clears transient input, and has no persistence or logging',()=>{
 const page=readFileSync(new URL('../src/app/engineering/purchasing/page.tsx',import.meta.url),'utf8');
 const panel=readFileSync(new URL('../src/components/MailboxChecksumComparison.tsx',import.meta.url),'utf8');
 const client=readFileSync(new URL('../src/lib/mailbox-comparison-client.ts',import.meta.url),'utf8');
 assert.match(page,/canEdit && <MailboxChecksumComparison token=\{token\}/);
 assert.match(panel,/input\.current\.value = ""/);assert.match(panel,/autoComplete="off"/);assert.match(panel,/aria-live="polite"/);
 assert.doesNotMatch(panel+client,/localStorage|sessionStorage|console\.|integrations\/email\/scan/);
});
