import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const owner='750f77bf-7d5d-4ca6-8421-e025edea87ba';
function load(file,deps){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Response,URL,TextEncoder,crypto:webcrypto,require:n=>{if(n in deps)return deps[n];throw Error('Unexpected dependency '+n);}});return exports;}
function fixture({active=true,member=true,canWrite=true,subject=owner}={}){
 const reads=[];
 const admin={auth:{admin:{getUserById:async()=>({data:{user:{id:subject,email:'synthetic@example.invalid'}},error:null})}},from(table){reads.push(table);const q={select(){return q;},eq(){return q;},is(){return q;},gt(){return q;},async maybeSingle(){return {error:null,data:table==='cmpri_mcp_oauth_tokens'?{user_id:subject,scope:canWrite?'cmpri:read cmpri:write':'cmpri:read',resource:'https://www.cmpri-engineering.com/api/mcp'}:table==='cmpri_personal_mcp_links'?null:table==='profiles'?{id:subject,email:'synthetic@example.invalid',role:'system_admin',active,secondary_roles:['engineer']}:table==='hotel_members'?{user_id:subject,hotel_id:'hotel',role:'admin',active:member}:null};}};return q;}};
 const auth=load('lib/server/cmpri-mcp-auth.ts',{'server-only':{},'@/lib/server/supabase-admin':{createSupabaseAdmin:()=>admin},'@/lib/server/access':{resolvePrincipal:(identity,hotelId,profile,membership,permissions)=>({identity,hotelId,profile,membership,permissions}),allows:()=>true},'@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/server/roles':{roleKey:r=>r,canReadEquipment:()=>true},'@/lib/ai/assistant-policy':{assistantPolicy:()=>({})},'@/lib/server/cmpri-mcp-oauth-scope':{CMPRI_MCP_RESOURCE:'https://www.cmpri-engineering.com/api/mcp',CMPRI_MCP_WRITE_SCOPE:'cmpri:read cmpri:write',validMcpScope:s=>['cmpri:read','cmpri:read cmpri:write'].includes(s)}});
 const route=load('app/api/mcp/route.ts',{'@/lib/work-order-read-policy':{},'@/lib/server/work-order-reader':{},'next/server':{},'@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/server/cmpri-mcp':auth,'@/lib/server/cmpri-mcp-oauth-scope':{CMPRI_MCP_RESOURCE:'https://www.cmpri-engineering.com/api/mcp'},'@/lib/server/cmpri-mcp-reads':{availableMcpReadViews:()=>[]},'@/lib/server/cmpri-mcp-writes':{availableMcpWriteActions:()=>[]},'@/lib/server/room-operations-import-schema':{},'@/lib/ai/mcp-work-order-location':{}});
 const call=(args={},authorization='Bearer synthetic-test-only',method='tools/call')=>route.POST({headers:{get:n=>n==='authorization'?authorization:null},json:async()=>({jsonrpc:'2.0',id:1,method,params:{name:'get_connection_identity',arguments:args}})});
 return {call,reads};
}
test('self identity uses the real authenticated principal and returns only subject and existing write scope',async()=>{
 for(const canWrite of [false,true]){const f=fixture({canWrite});const r=await f.call();assert.equal(r.status,200);const body=await r.json();assert.deepEqual(body.result.structuredContent,{subject_id:owner,can_write:canWrite});assert.equal(r.headers.get('Cache-Control'),'no-store');assert.ok(f.reads.every(t=>['cmpri_mcp_oauth_tokens','cmpri_personal_mcp_links','profiles','hotel_members'].includes(t)));}
 const other='00000000-0000-0000-0000-000000000002';assert.equal((await (await fixture({subject:other}).call()).json()).result.structuredContent.subject_id,other);
});
test('missing credentials and inactive profile/membership cannot obtain self identity',async()=>{
 const f=fixture();assert.equal((await f.call({},null)).status,401);assert.equal(f.reads.length,0);
 for(const options of [{active:false},{member:false}])assert.equal((await fixture(options).call()).status,401);
});
test('caller-selected identities, extra keys and malformed arguments fail without writes',async()=>{
 for(const args of [{subject_id:owner},{owner_id:owner},{token:'synthetic'},[],null,'bad']){const f=fixture();const r=await (await f.call(args)).json();assert.equal(r.result.isError,true);assert.match(r.result.structuredContent.error,/empty arguments/);}
});
test('authenticated discovery exposes a strict read-only schema even for read-only connections',async()=>{
 const r=await (await fixture({canWrite:false}).call({},undefined,'tools/list')).json();const t=r.result.tools.find(t=>t.name==='get_connection_identity');assert.ok(t);assert.deepEqual(t.inputSchema.properties,{});assert.equal(t.inputSchema.additionalProperties,false);assert.equal(t.annotations.readOnlyHint,true);assert.deepEqual(t.outputSchema.required,['subject_id','can_write']);assert.equal(t.outputSchema.additionalProperties,false);
});
