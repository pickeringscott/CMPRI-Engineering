import test from "node:test";
import { createHash } from "node:crypto";
import { compareGmailCredentialDigests } from "../src/lib/integrations/email-provider.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configuredEmailProvider, gmailText, htmlToText, messageDirection, fetchOperationalMessages } from "../src/lib/integrations/email-provider.ts";

test("email scan distinguishes missing authentication from denied integration permission", () => {
  const route = readFileSync(new URL("../src/app/api/integrations/email/scan/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!auth\) return NextResponse\.json\(\{ error: "Sign in is required\." \}, \{ status: 401 \}\)/);
  assert.match(route, /Email integration access is required\.[\s\S]*?status: 403/);
});

test("MIME prefers plain text instead of duplicating HTML alternative", () => {
  const part = {parts:[{mimeType:"text/plain",body:{data:Buffer.from("Plain message").toString("base64url")}},{mimeType:"text/html",body:{data:Buffer.from("<p>HTML message</p>").toString("base64url")}}]};
  assert.equal(gmailText(part), "Plain message");
});
test("HTML strips scripts and preserves report lines", () => assert.equal(htmlToText("<script>bad()</script><p>Score: 90</p><p>Service: 99</p>"), "Score: 90\n\nService: 99"));
test("exact mailbox address detects outbound", () => assert.equal(messageDirection("Engineer <work@example.com>", "work@example.com"), "outbound"));
test("substring/spoofed mailbox is inbound", () => assert.equal(messageDirection("otherwork@example.com", "work@example.com"), "inbound"));

test("provider selection, missing configuration, read-only paging and upstream failures", async () => {
  const keys = ["CMPRI_EMAIL_PROVIDER","CMPRI_MS_TENANT_ID","CMPRI_MS_CLIENT_ID","CMPRI_MS_CLIENT_SECRET","CMPRI_MS_MAILBOX","CMPRI_GMAIL_CLIENT_ID","CMPRI_GMAIL_CLIENT_SECRET","CMPRI_GMAIL_REFRESH_TOKEN","CMPRI_GMAIL_ADDRESS"];
  const backup = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(configuredEmailProvider(), null);
    assert.equal((await fetchOperationalMessages()).provider, null);
    process.env.CMPRI_EMAIL_PROVIDER = "invalid";
    assert.throws(configuredEmailProvider, /must be/);
    process.env.CMPRI_EMAIL_PROVIDER = "outlook";
    await assert.rejects(fetchOperationalMessages(), /incomplete/);
    Object.assign(process.env, {CMPRI_MS_TENANT_ID:"tenant",CMPRI_MS_CLIENT_ID:"test",CMPRI_MS_CLIENT_SECRET:"test",CMPRI_MS_MAILBOX:"work@example.com"});
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url),init.method || "GET"]);
      if (String(url).includes("/token")) return Response.json({access_token:"fixture-token"});
      if (String(url).includes("fixture-page-2")) return Response.json({value:[{id:"older",conversationId:"thread",subject:"Outbound",from:{emailAddress:{address:"work@example.com"}},receivedDateTime:"2026-09-14T10:00:00Z",body:{contentType:"text",content:"Missing item"}}]});
      return Response.json({value:[{id:"newer",conversationId:"thread",subject:"Reply",from:{emailAddress:{address:"vendor@example.com"}},receivedDateTime:"2026-09-14T11:00:00Z",body:{contentType:"text",content:"We are checking"}}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/fixture-page-2"});
    };
    const result = await fetchOperationalMessages();
    assert.equal(result.provider,"microsoft365");
    assert.deepEqual(result.messages.map(message => message.id),["microsoft365:older","microsoft365:newer"]);
    assert.equal(result.messages[0].direction,"outbound");
    assert.equal(result.messages[0].threadId,result.messages[1].threadId);
    assert.deepEqual(calls.map(call => call[1]),["POST","GET","GET"]);
    globalThis.fetch = async (url) => String(url).includes("/token") ? Response.json({access_token:"fixture-token"}) : Response.json({value:[],"@odata.nextLink":"https://evil.example/steal"});
    await assert.rejects(fetchOperationalMessages(),/Untrusted/);
    globalThis.fetch = async () => new Response("unavailable",{status:503});
    await assert.rejects(fetchOperationalMessages(),/503/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) if (backup[key] === undefined) delete process.env[key]; else process.env[key] = backup[key];
  }
});

