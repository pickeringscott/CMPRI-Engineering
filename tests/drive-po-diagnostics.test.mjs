import assert from 'node:assert/strict';
import {diagnoseDriveAccess,DRIVE_PO_ACCOUNT} from '../src/lib/server/drive-po-api.ts';
process.env.CMPRI_GMAIL_CLIENT_ID='unchanged-client';process.env.CMPRI_GMAIL_CLIENT_SECRET='secret-fixture';process.env.CMPRI_GMAIL_REFRESH_TOKEN='refresh-fixture';
const original=globalThis.fetch;
for(const mode of ['scope','disabled','folder','unknown','success']){
 const calls=[];
 globalThis.fetch=async(url,init)=>{
  calls.push(url);
  if(url==='https://oauth2.googleapis.com/token'){
   assert.equal(init.body.get('client_id'),'unchanged-client');assert.equal(init.body.has('scope'),false);
   return Response.json({access_token:'DO-NOT-EXPOSE',...(mode==='unknown'?{}:{scope:mode==='scope'?'https://www.googleapis.com/auth/gmail.readonly':'https://www.googleapis.com/auth/drive.readonly'})});
  }
  assert.equal(init.method,undefined);assert.equal(init.headers.Authorization,'Bearer DO-NOT-EXPOSE');
  if(url.includes('about?')&&['folder','success'].includes(mode))return Response.json({user:{emailAddress:DRIVE_PO_ACCOUNT}});
  if(mode==='success')return Response.json({id:'18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD',name:'PO folder',mimeType:'application/vnd.google-apps.folder'});
  return Response.json({error:{status:'PERMISSION_DENIED',message:'SECRET BODY',errors:[{reason:mode==='folder'?'appNotAuthorizedToFile':'untrusted-secret'}],details:[{reason:mode==='scope'?'ACCESS_TOKEN_SCOPE_INSUFFICIENT':mode==='disabled'?'SERVICE_DISABLED':'unknown-secret',metadata:{secret:'secret-fixture'}}]}},{status:403});
 };
 const result=await diagnoseDriveAccess(),serialized=JSON.stringify(result);
 assert.equal(calls.length,['folder','success'].includes(mode)?3:2);
 assert.equal(result.accountVerified,['folder','success'].includes(mode));
 assert.equal(result.scopeMetadata.reported,mode!=='unknown');
 assert.deepEqual(result.scopeMetadata.recognized,['scope','unknown'].includes(mode)?[]:['drive.readonly']);
 for(const secret of ['DO-NOT-EXPOSE','SECRET BODY','secret-fixture','untrusted-secret','unknown-secret'])assert.equal(serialized.includes(secret),false);
 if(mode==='success')assert.equal(result.account,DRIVE_PO_ACCOUNT);
 else assert.match(result.error,new RegExp(mode==='folder'?'folder lookup':'account lookup'));
 if(mode==='scope')assert.match(result.error,/ACCESS_TOKEN_SCOPE_INSUFFICIENT/);
 if(mode==='disabled')assert.match(result.error,/SERVICE_DISABLED/);
 if(mode==='folder')assert.match(result.error,/appNotAuthorizedToFile/);
}
globalThis.fetch=original;
console.log('PASS staged read-only Drive diagnostics, unchanged credential serialization, scope metadata, safe error allowlist, no watch/import, secret redaction.');
