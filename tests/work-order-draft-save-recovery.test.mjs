import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { guardedDraftRequest, mergeConfirmedOwnDraft, saveDraftWithRecovery } from '../src/lib/work-orders/draft-save.ts';

const fields = {staff_first_name:'',location_id:'room',issue:'Sink leaks',notes:'Original',asset_id:null,asset_name:'',category:'Plumbing',priority:'Medium'};
const response = (body, status = 200) => new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json'}});

test('confirmed rows update the own-draft list without losing metadata or including another owner',()=>{
  const original=Array.from({length:100},(_,i)=>({id:`draft-${i}`,created_by:'actor',creator_name:'Owner',can_edit:true,can_delete:true,issue:`old-${i}`}));
  const inserted=mergeConfirmedOwnDraft(original,{id:'new',created_by:'actor',issue:'New issue'},'actor','Owner');
  assert.equal(inserted.length,100);assert.equal(inserted[0].id,'new');assert.equal(inserted[0].can_delete,true);assert.equal(inserted.some(d=>d.id==='draft-99'),false);
  const updated=mergeConfirmedOwnDraft(original,{id:'draft-1',created_by:'actor',issue:'Updated'},'actor','Owner');
  assert.equal(updated[0].issue,'Updated');assert.equal(updated[0].creator_name,'Owner');assert.equal(updated[0].can_delete,true);assert.equal(updated.filter(d=>d.id==='draft-1').length,1);
  assert.equal(mergeConfirmedOwnDraft(original,{id:'reviewed',created_by:'other',issue:'Private'},'actor','Owner'),original);
});

test('ordinary saves use one request; an initial conflict does not trigger reconciliation',async()=>{
  const pending={current:null};let sends=0,reads=0;
  const options={fields,active:{id:'draft',revision:3},pending,newId:()=>{throw Error('unexpected')},confirmed:()=>{},read:async()=>{reads++;return null},
    send:async()=>{sends++;return response({draft:{...fields,id:'draft',revision:4}})}};
  assert.equal((await saveDraftWithRecovery(options)).revision,4);assert.equal(sends,1);assert.equal(reads,0);
  await assert.rejects(saveDraftWithRecovery({...options,send:async()=>{sends++;return response({error:'conflict'},409)}}),/copy it.*compare/);
  assert.equal(sends,2);assert.equal(reads,0);
});