test('safe mailbox failure stages and allowlisted codes never expose provider text or request data', async t => {
  const fixture = {
    CMPRI_EMAIL_PROVIDER:'gmail', CMPRI_GMAIL_CLIENT_ID:'private-client-id',
    CMPRI_GMAIL_CLIENT_SECRET:'private-client-secret', CMPRI_GMAIL_REFRESH_TOKEN:'private-refresh-token',
    CMPRI_GMAIL_ADDRESS:'private-mailbox@example.invalid', CMPRI_GMAIL_USER:'private-user', CMPRI_GMAIL_QUERY:'private-query',
  };
  const backup = Object.fromEntries(Object.keys(fixture).map(key=>[key,process.env[key]]));
  const originalFetch = globalThis.fetch;
  const cases = [
    {name:'token invalid client',at:1,body:{error:'invalid_client',error_description:'private-client-secret'},expected:'Mailbox OAuth token exchange failed (401; invalid_client).'},
    {name:'token invalid grant',at:1,body:{error:'invalid_grant',error_description:'private-refresh-token'},expected:'Mailbox OAuth token exchange failed (401; invalid_grant).'},
    {name:'list authentication rejection',at:2,body:{error:{status:'UNAUTHENTICATED',message:'private-mailbox@example.invalid',errors:[{reason:'authError',message:'private-query'}]}},expected:'Mailbox Gmail list failed (401; UNAUTHENTICATED, authError).'},
    {name:'retrieval authentication rejection',at:3,body:{error:{errors:[{reason:'authError'}],message:'private-message-body'}},expected:'Mailbox Gmail retrieval failed (401; authError).'},
    {name:'unknown token code omitted',at:1,body:{error:'private-secret-code',error_description:'private-body'},expected:'Mailbox OAuth token exchange failed (401).'},
    {name:'unknown API codes omitted and allowed codes deduplicated',at:2,body:{error:{status:'private-status',errors:[{reason:'private-code'},{reason:'authError'},{reason:'authError'},null,42]}},expected:'Mailbox Gmail list failed (401; authError).'},
    {name:'OAuth code not accepted as Gmail code',at:2,body:{error:'invalid_client'},expected:'Mailbox Gmail list failed (401).'},
    {name:'non-JSON body omitted',at:3,raw:'<html>private-response-body</html>',expected:'Mailbox Gmail retrieval failed (401).'},
    {name:'network exception URL and cause omitted',at:2,network:true,expected:'Mailbox Gmail list failed (network).'},
    {name:'malformed success body omitted',at:2,raw:'private-invalid-json',status:200,expected:'Mailbox Gmail list returned invalid JSON.'},
  ];
  try {
    Object.assign(process.env,fixture);
    for (const scenario of cases) await t.test(scenario.name, async()=>{
      let calls=0;
      globalThis.fetch=async()=>{
        calls++;
        if(calls===scenario.at) {
          if(scenario.network)throw new Error('https://provider.invalid/private-query private-client-secret', {cause:new Error('private-cause')});
          return scenario.raw !== undefined ? new Response(scenario.raw,{status:scenario.status||401}) : Response.json(scenario.body,{status:401});
        }
        if(calls===1)return Response.json({access_token:'private-access-token'});
        if(calls===2)return Response.json({messages:[{id:'private-message-id'}]});
        throw new Error('Unexpected request after failure');
      };
      await assert.rejects(fetchOperationalMessages(),error=>{
        const suffix = scenario.at === 1 ? ' Response shape: ' + JSON.stringify({contentType:'application/json',jsonParsed:true,errorPresent:true,errorType:'string',errorDescriptionPresent:true,errorUriPresent:false,codeRecognized:scenario.body.error !== 'private-secret-code',redirected:false,requestClientIdMatchesRuntime:true,...(scenario.body.error === 'invalid_client' ? {clientDescriptionReason:'unknown',clientSecretHasEdgeWhitespace:false,requestClientSecretMatchesRuntime:true} : {}),...(scenario.body.error === 'invalid_grant' ? {grantDescriptionReason:'unknown',grantSubtypeReason:'unknown',refreshTokenHasEdgeWhitespace:false,requestRefreshTokenMatchesRuntime:true} : {})}) + '.' : '';
        assert.equal(error.message,scenario.expected + suffix);
        assert.equal(error.cause,undefined);
        assert.equal(String(error).includes('private-'),false);
        assert.equal(String(error).includes('https://'),false);
        return true;
      });
      assert.equal(calls,scenario.at);
    });
  } finally {
    globalThis.fetch=originalFetch;
    for(const key of Object.keys(fixture)) if(backup[key]===undefined)delete process.env[key];else process.env[key]=backup[key];
  }
});


