import test from "node:test";
import assert from "node:assert/strict";
import { configuredEmailProvider, gmailText, htmlToText, messageDirection, fetchOperationalMessages } from "../src/lib/integrations/email-provider.ts";

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
