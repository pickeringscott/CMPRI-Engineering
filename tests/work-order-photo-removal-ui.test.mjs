import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'removeSavedPhoto') handler = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handler);
async function run(options = {}) {
  const state = { requests: [], confirmations: 0, preview: 'original', error: '', message: '', reloads: 0 };
  const ctx = {
    id: 'ticket-123', photoUploading: false, removingPhotoId: null, ...options,
    window: { confirm() { state.confirmations++; return options.confirm !== false; } },
    setRemovingPhotoId: value => { state.removing = value; },
    setPhotoUploadError: value => { state.error = value; },
    setPhotoUploadMessage: value => { state.message = value; },
    setImagePreview: value => { state.preview = value; },
    getValidSession: async () => options.expired ? null : { access_token: 'test-token' },
    loadWorkOrderImages: async () => { state.reloads++; return options.readback !== false; },
    fetch: async (url, init) => {
      state.requests.push({ url, init });
      if (options.networkError) throw new Error('Network failed');
      return { ok: options.success !== false, json: async () => options.success === false ? { error: 'Denied' } : { ok: true } };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  await ctx.removeSavedPhoto({ id: 'specific-photo.png', can_remove: options.owned !== false });
  return state;
}
test('cancel or disabled ownership/busy state sends no deletion request', async () => {
  for (const options of [{confirm:false},{owned:false},{photoUploading:true},{removingPhotoId:'other'}]) {
    const state = await run(options); assert.equal(state.requests.length, 0); assert.equal(state.preview, 'original');
  }
});
test('confirmed removal sends the selected photo only and refreshes saved photos', async () => {
  const state = await run(); assert.equal(state.confirmations, 1); assert.equal(state.requests.length, 1);
  const { url, init } = state.requests[0]; assert.equal(url, '/api/work-orders/ticket-123/attachments');
  assert.equal(init.method, 'DELETE'); assert.equal(init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(init.body), { photoId: 'specific-photo.png' });
  assert.equal(state.preview, null); assert.equal(state.reloads, 1); assert.equal(state.message, 'Photo removed.');
});
test('failed/uncertain removal keeps the selected photo visible and reports an error', async () => {
  for (const options of [{success:false},{networkError:true},{expired:true}]) {
    const state = await run(options); assert.equal(state.preview, 'original'); assert.ok(state.error); assert.equal(state.message, ''); assert.equal(state.removing, null);
  }
});
test('successful delete with failed list refresh does not claim verified list removal', async () => {
  assert.match((await run({readback:false})).message, /could not be refreshed/);
});
test('remove control is attached to the selected full-size image and guarded by server capability', () => {
  assert.match(source, /imagePreview\.can_remove && <button[\s\S]*?removeSavedPhoto\(imagePreview\)/);
  assert.match(source, /Open a photo to view it or remove it/);
});

test('gallery and camera selection stage locally instead of uploading; saving is explicit',()=>{
 assert.equal((source.match(/if \(photo\) stageWorkOrderPhoto\(photo\);/g)||[]).length,2);
 assert.doesNotMatch(source,/if \(photo\) void uploadWorkOrderPhoto/);
 assert.match(source,/uploadWorkOrderPhoto\(stagedPhoto.file, stagedPhoto.uploadId\)/);
 assert.match(source,/onClick=\{removeStagedPhoto\}/);
 assert.match(source,/only the engineer can delete the photo/);
});
test('discarding staged selection performs no network/storage deletion, and is blocked while saving',()=>{
 let selected;function find(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='removeStagedPhoto')selected=node.getText(ast);ts.forEachChild(node,find);}find(ast);
 for(const uploading of [false,true]){let cleared=false;const ctx={photoUploading:uploading,setStagedPhoto:value=>{assert.equal(value,null);cleared=true;}};vm.createContext(ctx);vm.runInContext(ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);ctx.removeStagedPhoto();assert.equal(cleared,!uploading);}
});

test('new-ticket submitter can discard a selection before save, but cannot use that local control after save starts',()=>{
 const createSource=readFileSync(new URL('../src/app/work-orders/page.tsx',import.meta.url),'utf8');const tree=ts.createSourceFile('create.tsx',createSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let handler;
 function find(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='removeSelectedPhoto')handler=n.getText(tree);ts.forEachChild(n,find);}find(tree);assert.ok(handler);
 for(const locked of [false,true]){let selected=[{uploadId:'photo-1',previewUrl:'blob:test'}];const revoked=[];const ctx={loading:false,createState:'idle',mainWorkOrderCreated:locked,retryingPhotoUpload:false,pendingPhotoUploads:[],photos:selected,URL:{revokeObjectURL:url=>revoked.push(url)},photoPreviewUrlsRef:{current:new Set(['blob:test'])},setPhotos:update=>{selected=update(selected);}};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);ctx.removeSelectedPhoto('photo-1');assert.equal(selected.length,locked?1:0);assert.equal(revoked.length,locked?0:1);
 }
});