test('Google refresh request uses native form serialization and bounded response diagnostics', async t => {
  const fixture = {CMPRI_EMAIL_PROVIDER:'gmail',CMPRI_GMAIL_CLIENT_ID:'private-id+&= %\u00fc',CMPRI_GMAIL_CLIENT_SECRET:'private-secret+&= %\u00fc',CMPRI_GMAIL_REFRESH_TOKEN:'private-refresh+&= %\u00fc',CMPRI_GMAIL_ADDRESS:'private@example.invalid'};
  const backup = Object.fromEntries(Object.keys(fixture).map(key=>[key,process.env[key]]));
  const originalFetch = globalThis.fetch;
  const cases = [
    {name:'recognized JSON with private description and URI',body:JSON.stringify({error:'invalid_client',error_description:'private-secret',error_uri:'https://private.invalid'}),mime:'application/json; private-parameter=secret',type:'application/json',parsed:true,error:true,description:true,uri:true,recognized:true},
    {name:'unrecognized JSON code',body:JSON.stringify({error:'private-unknown-code'}),mime:'application/json',type:'application/json',parsed:true,error:true},
    ...['deleted_client','disabled_client','invalid_dpop_proof','use_dpop_nonce'].map(code=>({name:code,body:JSON.stringify({error:code,error_description:'private-secret'}),mime:'application/json',type:'application/json',parsed:true,error:true,description:true,recognized:true,code})),
    ...[[null,'null'],[{},'object'],[['private-secret'],'array'],[401,'number'],[false,'boolean']].map(([value,errorType])=>({name:'non-string error '+errorType,body:JSON.stringify({error:value,error_description:'private-secret'}),mime:'application/json',type:'application/json',parsed:true,error:true,description:true,errorType})),
    {name:'JSON without known fields' ,body:JSON.stringify({message:'private-body'}),mime:'application/json',type:'application/json',parsed:true},
    {name:'JSON null',body:'null',mime:'application/json',type:'application/json',parsed:true},
    {name:'HTML redirect response',body:'<html>private-body</html>',mime:'text/html; charset=utf-8',type:'text/html',redirected:true},
    {name:'plain text',body:'private-body',mime:'text/plain',type:'text/plain'},
    {name:'unknown MIME hidden',body:'private-body',mime:'application/private-secret',type:'other'},
    {name:'missing MIME',body:'private-body',type:'missing'},
    {name:'malformed JSON',body:'{private-body',mime:'application/json',type:'application/json'},
  ];
  try {
    Object.assign(process.env,fixture);
    for(const c of cases) await t.test(c.name,async()=>{
      let calls=0;
      globalThis.fetch=async(url,init)=>{
        calls++;
        assert.equal(url,'https://oauth2.googleapis.com/token');
        const request=new Request(url,init);
        assert.equal(request.method,'POST');
        assert.equal(request.headers.get('content-type'),'application/x-www-form-urlencoded');
        assert.equal(request.headers.has('authorization'),false);
        const wire=await request.text();
        const form=new URLSearchParams(wire);
        assert.deepEqual([...form.keys()].sort(),['client_id','client_secret','grant_type','refresh_token']);
        assert.equal(form.get('client_id'),fixture.CMPRI_GMAIL_CLIENT_ID);
        assert.equal(form.get('client_secret'),fixture.CMPRI_GMAIL_CLIENT_SECRET);
        assert.equal(form.get('refresh_token'),fixture.CMPRI_GMAIL_REFRESH_TOKEN);
        assert.equal(form.get('grant_type'),'refresh_token');
        for(const escaped of ['%2B','%26','%3D','%25','%C3%BC']) assert.ok(wire.includes(escaped));
        const response=new Response(c.body,{status:401});
        response.headers.delete('content-type');
        if(c.mime)response.headers.set('content-type',c.mime);
        response.headers.set('x-private','private-header');
        Object.defineProperty(response,'redirected',{value:Boolean(c.redirected)});
        Object.defineProperty(response,'url',{value:'https://private.invalid/secret'});
        return response;
      };
      await assert.rejects(fetchOperationalMessages(),error=>{
        const shape={contentType:c.type,jsonParsed:Boolean(c.parsed),errorPresent:Boolean(c.error),errorType:c.errorType||(c.error?'string':'missing'),errorDescriptionPresent:Boolean(c.description),errorUriPresent:Boolean(c.uri),codeRecognized:Boolean(c.recognized),redirected:Boolean(c.redirected),requestClientIdMatchesRuntime:true,...(c.recognized && (!c.code || c.code === 'invalid_client') ? {clientDescriptionReason:'unknown',clientSecretHasEdgeWhitespace:false,requestClientSecretMatchesRuntime:true} : {})};
        assert.equal(error.message,`Mailbox OAuth token exchange failed (401${c.recognized?'; '+(c.code||'invalid_client'):''}). Response shape: ${JSON.stringify(shape)}.`);
        assert.equal(error.cause,undefined);
        assert.doesNotMatch(error.stack,/private-|private@|https:\/\//);
        return true;
      });
      assert.equal(calls,1);
    });
  } finally {
    globalThis.fetch=originalFetch;
    for(const key of Object.keys(fixture))if(backup[key]===undefined)delete process.env[key];else process.env[key]=backup[key];
  }
});


test('client ID equality describes the actual serialized request and reads each invocation', async()=>{
  const expected='880987317943-b4fqinbu5l4ugp6nh6ngalq392r0n6ov.apps.googleusercontent.com';
  const fixture={CMPRI_EMAIL_PROVIDER:'gmail',CMPRI_GMAIL_CLIENT_ID:expected,CMPRI_GMAIL_CLIENT_SECRET:'private-secret',CMPRI_GMAIL_REFRESH_TOKEN:'private-refresh',CMPRI_GMAIL_ADDRESS:'private@example.invalid'};
  const backup=Object.fromEntries(Object.keys(fixture).map(key=>[key,process.env[key]]));
  const originalFetch=globalThis.fetch;
  try {
    Object.assign(process.env,fixture);
    for(const [id] of [[expected,true],['private-stale-id',false],[' '+expected,false],[expected+'\n',false],[expected.toUpperCase(),false],[expected,true]]) {
      process.env.CMPRI_GMAIL_CLIENT_ID=id;
      let calls=0;
      globalThis.fetch=async(url,init)=>{
        calls++;
        assert.equal(url,'https://oauth2.googleapis.com/token');
        assert.equal(typeof init.body,'string');
        const wire=await new Request(url,init).text();
        assert.equal(wire,init.body);
        assert.deepEqual(new URLSearchParams(wire).getAll('client_id'),[id]);
        // A later environment change must not change the recorded request comparison.
        process.env.CMPRI_GMAIL_CLIENT_ID='private-later-id';
        return Response.json({error:'deleted_client',error_description:'private-body'},{status:401});
      };
      await assert.rejects(fetchOperationalMessages(),error=>{
        const shape=JSON.parse(error.message.split(' Response shape: ')[1].slice(0,-1));
        assert.equal('runtimeClientIdMatchesExpected' in shape,false);
        assert.equal(shape.requestClientIdMatchesRuntime,true);
        assert.doesNotMatch(error.message,/private|880987317943|googleusercontent/);
        return true;
      });
      assert.equal(calls,1);
    }
  } finally {
    globalThis.fetch=originalFetch;
    for(const key of Object.keys(fixture))if(backup[key]===undefined)delete process.env[key];else process.env[key]=backup[key];
  }
});

test('grant diagnostics classify exact provider literals and never disclose values', async()=>{
  const fixture={CMPRI_EMAIL_PROVIDER:'gmail',CMPRI_GMAIL_CLIENT_ID:'private-id',CMPRI_GMAIL_CLIENT_SECRET:'private-secret',CMPRI_GMAIL_REFRESH_TOKEN:'private-refresh',CMPRI_GMAIL_ADDRESS:'private@example.invalid'};
  const backup=Object.fromEntries(Object.keys(fixture).map(k=>[k,process.env[k]]));
  const originalFetch=globalThis.fetch;
  const cases=[
    ['Token has been expired or revoked.',undefined,'expired_or_revoked','unknown'],
    ['Bad Request',undefined,'bad_request_unspecified','unknown'],
    [undefined,'invalid_rapt','unknown','session_control'],
    ['Token has been expired or revoked.','invalid_rapt','expired_or_revoked','session_control'],
    ...['private-secret','Token has been expired or revoked. private-secret',' Bad Request','bad request','<script>private-secret</script>',null,42,[],{},'constructor','__proto__'].map(x=>[x,x,'unknown','unknown']),
  ];
  try {
    Object.assign(process.env,fixture);
    for(const [description,subtype,descriptionReason,subtypeReason] of cases){
      for(const token of ['private-refresh+&=%ü',' private-refresh','private-refresh\r\n']){
        process.env.CMPRI_GMAIL_REFRESH_TOKEN=token;
        let calls=0;
        globalThis.fetch=async(url,init)=>{
          calls++;
          assert.equal(new URLSearchParams(init.body).get('refresh_token'),token);
          process.env.CMPRI_GMAIL_REFRESH_TOKEN='private-later-token';
          return Response.json({error:'invalid_grant',error_description:description,error_subtype:subtype,extra:'private-secret'},{status:400});
        };
        await assert.rejects(fetchOperationalMessages(),error=>{
          const shape=JSON.parse(error.message.split(' Response shape: ')[1].slice(0,-1));
          assert.equal(shape.grantDescriptionReason,descriptionReason);
          assert.equal(shape.grantSubtypeReason,subtypeReason);
          assert.equal(shape.refreshTokenHasEdgeWhitespace,token!==token.trim());
          assert.equal(shape.requestRefreshTokenMatchesRuntime,true);
          assert.doesNotMatch(error.stack,/private-|<script>|Token has been|Bad Request|invalid_rapt/);
          assert.equal(error.cause,undefined);
          return true;
        });
        assert.equal(calls,1);
      }
    }
  } finally {
    globalThis.fetch=originalFetch;
    for(const k of Object.keys(fixture))if(backup[k]===undefined)delete process.env[k];else process.env[k]=backup[k];
  }
});

test('client authentication diagnostics preserve request contract and suppress arbitrary provider text',async()=>{
  const expected='880987317943-b4fqinbu5l4ugp6nh6ngalq392r0n6ov.apps.googleusercontent.com';
  const fixture={CMPRI_EMAIL_PROVIDER:'gmail',CMPRI_GMAIL_CLIENT_ID:expected,CMPRI_GMAIL_CLIENT_SECRET:'private-secret',CMPRI_GMAIL_REFRESH_TOKEN:'private-token',CMPRI_GMAIL_ADDRESS:'private@example.invalid'};
  const backup=Object.fromEntries(Object.keys(fixture).map(k=>[k,process.env[k]]));
  const originalFetch=globalThis.fetch;
  const originalSerialize=URLSearchParams.prototype.toString;
  const cases=[['Unauthorized','unauthorized_unspecified'],['The OAuth client was not found.','oauth_client_not_found'],...['Unauthorized private-secret','The OAuth client was not found. private-token',' Unauthorized','unauthorized','<script>private-secret</script>',null,{},[],42,'constructor','__proto__'].map(x=>[x,'unknown'])];
  try {
    Object.assign(process.env,fixture);
    for(const [description,reason] of cases)for(const secret of ['private-secret+&=%ü',' private-secret','private-secret\r\n'])for(const mutation of ['none','different','duplicate','missing']){
      process.env.CMPRI_GMAIL_CLIENT_SECRET=secret;
      URLSearchParams.prototype.toString=function(){
        const form=new URLSearchParams(originalSerialize.call(this));
        if(mutation==='different')form.set('client_secret','private-altered');
        if(mutation==='duplicate')form.append('client_secret',secret);
        if(mutation==='missing')form.delete('client_secret');
        return originalSerialize.call(form);
      };
      let calls=0;
      globalThis.fetch=async(url,init)=>{
        calls++;
        assert.equal(url,'https://oauth2.googleapis.com/token');
        assert.equal(init.method,'POST');
        assert.equal(init.headers['content-type'],'application/x-www-form-urlencoded');
        const form=new URLSearchParams(await new Request(url,init).text());
        assert.equal(form.get('client_id'),expected);
        assert.equal(form.get('grant_type'),'refresh_token');
        assert.equal(form.get('refresh_token'),fixture.CMPRI_GMAIL_REFRESH_TOKEN);
        if(mutation==='none')assert.deepEqual(form.getAll('client_secret'),[secret]);
        process.env.CMPRI_GMAIL_CLIENT_SECRET='private-later';
        return Response.json({error:'invalid_client',error_description:description,error_subtype:'private-subtype'},{status:401});
      };
      await assert.rejects(fetchOperationalMessages(),error=>{
        const shape=JSON.parse(error.message.split(' Response shape: ')[1].slice(0,-1));
        assert.equal(shape.clientDescriptionReason,reason);
        assert.equal(shape.clientSecretHasEdgeWhitespace,secret!==secret.trim());
        assert.equal(shape.requestClientSecretMatchesRuntime,mutation==='none');
        assert.equal('runtimeClientIdMatchesExpected' in shape,false);
        assert.equal(shape.requestClientIdMatchesRuntime,true);
        assert.doesNotMatch(error.stack,/private-|<script>|880987317943|Unauthorized|OAuth client was/);
        assert.equal(error.cause,undefined);
        return true;
      });
      assert.equal(calls,1);
    }
  }finally{
    URLSearchParams.prototype.toString=originalSerialize;
    globalThis.fetch=originalFetch;
    for(const k of Object.keys(fixture))if(backup[k]===undefined)delete process.env[k];else process.env[k]=backup[k];
  }
});


test('checksum comparison shares fetch boundary, detects source and serialization changes, and discloses booleans only',async()=>{
 const fixture={CMPRI_GMAIL_CLIENT_ID:'synthetic-id',CMPRI_GMAIL_CLIENT_SECRET:'synthetic-secret+&=%',CMPRI_GMAIL_REFRESH_TOKEN:'synthetic-token+&=%',CMPRI_GMAIL_ADDRESS:'synthetic@example.invalid'};
 const backup=Object.fromEntries(Object.keys(fixture).map(k=>[k,process.env[k]]));
 const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
 const refs={clientSecretSha256:digest(fixture.CMPRI_GMAIL_CLIENT_SECRET),refreshTokenSha256:digest(fixture.CMPRI_GMAIL_REFRESH_TOKEN)};
 const fetch=globalThis.fetch, serialize=URLSearchParams.prototype.toString;
 const logs=[];const methods=['log','warn','error'];const originals=methods.map(k=>console[k]);
 try{
  Object.assign(process.env,fixture);
  globalThis.fetch=()=>{throw new Error('No fetch permitted');};
  methods.forEach(k=>console[k]=(...args)=>logs.push(args));
  const exact={sourceClientSecretMatchesReference:true,outgoingClientSecretMatchesReference:true,sourceRefreshTokenMatchesReference:true,outgoingRefreshTokenMatchesReference:true};
  assert.deepEqual(await compareGmailCredentialDigests(refs),exact);
  process.env.CMPRI_GMAIL_REFRESH_TOKEN+='x';
  assert.deepEqual(await compareGmailCredentialDigests(refs),{...exact,sourceRefreshTokenMatchesReference:false,outgoingRefreshTokenMatchesReference:false});
  Object.assign(process.env,fixture);
  process.env.CMPRI_GMAIL_CLIENT_SECRET+='x';
  assert.deepEqual(await compareGmailCredentialDigests(refs),{...exact,sourceClientSecretMatchesReference:false,outgoingClientSecretMatchesReference:false});
  Object.assign(process.env,fixture);
  URLSearchParams.prototype.toString=function(){const form=new URLSearchParams(serialize.call(this));form.set('client_secret','synthetic-changed');form.set('refresh_token','synthetic-changed');return serialize.call(form);};
  assert.deepEqual(await compareGmailCredentialDigests(refs),{...exact,outgoingClientSecretMatchesReference:false,outgoingRefreshTokenMatchesReference:false});
  await assert.rejects(compareGmailCredentialDigests({clientSecretSha256:'secret-invalid',refreshTokenSha256:refs.refreshTokenSha256}),{message:'Invalid comparison references.'});
  assert.deepEqual(logs,[]);
 }finally{
  globalThis.fetch=fetch;URLSearchParams.prototype.toString=serialize;
  methods.forEach((k,i)=>console[k]=originals[i]);
  for(const k of Object.keys(fixture))if(backup[k]===undefined)delete process.env[k];else process.env[k]=backup[k];
 }
});


test('Gmail unauthorized_client descriptions are exact allowlisted labels without cause inference or disclosure',async()=>{
 const fixture={CMPRI_EMAIL_PROVIDER:'gmail',CMPRI_GMAIL_CLIENT_ID:'private-id',CMPRI_GMAIL_CLIENT_SECRET:'private-secret',CMPRI_GMAIL_REFRESH_TOKEN:'private-refresh',CMPRI_GMAIL_ADDRESS:'private@example.invalid'};
 const backup=Object.fromEntries(Object.keys(fixture).map(k=>[k,process.env[k]]));const originalFetch=globalThis.fetch;
 const recognized=[['Unauthorized','unauthorized_unspecified'],['Bad Request','bad_request_unspecified'],['Unauthorized client or scope in request.','client_or_scope_unspecified'],['The OAuth client was not found.','oauth_client_not_found']];
 const cases=[...recognized,...recognized.flatMap(([text])=>[[text+' private-secret','unknown'],[' '+text,'unknown'],[text.toLowerCase(),'unknown']]),...[undefined,null,42,{},[],true,'private-refresh','a'.repeat(64),'<script>private-secret</script>'].map(v=>[v,'unknown'])];
 try{
  Object.assign(process.env,fixture);
  for(const [description,expected] of cases){
   let calls=0;
   globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(init.body).get('grant_type'),'refresh_token');return Response.json({error:'unauthorized_client',error_description:description,error_subtype:'private-refresh'},{status:401});};
   await assert.rejects(fetchOperationalMessages(),error=>{
    const shape=JSON.parse(error.message.split(' Response shape: ')[1].slice(0,-1));
    assert.equal(shape.unauthorizedClientDescriptionReason,expected);
    assert.equal(shape.requestClientIdMatchesRuntime,true);
    assert.doesNotMatch(error.stack,/private-|private@|<script>|aaaaaa/);
    assert.equal(error.cause,undefined);return true;
   });assert.equal(calls,1);
  }
 }finally{globalThis.fetch=originalFetch;for(const k of Object.keys(fixture))if(backup[k]===undefined)delete process.env[k];else process.env[k]=backup[k];}
});
