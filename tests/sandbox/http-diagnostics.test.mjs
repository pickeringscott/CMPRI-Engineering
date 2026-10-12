import test from 'node:test';
import assert from 'node:assert/strict';
import {redact,describeResponse} from './http-diagnostics.mjs';
test('HTML diagnostics retain route/status/exception but never raw payload or query tokens',()=>{
 const secret='fixture-secret-value';
 const body='<html>Guest private note MUST NOT LEAK<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({err:{name:'Error',message:'Blocked '+secret+' user@example.invalid',stack:'Error: '+secret+'\n    at GET (/app/route.ts:12:3)\nsecret source text'}})+'</script></html>';
 const d=describeResponse({path:'/api/work-orders/drafts?token=hidden',method:'POST',status:500,contentType:'text/html',body},[secret]);
 assert.equal(d.route,'/api/work-orders/drafts');assert.equal(d.status,500);assert.equal(d.serverException.name,'Error');assert.equal(d.serverException.stack.length,2);
 for(const sensitive of [secret,'private note','hidden','user@example.invalid','secret source text'])assert.ok(!JSON.stringify(d).includes(sensitive));
 assert.equal(d.bodySha256.length,64);
});
test('unstructured HTML records only metadata/hash, never content',()=>{
 const d=describeResponse({path:'/api/test',method:'GET',status:503,contentType:'text/html',body:'<h1>password=private</h1>'});
 assert.equal(d.serverException,undefined);assert.ok(!JSON.stringify(d).includes('private'));
});
test('redacts synthetic credentials, JWTs, bearer credentials and email addresses',()=>{
 const s=redact('secret-value Bearer opaque-token eyJabc.def.ghi sb_secret_sensitive test@example.invalid ?access_token=abc',['secret-value']);
 for(const value of ['secret-value','opaque-token','eyJabc.def.ghi','sb_secret_sensitive','test@example.invalid','=abc'])assert.ok(!s.includes(value));
});
