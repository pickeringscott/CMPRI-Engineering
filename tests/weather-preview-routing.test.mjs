import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';

function fixture(env) {
  const globals={process:{env},Request,Response,URL};
  const guard=loadTs('src/lib/server/manual-preview.ts',{},globals);
  return loadTs('src/proxy.ts',{
    './lib/server/manual-preview':guard,
    'next/server':{NextResponse:{next:()=>new Response(null,{headers:{'X-Test-Next':'1'}}),json:Response.json}},
  },globals);
}

const previewPaths=['/previews','/previews/','/previews/cmpri-weather-preview.html','/previews/nested/review.html'];
const request=(path,method='GET')=>({method,nextUrl:new URL('https://branch.example'+path)});

test('the preview namespace is gated alongside the existing API matcher',()=>{
  assert.deepEqual(Array.from(fixture({}).config.matcher),['/api/:path*','/previews/:path*']);
});

test('production blocks every preview path and method even when read-only mode is disabled',async()=>{
  for(const readOnly of [undefined,'0','1']) {
    const {proxy}=fixture({VERCEL_ENV:'production',CMPRI_MANUAL_PREVIEW_READ_ONLY:readOnly});
    for(const path of previewPaths) for(const method of ['GET','HEAD','OPTIONS','POST']) {
      const response=proxy(request(path,method));
      assert.equal(response.status,404,`${method} ${path}`);
      assert.equal(response.headers.get('X-Test-Next'),null);
      assert.equal(response.headers.get('Cache-Control'),'no-store');
      assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
      assert.equal(await response.text(),'Not found.');
    }
  }
});

for(const VERCEL_ENV of ['preview','development',undefined]) {
  test(`${VERCEL_ENV??'local'} serves static reviews without caching or indexing`,()=>{
    for(const readOnly of [undefined,'1']) {
      const {proxy}=fixture({VERCEL_ENV,CMPRI_MANUAL_PREVIEW_READ_ONLY:readOnly});
      for(const path of previewPaths) {
        const response=proxy(request(path));
        assert.equal(response.headers.get('X-Test-Next'),'1',path);
        assert.equal(response.headers.get('Cache-Control'),'no-store');
        assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
        assert.equal(response.headers.get('X-CMPRI-Preview'),null);
      }
    }
  });
}

test('the production review gate leaves API behavior and unrelated routes unchanged',()=>{
  for(const VERCEL_ENV of ['production','preview',undefined]) {
    const {proxy}=fixture({VERCEL_ENV});
    for(const path of ['/api/notes','/api/notifications/dispatch','/engineering','/previews-other/review.html']) {
      const response=proxy(request(path,'POST'));
      assert.equal(response.headers.get('X-Test-Next'),'1',path);
      assert.equal(response.headers.get('Cache-Control'),null);
      assert.equal(response.headers.get('X-Robots-Tag'),null);
    }
    const readOnly=fixture({VERCEL_ENV,CMPRI_MANUAL_PREVIEW_READ_ONLY:'1'}).proxy;
    assert.equal(readOnly(request('/api/notes','PUT')).status,403);
    assert.equal(readOnly(request('/api/notifications/dispatch')).status,403);
    const read=readOnly(request('/api/notes'));
    assert.equal(read.headers.get('X-Test-Next'),'1');
    assert.equal(read.headers.get('X-CMPRI-Preview'),'read-only');
  }
});
