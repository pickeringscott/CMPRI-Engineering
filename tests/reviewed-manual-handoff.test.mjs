import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual page's callback in isolation; no duplicate implementation.
const source = ts.createSourceFile('equipment.tsx', readFileSync('src/app/management/equipment/page.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'useReviewedGuide') callback = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
function harness(response, token = async () => 'token', invalidate = async () => {}) {
  const calls = [];
  const context = vm.createContext({ Error, selectedId: 'asset-1', canManage: true, editing: true, token,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: response.ok ?? true, json: async () => response }; },
    invalidateCachedResources: async topics => { calls.push({ topics }); await invalidate(); },
  });
  vm.runInContext(ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { save: context.useReviewedGuide, calls };
}
const input = { fileName: 'manual.pdf', sha256: 'a'.repeat(64), totalPages: 12, pages: [{ page: 1, text: '<script>plain reviewed text</script>' }] };
test('equipment sends only reviewed JSON and refreshes guide resources after verified success', async () => {
  const { save, calls } = harness({ saved: true, pages: [1], message: 'Saved.' });
  const signal = new AbortController().signal;
  assert.equal(await save(input, signal), 'Saved.');
  assert.equal(calls[0].url, '/api/assets/documentation/reviewed-text');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { assetId: 'asset-1', sha256: input.sha256, totalPages: 12, pages: input.pages, reviewConfirmed: true });
  assert.deepEqual(Array.from(calls[1].topics), ['reference', 'orders']);
});
test('equipment rejects HTTP errors, unconfirmed saves and mismatched page receipts', async () => {
  for (const response of [{ ok: false, error: 'Attach the same PDF.' }, {}, { saved: true, pages: [2] }, { saved: true, pages: [1, 2] }]) {
    const { save, calls } = harness(response);
    await assert.rejects(save(input, new AbortController().signal));
    assert.equal(calls.length, 1);
  }
});
test('aborting while obtaining auth prevents the request', async () => {
  const controller = new AbortController();
  const { save, calls } = harness({}, async () => { controller.abort(); return 'token'; });
  await assert.rejects(save(input, controller.signal));
  assert.equal(calls.length, 0);
});

 test('confirmed save remains reported as saved when refreshing open guides fails', async () => {
  const { save } = harness({ saved: true, pages: [1], message: 'Saved.' }, async () => 'token', async () => { throw new Error('cache unavailable'); });
  assert.match(await save(input, new AbortController().signal), /pages were saved.*Reload/);
 });

test('one reviewed-document action saves consecutive internal batches without dropping source pages',async()=>{
 const calls=[];
 const pages=Array.from({length:23},(_,i)=>({page:i+1,text:input.pages[0].text}));
 let count=0;
 const context=vm.createContext({Error,selectedId:'asset-1',canManage:true,editing:true,token:async()=>'token',fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,options});assert.ok(body.pages.length<=10);count+=body.pages.length;
  return {ok:true,json:async()=>({saved:true,pages:body.pages.map(p=>p.page)})};
 },invalidateCachedResources:async()=>{}});
 vm.runInContext(ts.transpileModule(callback,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 const progress=[];
 const result=await context.useReviewedGuide({...input,totalPages:23,pages},new AbortController().signal,message=>progress.push(message));
 assert.equal(count,23);assert.equal(calls.length,3);assert.equal(progress.length,3);assert.match(result,/23 reviewed pages saved/);
 assert.deepEqual(calls.flatMap(call=>JSON.parse(call.options.body).pages.map(page=>page.page)),Array.from({length:23},(_,i)=>i+1));
});