test('confirmed deletion uses one request, removes only its row, and preserves rows on failure',async()=>{
  const source=readFileSync(new URL('../src/app/work-orders/page.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let declaration;
  function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='removeSavedDraft')declaration=node.getText(ast);ts.forEachChild(node,visit)}visit(ast);
  assert.ok(declaration);
  const code=ts.transpileModule(`${declaration}\nexports.run = removeSavedDraft;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  let rows=[{id:'one'},{id:'two'}],review={id:'one'},calls=0,status=200;
  const exports={},requestRef={current:2};
  const context={exports,cmpriSession:{hotelId:'hotel',user:{id:'actor'}},draftIdentityGeneration:{current:1},draftIdentityScope:{current:'hotel:actor'},draftRequestRef:requestRef,
    getValidSession:async()=>({access_token:'token',user:{id:'actor'}}),guardedDraftRequest,fetch:async(_url,options)=>{calls++;assert.equal(options.method,'DELETE');return response(status===200?{ok:true}:{error:'Denied'},status)},
    setDrafts:updater=>{rows=updater(rows)},setReviewDraft:updater=>{review=updater(review)}};
  vm.runInNewContext(code,context);await exports.run('one');
  assert.equal(calls,1);assert.deepEqual(rows,[{id:'two'}]);assert.equal(review,null);assert.equal(requestRef.current,3);
  status=403;await assert.rejects(exports.run('two'),/Denied/);assert.equal(calls,2);assert.deepEqual(rows,[{id:'two'}]);assert.equal(requestRef.current,3);
});

test('lost creation response replays the original request and then saves newer edits', async () => {
  const pending={current:null}, attempts=[], confirmed=[];
  let remote=null, first=true;
  const options={fields,active:null,pending,newId:()=> 'stable-id',confirmed:d=>confirmed.push(d),read:async()=>remote,
    send:async (method, body)=>{
      attempts.push({method,body:structuredClone(body)});
      if(method==='POST') {
        if(!remote) remote={...body,id:body.creation_id,revision:1};
        else assert.deepEqual(body,attempts[0].body);
        if(first){first=false;throw new Error('response lost');}
        return response({draft:remote});
      }
      remote={...body,id:body.id,revision:2}; return response({draft:remote});
    }};
  await assert.rejects(saveDraftWithRecovery(options),/could not be confirmed/);
  assert.equal(pending.current.id,'stable-id');
  const saved=await saveDraftWithRecovery({...options,fields:{...fields,notes:'Newer edit'}});
  assert.equal(attempts.length,3);
  assert.equal(attempts[1].body.notes,'Original');
  assert.equal(attempts[2].body.notes,'Newer edit');
  assert.equal(saved.revision,2);
  assert.equal(pending.current,null);
  assert.deepEqual(confirmed.map(d=>d.revision),[1,2]);
});

test('lost update response reconciles only an exact next revision and matching fields',async()=>{
  const pending={current:null};let remote={...fields,id:'draft',revision:4};let first=true;
  const options={fields,active:{id:'draft',revision:3},pending,newId:()=>{throw Error('unexpected');},confirmed:()=>{},read:async()=>remote,
    send:async()=>{if(first){first=false;throw Error('lost');}return response({error:'conflict'},409);}};
  await assert.rejects(saveDraftWithRecovery(options),/could not be confirmed/);
  assert.equal((await saveDraftWithRecovery(options)).revision,4);
  assert.equal(pending.current,null);
  pending.current={method:'PATCH',id:'draft',revision:3,fields};
  remote={...remote,notes:'A different change'};
  await assert.rejects(saveDraftWithRecovery(options),/copy it.*compare/);
  assert.equal(pending.current,null,'a real conflict must not trap the editor in a retry loop');
});

test('rejected input is not retried as an uncertain creation',async()=>{
  const pending={current:null};
  const options={fields,active:null,pending,newId:()=> 'id',confirmed:()=>{},read:async()=>null,send:async()=>response({error:'Invalid notes.'},400)};
  await assert.rejects(saveDraftWithRecovery(options),/Invalid notes/);
  assert.equal(pending.current,null);
});

test('an uncertain creation is not forgotten when a later retry is rejected',async()=>{
  const pending={current:null};let first=true;
  const options={fields,active:null,pending,newId:()=> 'id',confirmed:()=>{},read:async()=>null,
    send:async()=>{if(first){first=false;throw Error('lost');}return response({error:'Location is inactive'},400);}};
  await assert.rejects(saveDraftWithRecovery(options),/could not be confirmed/);
  await assert.rejects(saveDraftWithRecovery(options),/still unconfirmed/);
  assert.equal(pending.current.id,'id');
});

test('a response from an old session is not applied after the account changes',async()=>{
  let current='account-a', generation=1, applied=false;
  const savedGeneration=generation;
  const check=async()=>{if(current!=='account-a'||generation!==savedGeneration)throw Error('Account changed');return 'token';};
  await assert.rejects(guardedDraftRequest(check,async()=>{current='account-b';generation++;current='account-a';generation++;return response({ok:true});}).then(()=>{applied=true;}),/Account changed/);
  assert.equal(applied,false);
});

test('old response parsing cannot clear a newer account pending save',async()=>{
  const old={method:'POST',id:'old',fields}, newer={method:'POST',id:'new',fields};
  const pending={current:old};let current=true;
  const options={fields,active:null,pending,newId:()=> 'unused',confirmed:()=>assert.fail('old response applied'),isCurrent:()=>current,read:async()=>null,
    send:async()=>({ok:true,status:200,json:async()=>{current=false;pending.current=newer;return {draft:{...fields,id:'old',revision:1}};}})};
  await assert.rejects(saveDraftWithRecovery(options),/Account changed/);
  assert.equal(pending.current,newer);
});

test('an uncertain update stays retryable if conflict verification is unavailable',async()=>{
  const pending={current:{method:'PATCH',id:'draft',revision:3,fields,uncertain:true}};
  const options={fields,active:{id:'draft',revision:3},pending,newId:()=> 'unused',confirmed:()=>{},read:async()=>{throw Error('offline');},send:async()=>response({error:'conflict'},409)};
  await assert.rejects(saveDraftWithRecovery(options),/still unconfirmed/);
  assert.equal(pending.current.id,'draft');
});
