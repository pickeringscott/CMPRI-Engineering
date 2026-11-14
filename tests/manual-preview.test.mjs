import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';

function fixture(env) {
  const globals={process:{env},Request,Response,URL};
  const guard=loadTs('src/lib/server/manual-preview.ts',{},globals);
  const proxy=loadTs('src/proxy.ts',{'./lib/server/manual-preview':guard,'next/server':{NextResponse:{next:()=>new Response(null,{headers:{'X-Test-Next':'1'}}),json:Response.json}}},globals).proxy;
  return {...guard,proxy};
}

for(const VERCEL_ENV of ['production','preview','development',undefined]) {
  test(`${VERCEL_ENV??'local'} uses normal authenticated routes unless read-only was explicitly requested`,()=>{
    const {manualPreviewReadOnly,proxy}=fixture({VERCEL_ENV});
    assert.equal(manualPreviewReadOnly(),false);
    for(const [path,method] of [['/api/notes','PUT'],['/api/winter-preparedness','PATCH'],['/api/integrations/status','GET']]) {
      const response=proxy({method,nextUrl:new URL('https://app.example'+path)});
      assert.equal(response.headers.get('X-Test-Next'),'1');
      assert.equal(response.headers.get('X-CMPRI-Preview'),null);
    }
  });
}

test('explicit read-only review still blocks route mutations and GET side effects in any environment',()=>{
  for(const VERCEL_ENV of ['production','preview',undefined]) {
    const {manualPreviewReadOnly,proxy}=fixture({VERCEL_ENV,CMPRI_MANUAL_PREVIEW_READ_ONLY:'1'});
    assert.equal(manualPreviewReadOnly(),true);
    for(const [path,method] of [['/api/notes','PUT'],['/api/winter-preparedness','PATCH'],['/api/integrations/status','GET'],['/api/notifications/dispatch','GET'],['/api/assets/documentation/ocr/dispatch','GET']]) {
      assert.equal(proxy({method,nextUrl:new URL('https://app.example'+path)}).status,403);
    }
    const read=proxy({method:'GET',nextUrl:new URL('https://app.example/api/notes')});
    assert.equal(read.headers.get('X-Test-Next'),'1');
    assert.equal(read.headers.get('X-CMPRI-Preview'),'read-only');
  }
});

test('explicit read-only review retains a second guard against database/storage writes',async()=>{
  const {manualPreviewFetch}=fixture({CMPRI_MANUAL_PREVIEW_READ_ONLY:'1'});
  const calls=[];
  const fetch=manualPreviewFetch(async request=>{calls.push(request.url);return new Response('ok')});
  for(const [path,method] of [['/rest/v1/cmpri_general_notes','POST'],['/rest/v1/rpc/cmpri_save_general_note','POST'],['/storage/v1/object/bucket/file','PUT']]) {
    assert.equal((await fetch('https://db.example'+path,{method})).status,403);
  }
  assert.equal(calls.length,0);
  for(const [path,method] of [['/rest/v1/cmpri_general_notes','GET'],['/rest/v1/rpc/cmpri_inventory_snapshot','POST'],['/storage/v1/object/sign/bucket/file','POST']]) {
    assert.equal((await fetch('https://db.example'+path,{method})).status,200);
  }
  assert.equal(calls.length,3);
});
