import test from "node:test";
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
        assert.equal(error.message,scenario.expected);
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
