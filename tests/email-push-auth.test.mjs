import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {secretEqual,readPushBody,verifyGooglePush} from '../src/lib/server/email-push-auth.ts';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const audience='https://example.test/api/integrations/email/push',email='push@example.test';
const token=(overrides={},key=privateKey)=>{const now=Math.floor(Date.now()/1000);const parts=[{alg:'RS256',kid:'test-key'},{iss:'https://accounts.google.com',aud:audience,email,email_verified:true,sub:'123',iat:now,exp:now+3600,...overrides}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url'));return 'Bearer '+parts.join('.')+'.'+sign('RSA-SHA256',Buffer.from(parts.join('.')),key).toString('base64url')};
test('Google push accepts only signed tokens for the configured audience and verified service account',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'test-key'}]});
 try{assert.equal(await verifyGooglePush(token(),audience,email),true);
 for(const patch of [{aud:'other'},{email:'attacker@example.test'},{email_verified:false},{exp:0},{iat:Math.floor(Date.now()/1000)+600},{iss:'attacker'},{sub:''}])assert.equal(await verifyGooglePush(token(patch),audience,email),false);
 const other=generateKeyPairSync('rsa',{modulusLength:2048});assert.equal(await verifyGooglePush(token({},other.privateKey),audience,email),false);
 assert.equal(await verifyGooglePush('Bearer not.a.signature',audience,email),false);
 assert.equal(await verifyGooglePush('Bearer bnVsbA.bnVsbA.c2ln',audience,email),false);
 }finally{globalThis.fetch=previous}
});
test('push bodies are bounded before JSON parsing',async()=>{
 assert.deepEqual(await readPushBody(new Request('https://example.test',{method:'POST',body:'{"value":[]}'})),{value:[]});
 await assert.rejects(readPushBody(new Request('https://example.test',{method:'POST',body:'x'.repeat(65537)})),/Body limit/);
 await assert.rejects(readPushBody(new Request('https://example.test',{method:'POST',body:'bad json'})));
});
test('shared secret matching rejects absent and wrong credentials',()=>{assert.equal(secretEqual('correct','correct'),true);for(const value of ['',null,undefined,{},'wrong'])assert.equal(secretEqual(value,'correct'),false);assert.equal(secretEqual('',''),false)});
