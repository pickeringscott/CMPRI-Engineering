import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash, createSign, generateKeyPairSync, verify } from 'node:crypto';

const root=fileURLToPath(new URL('../src/',import.meta.url));

function loadModule(config={}) {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const credentials={client_email:'service-account@example.invalid',private_key:privateKey.export({type:'pkcs8',format:'pem'}).toString()};
  const secret=JSON.stringify(credentials);
  const calls=[];
  const source=ts.transpileModule(readFileSync(path.join(root,'lib/server/google-sheets.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  vm.runInNewContext(source,{exports,URL,URLSearchParams,Buffer,Date,fetch:async(url,init={})=>{
    calls.push({url:String(url),init});
    if(String(url)==='https://oauth2.googleapis.com/token'){
      const assertion=new URLSearchParams(init.body).get('assertion');
      const [header,payload,signature]=assertion.split('.');
      const signed=`${header}.${payload}`;
      assert.equal(verify('RSA-SHA256',Buffer.from(signed),publicKey,Buffer.from(signature,'base64url')),true);
      const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
      assert.equal(claims.iss,credentials.client_email);
      assert.equal(claims.scope,'https://www.googleapis.com/auth/spreadsheets');
      return {ok:true,status:200,json:async()=>({access_token:'short-lived-access-token',expires_in:3600})};
    }
    assert.equal(init.headers.Authorization,'Bearer short-lived-access-token');
    return {ok:true,status:200,json:async()=>({sheets:[{properties:{title:'PM'}}]})};
  },process:{env:{CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON:config.raw===undefined?secret:config.raw}},require(name){
    if(name==='server-only')return {};
    if(name==='node:crypto')return {createHash,createSign};
    if(name==='@/lib/server/integrations-safe-mode')return {IntegrationConfigurationError:class IntegrationConfigurationError extends Error {constructor(message){super(message);this.name='IntegrationConfigurationError';}}};
    throw new Error(`Unexpected import ${name}`);
  }});
  return {api:exports,calls,secret};
}

test('Google Sheets uses a signed server-side JWT and caches the access token',async()=>{
  const f=loadModule();
  const first=await f.api.googleSheetsRequest('private-id','?fields=sheets.properties.title');
  const second=await f.api.googleSheetsRequest('private-id','?fields=sheets.properties.title');
  assert.equal(first.sheets[0].properties.title,'PM');
  assert.equal(second.sheets[0].properties.title,'PM');
  assert.equal(f.calls.filter(({url})=>url==='https://oauth2.googleapis.com/token').length,1);
  assert.equal(JSON.stringify([first,second]).includes(f.secret),false);
});

test('Google Sheets rejects a missing service-account setting before network access',async()=>{
  const f=loadModule({raw:''});
  await assert.rejects(()=>f.api.googleSheetsRequest('private-id','?fields=x'),/CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON/);
  assert.equal(f.calls.length,0);
});

test('Google Sheets rejects malformed service-account JSON before network access',async()=>{
  const f=loadModule({raw:'not-json'});
  await assert.rejects(()=>f.api.googleSheetsRequest('private-id','?fields=x'),/valid Google service-account JSON/);
  assert.equal(f.calls.length,0);
});
